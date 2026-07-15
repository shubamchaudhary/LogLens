package com.deepdocai.enrich;

import com.deepdocai.common.constants.KafkaTopics;
import com.deepdocai.common.messages.EnrichRequest;
import com.deepdocai.ingest.model.LogWindow;
import com.deepdocai.llm.key.ApiKeyManager;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Fans a parsed session out onto the enrichment lane: one {@code ENRICH_WINDOW}
 * per anomalous window (the only windows worth an LLM explanation) plus one
 * {@code EMBED_BATCH} per {@code batchSize} chunks across <em>all</em> windows
 * (so drill-down retrieval can search the whole session, not just anomalies).
 *
 * <p>Work items are spread across the {@code llm.enrich.requests} partitions by a
 * stable hash of their {@code workId}, so each API-key lane gets its share and a
 * retried item deterministically returns to the same lane.
 */
@Component
@Slf4j
public class EnrichProducer {

    private final KafkaTemplate<String, Object> kafkaTemplate;
    private final int slotCount;
    private final boolean embeddingEnabled;
    private final int batchSize;

    public EnrichProducer(
        KafkaTemplate<String, Object> kafkaTemplate,
        ApiKeyManager apiKeyManager,
        @Value("${chunkai.embedding.enabled:true}") boolean embeddingEnabled,
        @Value("${chunkai.embedding.batch-size:80}") int batchSize
    ) {
        this.kafkaTemplate = kafkaTemplate;
        this.slotCount = apiKeyManager.getSlotCount();
        this.embeddingEnabled = embeddingEnabled;
        this.batchSize = Math.max(1, batchSize);
    }

    /**
     * Number of work items {@link #produce} will emit for these windows. The
     * ingest lane records this as {@code total_windows} <em>before</em> producing,
     * so the completion counter has a correct target the moment items start
     * landing.
     */
    public int workItemCount(List<LogWindow> windows) {
        int anomalous = 0;
        for (LogWindow w : windows) {
            if (w.isAnomalous()) {
                anomalous++;
            }
        }
        int embedBatches = 0;
        if (embeddingEnabled && !windows.isEmpty()) {
            embedBatches = (windows.size() + batchSize - 1) / batchSize;
        }
        return anomalous + embedBatches;
    }

    /** Emit all enrichment + embedding work items for a freshly-parsed session. */
    public void produce(UUID sessionId, List<LogWindow> windows) {
        int windowItems = 0;
        for (LogWindow w : windows) {
            if (w.isAnomalous()) {
                send(new EnrichRequest(UUID.randomUUID(), sessionId,
                    EnrichRequest.ENRICH_WINDOW, List.of(w.chunkId()), 0, 0L));
                windowItems++;
            }
        }

        int embedItems = 0;
        if (embeddingEnabled && !windows.isEmpty()) {
            List<UUID> chunkIds = new ArrayList<>(windows.size());
            for (LogWindow w : windows) {
                chunkIds.add(w.chunkId());
            }
            for (int start = 0; start < chunkIds.size(); start += batchSize) {
                List<UUID> batch = List.copyOf(chunkIds.subList(start, Math.min(start + batchSize, chunkIds.size())));
                send(new EnrichRequest(UUID.randomUUID(), sessionId,
                    EnrichRequest.EMBED_BATCH, batch, 0, 0L));
                embedItems++;
            }
        }

        log.info("Enqueued enrichment for session {}: {} ENRICH_WINDOW, {} EMBED_BATCH",
            sessionId, windowItems, embedItems);
    }

    /** Send one work item to {@code llm.enrich.requests}, spread by workId hash. */
    public void send(EnrichRequest request) {
        int partition = Math.floorMod(request.workId().hashCode(), slotCount);
        kafkaTemplate.send(KafkaTopics.LLM_ENRICH_REQUESTS, partition, request.sessionId().toString(), request);
    }
}
