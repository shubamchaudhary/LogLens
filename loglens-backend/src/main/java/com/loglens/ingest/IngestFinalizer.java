package com.loglens.ingest;

import com.loglens.common.constants.AnalysisStatus;
import com.loglens.data.repository.DocumentRepository;
import com.loglens.data.repository.SessionRepository;
import com.loglens.enrich.EnrichCompletion;
import com.loglens.enrich.EnrichProducer;
import com.loglens.storage.FileStorageService;
import com.loglens.storage.SessionChunkRepository;
import com.loglens.storage.SessionChunkRepository.ChunkRef;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Runs exactly once when a document's every part has been processed. Claims the
 * finalize via an atomic conditional UPDATE (only one caller wins), then:
 * <ol>
 *   <li>applies the corpus-global latency-outlier rule in one SQL pass (the p95
 *       rule a single part could not compute);</li>
 *   <li>fans the document's chunks out onto the enrichment lane (embeddings for
 *       all, LLM narratives for anomalies);</li>
 *   <li>deletes the staged blob — the Postgres chunks are now the durable copy.</li>
 * </ol>
 * Clones the counter-triggered, coordinator-free pattern of {@link EnrichCompletion}.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class IngestFinalizer {

    private final DocumentRepository documentRepository;
    private final SessionRepository sessionRepository;
    private final SessionChunkRepository chunkRepository;
    private final EnrichProducer enrichProducer;
    private final EnrichCompletion enrichCompletion;
    private final FileStorageService fileStorageService;
    private final AnomalyDetector anomalyDetector;

    /**
     * Called by every part after its transaction commits. The atomic claim makes
     * this a no-op for all but the one caller that observes all parts complete.
     */
    public void tryFinalize(UUID sessionId, UUID documentId, String fileUrl) {
        if (documentRepository.claimFinalize(documentId) != 1) {
            return; // not the last part, or another caller already finalized
        }
        log.info("Finalizing ingest: session={} document={}", sessionId, documentId);

        // 1. Corpus-wide rules a single part cannot compute (robust mode: count and
        //    latency spikes vs the session median/MAD + rare signatures; legacy:
        //    3x p95 latency) — before we decide what to enrich.
        int flagged = anomalyDetector.isRobust()
            ? chunkRepository.flagRobustOutliers(sessionId)
            : chunkRepository.flagLatencyOutliers(sessionId);

        // 2. Enrichment fan-out from the FINAL anomaly state. Set the counter target
        //    (additive for multi-document sessions) and flip to ENRICHING BEFORE
        //    producing so a fast consumer sees a correct target the moment items land.
        List<ChunkRef> refs = chunkRepository.listChunkRefs(sessionId, documentId);
        int workItems = enrichProducer.workItemCountForRefs(refs);
        sessionRepository.addTotalWindows(sessionId, workItems);
        sessionRepository.setStatus(sessionId, AnalysisStatus.ENRICHING);
        enrichProducer.produceFromRefs(sessionId, refs);

        // 3. Staging served its purpose — the chunk rows are the durable copy now.
        fileStorageService.delete(fileUrl);
        documentRepository.markStagedDeleted(documentId, Instant.now());

        // Nothing to enrich → advance immediately (no work item will drive the counter).
        if (workItems == 0) {
            enrichCompletion.checkAndTrigger(sessionId);
        }

        log.info("Ingest finalized: session={} document={} chunks={} latencyFlagged={} workItems={}",
            sessionId, documentId, refs.size(), flagged, workItems);
    }
}
