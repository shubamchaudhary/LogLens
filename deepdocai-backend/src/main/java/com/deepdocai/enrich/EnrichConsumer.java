package com.deepdocai.enrich;

import com.deepdocai.common.constants.KafkaTopics;
import com.deepdocai.common.messages.EnrichRequest;
import com.deepdocai.data.repository.SessionRepository;
import com.deepdocai.ingest.MetricsWriter;
import com.deepdocai.llm.client.LlmGateway;
import com.deepdocai.llm.key.ApiKeyManager;
import com.deepdocai.llm.worker.RateLimitException;
import com.deepdocai.storage.SessionChunkRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.kafka.support.KafkaHeaders;
import org.springframework.messaging.handler.annotation.Header;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * The LLM enrichment lane. Each partition of {@code llm.enrich.requests} maps to
 * one API key of the active provider ({@code concurrency == slot count}), so the
 * consumer thread for partition <em>p</em> always uses lane <em>p mod slots</em>
 * and paces itself lock-free via that lane's
 * {@link com.deepdocai.llm.key.ApiKeySlot} (interval set per provider — Groq
 * 2.5s, Gemini 7.5s). Transport goes through {@link LlmGateway}
 * ({@code chunkai.llm.provider}).
 *
 * <p>Dispatch by {@link EnrichRequest#kind()}:
 * <ul>
 *   <li>{@code ENRICH_WINDOW} → prompt the LLM for JSON insight(s), upsert
 *       {@code log_findings} deduped on {@code (session_id, fingerprint)};</li>
 *   <li>{@code EMBED_BATCH} → batch-embed the chunks and write the vectors.</li>
 * </ul>
 *
 * <p>Error policy (global decision: at-least-once, idempotent): a 429 re-releases
 * the item to {@code llm.enrich.retry.60s} with {@code attempt+1} (the thread
 * never sleeps 60s); once {@code attempt >= MAX_ATTEMPTS} — or on any
 * non-retryable error — the item is dead-lettered. <em>Every</em> terminal
 * outcome (success or DLQ) bumps {@code enriched_windows} so a single failed item
 * can never wedge session completion. Offsets are committed manually only after
 * that bookkeeping.
 */
@Component
@Slf4j
public class EnrichConsumer {

    /** attempt >= this → give up and dead-letter (spec: 3). */
    private static final int MAX_ATTEMPTS = 3;
    // Fixed token allowance for the findings-JSON completion, added to the
    // prompt estimate when pacing against the key's tokens-per-minute budget.
    private static final int OUTPUT_TOKEN_ESTIMATE = 512;
    private static final Set<String> VALID_SEVERITY = Set.of("INFO", "WARN", "ERROR", "CRITICAL");
    private static final long RETRY_DELAY_MS = 60_000L;

    /**
     * A line begins a new logical record when it starts (after optional leading
     * whitespace) with a recognisable timestamp. Mirrors the formats
     * {@link com.deepdocai.ingest.TimeWindowChunker} recognises (ISO-8601 /
     * {@code yyyy-MM-dd HH:mm:ss} / syslog) so record-aware splitting agrees
     * with chunking. Lines without a leading timestamp (stack frames,
     * {@code Caused by:}, {@code ... N more}) are continuations.
     */
    private static final Pattern RECORD_START = Pattern.compile(
        "^\\s*(?:\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}"
        + "|[A-Z][a-z]{2}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2})");

    private final ApiKeyManager apiKeyManager;
    private final LlmGateway llmGateway;
    private final SessionChunkRepository chunkRepository;
    private final MetricsWriter metricsWriter;
    private final FindingsWriter findingsWriter;
    private final SessionRepository sessionRepository;
    private final EnrichCompletion completion;
    private final KafkaTemplate<String, Object> kafkaTemplate;
    private final ObjectMapper objectMapper;
    private final long windowSeconds;
    private final int maxContentChars;

    public EnrichConsumer(
        ApiKeyManager apiKeyManager,
        LlmGateway llmGateway,
        SessionChunkRepository chunkRepository,
        MetricsWriter metricsWriter,
        FindingsWriter findingsWriter,
        SessionRepository sessionRepository,
        EnrichCompletion completion,
        KafkaTemplate<String, Object> kafkaTemplate,
        ObjectMapper objectMapper,
        @Value("${chunkai.window-seconds:60}") long windowSeconds,
        @Value("${chunkai.enrich.max-content-chars:5000}") int maxContentChars
    ) {
        this.apiKeyManager = apiKeyManager;
        this.llmGateway = llmGateway;
        this.chunkRepository = chunkRepository;
        this.metricsWriter = metricsWriter;
        this.findingsWriter = findingsWriter;
        this.sessionRepository = sessionRepository;
        this.completion = completion;
        this.kafkaTemplate = kafkaTemplate;
        this.objectMapper = objectMapper;
        this.windowSeconds = windowSeconds;
        this.maxContentChars = maxContentChars;
    }

    @KafkaListener(
        topics = "#{T(com.deepdocai.common.constants.KafkaTopics).LLM_ENRICH_REQUESTS}",
        groupId = "llm-workers",
        concurrency = "#{@apiKeyManager.getSlotCount()}")
    public void onEnrich(EnrichRequest request,
                         @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
                         Acknowledgment ack) {
        try {
            process(request, partition);
            markEnriched(request.sessionId());
        } catch (RateLimitException e) {
            if (request.attempt() >= MAX_ATTEMPTS) {
                log.warn("Work {} ({}) still rate-limited at attempt {} → DLQ: {}",
                    request.workId(), request.kind(), request.attempt(), e.getMessage());
                deadLetter(request);
                markEnriched(request.sessionId());
            } else {
                long notBefore = System.currentTimeMillis() + RETRY_DELAY_MS;
                kafkaTemplate.send(KafkaTopics.LLM_ENRICH_RETRY_60S,
                    request.sessionId().toString(), request.retry(notBefore));
                log.info("Work {} ({}) rate-limited → retry lane (attempt {} → {}): {}",
                    request.workId(), request.kind(), request.attempt(), request.attempt() + 1, e.getMessage());
            }
        } catch (Exception e) {
            log.error("Work {} ({}) failed non-retryably → DLQ: {}",
                request.workId(), request.kind(), e.toString());
            deadLetter(request);
            markEnriched(request.sessionId());
        } finally {
            ack.acknowledge();
        }
    }

    private void process(EnrichRequest request, int partition) {
        // A session deleted after its work was enqueued leaves a Kafka backlog
        // whose per-session chunk table is already dropped; skip it quietly
        // instead of dead-lettering every item with a bad-SQL-grammar error.
        if (!sessionRepository.existsById(request.sessionId())) {
            log.warn("Session {} no longer exists — skipping {} work {}",
                request.sessionId(), request.kind(), request.workId());
            return;
        }
        // Modulo guards against a topic wider than the active provider's key
        // count (Kafka partitions can never be lowered on an existing volume).
        int lane = partition % apiKeyManager.getSlotCount();
        String apiKey = apiKeyManager.getApiKey(lane);
        switch (request.kind()) {
            case EnrichRequest.ENRICH_WINDOW -> enrichWindow(request, lane, apiKey);
            case EnrichRequest.EMBED_BATCH -> embedBatch(request, lane, apiKey);
            default -> log.warn("Unknown enrich kind '{}' for work {} — skipping",
                request.kind(), request.workId());
        }
    }

    private void enrichWindow(EnrichRequest request, int partition, String apiKey) {
        List<SessionChunkRepository.ChunkContent> chunks =
            chunkRepository.readChunks(request.sessionId(), request.chunkIds());
        if (chunks.isEmpty()) {
            log.warn("ENRICH_WINDOW work {} has no resolvable chunks — skipping", request.workId());
            return;
        }

        StringBuilder content = new StringBuilder();
        List<Instant> buckets = new ArrayList<>();
        Instant minBucket = null;
        Instant maxBucket = null;
        for (SessionChunkRepository.ChunkContent c : chunks) {
            if (content.length() > 0) {
                content.append("\n\n");
            }
            content.append(c.content());
            buckets.add(c.timeBucket());
            if (minBucket == null || c.timeBucket().isBefore(minBucket)) {
                minBucket = c.timeBucket();
            }
            if (maxBucket == null || c.timeBucket().isAfter(maxBucket)) {
                maxBucket = c.timeBucket();
            }
        }

        List<String> metricContext = metricsWriter.metricContext(request.sessionId(), buckets);
        List<String> segments = splitContent(content.toString(), maxContentChars);

        Instant rangeStart = minBucket;
        Instant rangeEnd = maxBucket == null ? null : maxBucket.plusSeconds(windowSeconds);
        int written = 0;
        for (String segment : segments) {
            String user = EnrichPrompts.user(segment, metricContext);

            apiKeyManager.getSlot(partition).enforceTokenBudget(estimateTokens(EnrichPrompts.SYSTEM, user));
            apiKeyManager.getSlot(partition).enforceRateLimit();
            String json;
            try {
                json = llmGateway.generate(user, EnrichPrompts.SYSTEM, apiKey);
            } finally {
                apiKeyManager.getSlot(partition).markCallMade();
            }

            for (JsonNode node : parseFindings(json)) {
                String title = text(node, "title");
                String explanation = text(node, "explanation");
                if (title.isBlank() || explanation.isBlank()) {
                    continue;
                }
                String category = clampCategory(text(node, "category"));
                String severity = clampSeverity(text(node, "severity"));
                Double confidence = confidence(node);
                String fingerprint = EnrichPrompts.fingerprint(category, title);
                findingsWriter.upsert(new FindingsWriter.Finding(
                    request.sessionId(), category, severity, title, explanation,
                    request.chunkIds(), rangeStart, rangeEnd, fingerprint, confidence));
                written++;
            }
        }
        if (segments.size() > 1) {
            log.info("ENRICH_WINDOW work {} → {} finding(s) upserted across {} segments",
                request.workId(), written, segments.size());
        } else {
            log.info("ENRICH_WINDOW work {} → {} finding(s) upserted", request.workId(), written);
        }
    }

    private void embedBatch(EnrichRequest request, int partition, String apiKey) {
        List<SessionChunkRepository.ChunkContent> chunks =
            chunkRepository.readChunks(request.sessionId(), request.chunkIds());
        if (chunks.isEmpty()) {
            log.warn("EMBED_BATCH work {} has no resolvable chunks — skipping", request.workId());
            return;
        }

        List<String> texts = new ArrayList<>(chunks.size());
        for (SessionChunkRepository.ChunkContent c : chunks) {
            texts.add(c.content());
        }

        apiKeyManager.getSlot(partition).enforceRateLimit();
        List<float[]> vectors;
        try {
            vectors = llmGateway.embedBatch(texts, apiKey);
        } finally {
            apiKeyManager.getSlot(partition).markCallMade();
        }

        int n = Math.min(vectors.size(), chunks.size());
        if (vectors.size() != chunks.size()) {
            log.warn("EMBED_BATCH work {}: expected {} vectors, got {} — writing {}",
                request.workId(), chunks.size(), vectors.size(), n);
        }
        List<SessionChunkRepository.ChunkEmbedding> updates = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            updates.add(new SessionChunkRepository.ChunkEmbedding(
                chunks.get(i).chunkId(), llmGateway.toVectorString(vectors.get(i))));
        }
        int updated = chunkRepository.updateEmbeddings(request.sessionId(), updates);
        log.info("EMBED_BATCH work {} → {} embeddings written", request.workId(), updated);
    }

    /**
     * Splits a window's log content into segments each within {@code max}
     * characters so a large window is fully analyzed rather than truncated —
     * every segment is enriched in its own LLM call and duplicate insights fold
     * together via the {@code (session_id, fingerprint)} upsert.
     *
     * <p>Bounding each call also keeps it under a provider's per-request token
     * budget: Groq's {@code llama-3.1-8b-instant} free tier caps at 6000
     * tokens/minute and rejects an oversized prompt with a non-retryable 413.
     * {@code chunkai.enrich.max-content-chars} leaves headroom for the system
     * prompt, metric context, and the model's output. Bursts that trip the
     * per-minute ceiling surface as a 429 and are handled by the retry lane.
     *
     * <p>Splitting is <b>record-aware</b>: lines are first grouped into logical
     * records (a timestamped line plus its continuation lines — stack frames,
     * {@code Caused by:}, {@code ... N more} — which carry no timestamp), then
     * whole records are greedily packed up to {@code max} so a multi-line event
     * (e.g. a stack trace) is never split across two calls and its reasoning is
     * never lost. A single record larger than {@code max} is hard-split on line
     * boundaries as a last resort so no content is ever dropped.
     */
    private List<String> splitContent(String content, int max) {
        List<String> segments = new ArrayList<>();
        if (max <= 0 || content.length() <= max) {
            segments.add(content);
            return segments;
        }
        StringBuilder seg = new StringBuilder();
        for (String record : groupRecords(content)) {
            if (record.length() > max) {
                if (seg.length() > 0) {
                    segments.add(seg.toString());
                    seg.setLength(0);
                }
                hardSplit(record, max, segments);
                continue;
            }
            int extra = record.length() + (seg.length() > 0 ? 1 : 0);
            if (seg.length() + extra > max && seg.length() > 0) {
                segments.add(seg.toString());
                seg.setLength(0);
            }
            if (seg.length() > 0) {
                seg.append('\n');
            }
            seg.append(record);
        }
        if (seg.length() > 0) {
            segments.add(seg.toString());
        }
        return segments;
    }

    /**
     * Groups raw lines into logical records. A line starts a new record when it
     * begins with a recognisable timestamp ({@link #RECORD_START}); a line
     * without one is a continuation of the current record (stack frame,
     * {@code Caused by:}, {@code ... N more}, or a plain multi-line message).
     */
    private static List<String> groupRecords(String content) {
        List<String> records = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        for (String line : content.split("\n", -1)) {
            if (RECORD_START.matcher(line).find() && cur.length() > 0) {
                records.add(cur.toString());
                cur.setLength(0);
            }
            if (cur.length() > 0) {
                cur.append('\n');
            }
            cur.append(line);
        }
        if (cur.length() > 0) {
            records.add(cur.toString());
        }
        return records;
    }

    /**
     * Fallback for a single logical record larger than the cap (rare — e.g. a
     * huge stack trace). Splits on line boundaries; a single line longer than
     * {@code max} is chopped so nothing is dropped.
     */
    private static void hardSplit(String record, int max, List<String> out) {
        StringBuilder seg = new StringBuilder();
        for (String rawLine : record.split("\n", -1)) {
            String line = rawLine;
            while (line.length() > max) {
                if (seg.length() > 0) {
                    out.add(seg.toString());
                    seg.setLength(0);
                }
                out.add(line.substring(0, max));
                line = line.substring(max);
            }
            int extra = line.length() + (seg.length() > 0 ? 1 : 0);
            if (seg.length() + extra > max && seg.length() > 0) {
                out.add(seg.toString());
                seg.setLength(0);
            }
            if (seg.length() > 0) {
                seg.append('\n');
            }
            seg.append(line);
        }
        if (seg.length() > 0) {
            out.add(seg.toString());
        }
    }

    /**
     * Rough token estimate for a Groq generation call, used to pace against the
     * key's tokens-per-minute budget. English text is ~4 chars/token; we add a
     * fixed allowance for the JSON completion (findings are small). Groq's TPM
     * throttle counts prompt + actual completion, so a slight over-estimate just
     * buys safety margin against a 429.
     */
    private static long estimateTokens(String system, String user) {
        return (system.length() + user.length()) / 4L + OUTPUT_TOKEN_ESTIMATE;
    }

    private void markEnriched(UUID sessionId) {        sessionRepository.incrementEnrichedWindows(sessionId);
        completion.checkAndTrigger(sessionId);
    }

    private void deadLetter(EnrichRequest request) {
        kafkaTemplate.send(KafkaTopics.LLM_ENRICH_DLQ, request.sessionId().toString(), request);
    }

    // ── JSON helpers ─────────────────────────────────────────────────────────

    private List<JsonNode> parseFindings(String raw) {
        List<JsonNode> out = new ArrayList<>();
        if (raw == null || raw.isBlank()) {
            return out;
        }
        String json = stripFences(raw);
        try {
            JsonNode root = objectMapper.readTree(json);
            if (root.isArray()) {
                root.forEach(out::add);
            } else if (root.isObject()) {
                out.add(root);
            }
        } catch (Exception e) {
            log.warn("Could not parse enrichment JSON ({}). First 200 chars: {}",
                e.getMessage(), json.substring(0, Math.min(200, json.length())));
        }
        return out;
    }

    private static String stripFences(String raw) {
        String s = raw.trim();
        if (s.startsWith("```")) {
            int firstNl = s.indexOf('\n');
            if (firstNl >= 0) {
                s = s.substring(firstNl + 1);
            }
            if (s.endsWith("```")) {
                s = s.substring(0, s.length() - 3);
            }
        }
        return s.trim();
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return v == null || v.isNull() ? "" : v.asText().trim();
    }

    private static Double confidence(JsonNode node) {
        JsonNode v = node.get("confidence");
        if (v == null || v.isNull()) {
            return null;
        }
        double d = v.asDouble(Double.NaN);
        if (Double.isNaN(d)) {
            return null;
        }
        return Math.max(0.0, Math.min(1.0, d));
    }

    private static String clampSeverity(String raw) {
        String s = raw.toUpperCase();
        return VALID_SEVERITY.contains(s) ? s : "WARN";
    }

    private static String clampCategory(String raw) {
        String s = raw.trim().toUpperCase();
        if (s.isEmpty()) {
            return "GENERAL";
        }
        return s.length() > 30 ? s.substring(0, 30) : s;
    }
}
