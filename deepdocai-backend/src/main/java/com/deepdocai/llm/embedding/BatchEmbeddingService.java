package com.deepdocai.llm.embedding;

import com.deepdocai.llm.client.GeminiClient;
import com.deepdocai.llm.key.ApiKeyManager;
import com.deepdocai.llm.key.ApiKeySlot;
import com.deepdocai.llm.worker.KeyedWorkerPool;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;

/**
 * Manages batch embedding generation using the EmbeddingWorkerPool.
 *
 * Usage: submit a list of texts → get back a list of float[] embeddings in the same order.
 *
 * Internally:
 *   - Splits texts into batches of maxBatchSize (default 80)
 *   - Each batch is a WorkItem in the KeyedWorkerPool queue
 *   - 5 worker threads (one per API key) compete to process batches
 *   - Rate limiting: 7,500 ms per key (80% of 10 calls/min)
 *   - On 429: worker sleeps 60s, re-enqueues the batch
 *   - On other failure: retry up to 3x, then fail that batch
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class BatchEmbeddingService {

    private final GeminiClient geminiClient;
    private final ApiKeyManager apiKeyManager;

    @Value("${deepdocai.embedding.batch-size:80}")
    private int maxBatchSize;

    private KeyedWorkerPool<List<String>, List<float[]>> workerPool;

    @PostConstruct
    public void init() {
        workerPool = new KeyedWorkerPool<>(apiKeyManager, "embedding-pool");
        workerPool.start();
        log.info("BatchEmbeddingService started with batch-size={}", maxBatchSize);
    }

    @PreDestroy
    public void shutdown() {
        if (workerPool != null) workerPool.stop();
    }

    /**
     * Generate embeddings for all texts. Blocks until all batches are processed.
     * Returns embeddings in the same order as the input list.
     *
     * For large document uploads: this is called once per document with all its chunks.
     */
    public List<float[]> generateEmbeddings(List<String> texts) {
        if (texts == null || texts.isEmpty()) return List.of();

        log.info("Submitting {} texts for embedding (batch size: {})", texts.size(), maxBatchSize);

        // Split into batches and submit each as a separate work item
        List<BatchRef> batchRefs = new ArrayList<>();
        for (int i = 0; i < texts.size(); i += maxBatchSize) {
            int end = Math.min(i + maxBatchSize, texts.size());
            List<String> batch = texts.subList(i, end);
            int startIndex = i;

            CompletableFuture<List<float[]>> future = workerPool.submit(
                batch,
                apiKey -> {
                    log.debug("Processing embedding batch [{} texts] with key ending ...{}",
                        batch.size(), apiKey.substring(Math.max(0, apiKey.length() - 4)));
                    return geminiClient.batchGenerateEmbeddings(batch, apiKey);
                }
            );
            batchRefs.add(new BatchRef(startIndex, end, future));
        }

        // Collect results, maintaining original order
        float[][] results = new float[texts.size()][];
        int failedBatches = 0;

        for (BatchRef ref : batchRefs) {
            try {
                List<float[]> batchResult = ref.future.get();
                for (int i = 0; i < batchResult.size(); i++) {
                    results[ref.startIndex + i] = batchResult.get(i);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new RuntimeException("Embedding generation interrupted", e);
            } catch (ExecutionException e) {
                failedBatches++;
                log.error("Embedding batch [{}-{}] failed after retries: {}",
                    ref.startIndex, ref.endIndex, e.getCause().getMessage());
                // Fill with null for failed batch — caller must handle
                for (int i = ref.startIndex; i < ref.endIndex; i++) {
                    results[i] = null;
                }
            }
        }

        if (failedBatches > 0) {
            log.warn("{}/{} embedding batches failed. Partial embeddings returned.",
                failedBatches, batchRefs.size());
        }

        List<float[]> resultList = new ArrayList<>(results.length);
        for (float[] r : results) resultList.add(r);
        return resultList;
    }

    /**
     * Generate embedding for a single text (used for query embedding at Q&A time).
     * Bypasses the worker pool — direct call with slot[0] to avoid queue latency.
     */
    public float[] generateSingleEmbedding(String text) {
        ApiKeySlot slot = apiKeyManager.getSlot(0);
        slot.enforceRateLimit();
        float[] result = geminiClient.generateEmbedding(text, slot.getApiKey());
        slot.markCallMade();
        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────

    private record BatchRef(int startIndex, int endIndex, CompletableFuture<List<float[]>> future) {}
}
