package com.deepdocai.llm.rag;

import com.deepdocai.llm.client.GeminiClient;
import com.deepdocai.llm.key.ApiKeyManager;
import com.deepdocai.llm.key.ApiKeySlot;
import com.deepdocai.llm.prompt.DocumentAnalysisPrompts;
import com.deepdocai.llm.worker.RateLimitException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

/**
 * Recursively compresses a large collection of text blocks (chunks or summaries)
 * into a single context that fits within the LLM's usable context window.
 *
 * Algorithm (per level):
 *   1. Estimate total tokens of current input
 *   2. If fits in available window → return as-is (base case)
 *   3. Compute dynamic batch size = floor(availableTokens / avgBlockTokens)
 *   4. Split into batches, submit all to dynamic work queue
 *   5. 5 workers (one per key) compete to process batches in parallel
 *   6. Collect compressed summaries → recurse
 *
 * Convergence: each level compresses ~65-70%, so typically 2-4 levels for 500 chunks.
 * Guard: maxRecursionDepth (default 8) prevents infinite loops.
 *
 * Intermediate storage: plain in-memory List<String> per request — transient, request-scoped.
 */
@Service
@Slf4j
public class RecursiveSummarizationService {

    private static final long RATE_LIMIT_BACKOFF_MS = 60_000L;
    private static final int  MAX_RECURSION_DEPTH   = 8;

    // Chars-per-token estimate for log/code content (denser than English prose)
    private static final double CHARS_PER_TOKEN = 3.5;
    // Safety margin on top of the 80% utilization — effective usage = 80% × 0.85 = 68%
    private static final double SAFETY_MARGIN = 0.85;

    private final GeminiClient geminiClient;
    private final ApiKeyManager apiKeyManager;

    @Value("${deepdocai.gemini.context-limit-tokens:1000000}")
    private long contextLimitTokens;

    @Value("${deepdocai.rag.utilization:0.80}")
    private double utilizationTarget;

    @Value("${deepdocai.gemini.max-output-tokens:8192}")
    private int maxOutputTokens;

    public RecursiveSummarizationService(GeminiClient geminiClient, ApiKeyManager apiKeyManager) {
        this.geminiClient = geminiClient;
        this.apiKeyManager = apiKeyManager;
    }

    /**
     * Entry point. Takes a list of text blocks (document chunks or previous-level summaries)
     * and recursively compresses them until they fit in a single LLM context call.
     *
     * @param blocks       texts to compress (chunks or prior-level summaries)
     * @param userQuestion the original user question (used in prompts and fit-check budget)
     * @param depth        recursion depth (start with 0)
     * @return single compacted context string ready for the final answer call
     */
    public String summarize(List<String> blocks, String userQuestion, int depth) {
        if (depth > MAX_RECURSION_DEPTH) {
            log.warn("Max recursion depth ({}) reached. Truncating to first {} blocks.",
                MAX_RECURSION_DEPTH, apiKeyManager.getSlotCount() * 5);
            blocks = blocks.subList(0, Math.min(blocks.size(), apiKeyManager.getSlotCount() * 5));
        }

        log.info("[Summarization depth={}] Input: {} blocks", depth, blocks.size());

        // ── STEP A: Token estimation ──────────────────────────────────────────
        long totalInputTokens   = estimateTokens(String.join(" ", blocks));
        long systemPromptTokens = estimateTokens(DocumentAnalysisPrompts.SUMMARIZATION_SYSTEM_PROMPT);
        long questionTokens     = estimateTokens(userQuestion);
        long outputBuffer       = maxOutputTokens;

        long usableWindow = (long) (contextLimitTokens * utilizationTarget * SAFETY_MARGIN);
        long availableForContent = usableWindow - systemPromptTokens - questionTokens - outputBuffer;

        if (availableForContent <= 0) {
            throw new IllegalStateException("System prompt + question alone exceed the usable context window");
        }

        // ── STEP B: Fit check ─────────────────────────────────────────────────
        if (totalInputTokens <= availableForContent) {
            log.info("[depth={}] All {} blocks fit in context ({} tokens ≤ {} available). Recursion done.",
                depth, blocks.size(), totalInputTokens, availableForContent);
            return String.join("\n\n---\n\n", blocks);
        }

        // ── STEP C: Compute dynamic batch size ────────────────────────────────
        long avgBlockTokens = Math.max(1, totalInputTokens / blocks.size());
        int  batchSize      = (int) Math.max(1, availableForContent / avgBlockTokens);

        log.info("[depth={}] Does not fit ({} > {}). batchSize={}, parts={}",
            depth, totalInputTokens, availableForContent, batchSize,
            (int) Math.ceil((double) blocks.size() / batchSize));

        // ── STEP D: Split into parts ──────────────────────────────────────────
        List<List<String>> parts = partition(blocks, batchSize);
        log.info("[depth={}] Split into {} parts", depth, parts.size());

        // ── STEP E: Dynamic work queue — 5 workers compete ───────────────────
        List<String> summaries = processPartsInParallel(parts, userQuestion, depth);

        // ── STEP F: Recurse ───────────────────────────────────────────────────
        log.info("[depth={}] Produced {} summaries. Recursing to depth {}.",
            depth, summaries.size(), depth + 1);
        return summarize(summaries, userQuestion, depth + 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Parallel processing with dynamic work queue
    // ─────────────────────────────────────────────────────────────────────────

    private List<String> processPartsInParallel(List<List<String>> parts, String question, int depth) {
        int numSlots = apiKeyManager.getSlotCount();

        // Build a simple in-memory queue of (partIndex, part)
        java.util.concurrent.LinkedBlockingQueue<PartTask> queue = new java.util.concurrent.LinkedBlockingQueue<>(parts.size());
        String[] results = new String[parts.size()];

        for (int i = 0; i < parts.size(); i++) {
            queue.offer(new PartTask(i, parts.get(i)));
        }

        // Launch one thread per key slot — they compete on the queue
        List<Thread> workers = new ArrayList<>();
        for (int slot = 0; slot < numSlots; slot++) {
            final int slotIndex = slot;
            Thread t = new Thread(() -> workerLoop(queue, results, question, slotIndex, depth),
                "summarization-worker-" + slot);
            t.setDaemon(true);
            workers.add(t);
            t.start();
        }

        // Wait for all workers to finish (queue drained)
        for (Thread t : workers) {
            try {
                t.join();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new RuntimeException("Summarization interrupted at depth " + depth, e);
            }
        }

        // Collect results in order, handle partial failures gracefully
        List<String> summaries = new ArrayList<>();
        int failedParts = 0;
        for (int i = 0; i < results.length; i++) {
            if (results[i] != null) {
                summaries.add(results[i]);
            } else {
                failedParts++;
                log.warn("[depth={}] Part {} failed — skipping (partial context)", depth, i);
            }
        }

        if (failedParts > 0) {
            log.warn("[depth={}] {}/{} parts failed. Proceeding with partial context.", depth, failedParts, results.length);
        }

        if (summaries.isEmpty()) {
            throw new RuntimeException("All parts failed at summarization depth " + depth);
        }

        return summaries;
    }

    private void workerLoop(java.util.concurrent.LinkedBlockingQueue<PartTask> queue,
                             String[] results, String question, int slotIndex, int depth) {
        ApiKeySlot slot = apiKeyManager.getSlot(slotIndex);

        while (true) {
            PartTask task;
            try {
                // Poll with timeout — if queue empty for 500ms, this worker is done
                task = queue.poll(500, java.util.concurrent.TimeUnit.MILLISECONDS);
                if (task == null) break; // queue exhausted
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }

            boolean success = false;
            int attempts = 0;

            while (!success && attempts < 3) {
                try {
                    slot.enforceRateLimit();

                    String prompt = buildSummarizationPrompt(task.blocks, question, depth);
                    String summary = geminiClient.generateContent(
                        prompt,
                        DocumentAnalysisPrompts.SUMMARIZATION_SYSTEM_PROMPT,
                        false,
                        slot.getApiKey(),
                        maxOutputTokens
                    );
                    slot.markCallMade();

                    // Guard: if output ≥ 95% of input, LLM is not compressing — truncate
                    long inputTokens  = estimateTokens(prompt);
                    long outputTokens = estimateTokens(summary);
                    if (outputTokens >= inputTokens * 0.95) {
                        log.warn("[depth={}, slot={}] Compression ratio < 5%. Using first 50% of output as safeguard.", depth, slotIndex);
                        summary = summary.substring(0, summary.length() / 2);
                    }

                    results[task.index] = summary;
                    log.debug("[depth={}, slot={}] Part {} done. Input≈{}t, Output≈{}t",
                        depth, slotIndex, task.index, inputTokens, outputTokens);
                    success = true;

                } catch (RateLimitException e) {
                    log.warn("[depth={}, slot={}] Rate limit hit. Re-queuing part {}, sleeping {}ms.",
                        depth, slotIndex, task.index, RATE_LIMIT_BACKOFF_MS);
                    slot.markRateLimited();
                    queue.offer(task); // another worker can pick this up after backoff
                    try {
                        Thread.sleep(RATE_LIMIT_BACKOFF_MS);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                    slot.markRecovered();
                    break; // exit retry loop — item re-queued, move on

                } catch (Exception e) {
                    attempts++;
                    log.warn("[depth={}, slot={}] Part {} failed (attempt {}/3): {}",
                        depth, slotIndex, task.index, attempts, e.getMessage());
                    if (attempts >= 3) {
                        log.error("[depth={}, slot={}] Part {} failed after 3 attempts. Skipping.",
                            depth, slotIndex, task.index);
                        // results[task.index] stays null → handled in processPartsInParallel
                    } else {
                        try { Thread.sleep(1000L * attempts); } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt(); return;
                        }
                    }
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Prompt building
    // ─────────────────────────────────────────────────────────────────────────

    private String buildSummarizationPrompt(List<String> blocks, String question, int depth) {
        StringBuilder sb = new StringBuilder();

        sb.append("=== USER QUESTION (for context only — do NOT answer yet) ===\n");
        sb.append(question).append("\n\n");

        sb.append("=== CONTENT BLOCKS TO SUMMARIZE (").append(blocks.size()).append(" blocks) ===\n");
        for (int i = 0; i < blocks.size(); i++) {
            sb.append("[Block ").append(i + 1).append("]\n");
            sb.append(blocks.get(i)).append("\n\n");
        }

        sb.append("=== YOUR TASK ===\n");
        if (depth == 0) {
            sb.append("""
                These are raw document/log chunks relevant to the user's question.
                Extract and preserve ALL information that is relevant to answering the question.
                Pay special attention to: errors, exceptions, stack traces, timestamps, thread states,
                connection pool events, latencies, memory usage, and system flow sequences.
                Compress aggressively — target 25-35% of input size — but DO NOT lose critical details.
                Output a structured summary preserving all key facts.
                """);
        } else {
            sb.append("""
                These are partial summaries from a previous compression pass.
                Merge and compress them into a single coherent summary.
                Eliminate duplicate information. Preserve all unique details.
                Target 25-35% of input size.
                """);
        }

        return sb.toString();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Utilities
    // ─────────────────────────────────────────────────────────────────────────

    private long estimateTokens(String text) {
        if (text == null || text.isEmpty()) return 0;
        return (long) Math.ceil(text.length() / CHARS_PER_TOKEN);
    }

    private <T> List<List<T>> partition(List<T> list, int batchSize) {
        List<List<T>> parts = new ArrayList<>();
        for (int i = 0; i < list.size(); i += batchSize) {
            parts.add(new ArrayList<>(list.subList(i, Math.min(i + batchSize, list.size()))));
        }
        return parts;
    }

    private record PartTask(int index, List<String> blocks) {}
}
