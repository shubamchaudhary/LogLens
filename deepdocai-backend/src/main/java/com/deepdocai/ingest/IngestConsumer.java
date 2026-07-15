package com.deepdocai.ingest;

import com.deepdocai.common.constants.AnalysisStatus;
import com.deepdocai.common.constants.ProcessingStatus;
import com.deepdocai.common.messages.IngestRequest;
import com.deepdocai.data.entity.Document;
import com.deepdocai.data.repository.DocumentRepository;
import com.deepdocai.data.repository.SessionRepository;
import com.deepdocai.enrich.EnrichCompletion;
import com.deepdocai.enrich.EnrichProducer;
import com.deepdocai.ingest.model.LogWindow;
import com.deepdocai.ingest.model.MetricRow;
import com.deepdocai.ingest.parser.LogWindowParser;
import com.deepdocai.storage.FileStorageService;
import com.deepdocai.storage.SessionChunkRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Ingest lane: consumes {@link IngestRequest}s, streams the staged file back from
 * MinIO, chunks it into time windows, runs the Layer-1 parsers, writes exact
 * metrics, flags anomalous windows, and advances the session to {@code ENRICHING}
 * for the Phase-3 LLM lane.
 *
 * <p>Transaction discipline: the file read and the staged-file delete are IO and
 * hold no transaction; each DB write (status flips, chunk insert, metric upsert)
 * is its own short transaction. The consumer is idempotent — a redelivered
 * request whose document is already {@code COMPLETED} is skipped, and any partial
 * chunks are cleared before re-inserting.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class IngestConsumer {

    private final SessionRepository sessionRepository;
    private final DocumentRepository documentRepository;
    private final FileStorageService fileStorageService;
    private final TimeWindowChunker chunker;
    private final List<LogWindowParser> parsers;
    private final AnomalyDetector anomalyDetector;
    private final MetricsWriter metricsWriter;
    private final SessionChunkRepository chunkRepository;
    private final EnrichProducer enrichProducer;
    private final EnrichCompletion enrichCompletion;

    @KafkaListener(topics = "#{T(com.deepdocai.common.constants.KafkaTopics).LOG_INGEST_REQUESTS}",
        groupId = "ingest-workers")
    public void onIngest(IngestRequest request, Acknowledgment ack) {
        log.info("Ingest request: session={} document={}", request.sessionId(), request.documentId());
        process(request);
        ack.acknowledge();
    }

    private void process(IngestRequest request) {
        UUID sessionId = request.sessionId();
        UUID documentId = request.documentId();

        // Stale-message guard: the session (and its per-session chunk table) may
        // have been deleted while this request sat on the topic. Without the
        // chunk table every write below fails with "relation ... does not exist",
        // so skip cleanly rather than error-loop a message for a session that no
        // longer exists.
        if (!sessionRepository.existsById(sessionId)) {
            log.warn("No session {} for ingest request — skipping (deleted?)", sessionId);
            return;
        }

        Optional<Document> maybeDoc = documentRepository.findById(documentId);
        if (maybeDoc.isEmpty()) {
            log.warn("No document {} for ingest request — skipping", documentId);
            return;
        }
        if (maybeDoc.get().getProcessingStatus() == ProcessingStatus.COMPLETED) {
            log.info("Document {} already COMPLETED — skipping redelivery", documentId);
            return;
        }

        documentRepository.markProcessing(documentId);
        sessionRepository.setStatus(sessionId, AnalysisStatus.CHUNKING);

        List<String> lines = readAllLines(request.fileUrl());
        List<LogWindow> windows = chunker.chunk(lines);

        // Idempotent re-ingest: drop any chunks already staged for this document.
        chunkRepository.deleteByDocument(sessionId, documentId);
        for (LogWindow window : windows) {
            window.setChunkId(UUID.randomUUID());
        }

        sessionRepository.setStatus(sessionId, AnalysisStatus.PARSING);

        Map<LogWindow, List<MetricRow>> metricsByWindow = new LinkedHashMap<>();
        for (LogWindow window : windows) {
            List<MetricRow> rows = new ArrayList<>();
            for (LogWindowParser parser : parsers) {
                rows.addAll(parser.parse(window));
            }
            metricsByWindow.put(window, rows);
        }

        anomalyDetector.detect(windows, metricsByWindow);

        List<SessionChunkRepository.NewChunk> chunkRows = new ArrayList<>(windows.size());
        for (LogWindow window : windows) {
            chunkRows.add(new SessionChunkRepository.NewChunk(
                window.chunkId(), documentId, window.timeBucket(),
                window.lineStart(), window.lineEnd(), window.content(), window.isAnomalous()));
        }
        chunkRepository.insertBatch(sessionId, chunkRows);

        List<MetricsWriter.MetricUpsert> metricRows = new ArrayList<>();
        int anomalousWindows = 0;
        for (LogWindow window : windows) {
            if (window.isAnomalous()) {
                anomalousWindows++;
            }
            for (MetricRow row : metricsByWindow.get(window)) {
                metricRows.add(new MetricsWriter.MetricUpsert(
                    window.timeBucket(), row.category(), row.metric(),
                    row.count(), row.sumMs(), row.avgMs(), row.p95Ms(), window.chunkId()));
            }
        }
        metricsWriter.upsert(sessionId, metricRows);

        // Enrichment fan-out: total_windows is the number of LLM work items (one
        // per anomalous window + one per embedding batch), NOT the raw window
        // count — that is what the Phase-3 completion counter counts down. Set it
        // (and flip to ENRICHING) BEFORE producing so any fast consumer sees a
        // correct target the moment items land.
        int workItems = enrichProducer.workItemCount(windows);
        sessionRepository.setTotalWindows(sessionId, workItems);
        sessionRepository.setStatus(sessionId, AnalysisStatus.ENRICHING);
        enrichProducer.produce(sessionId, windows);

        fileStorageService.delete(request.fileUrl());
        documentRepository.markCompleted(documentId, Instant.now());

        // Nothing to enrich (no anomalies and embeddings disabled) → no work items
        // will ever drive the counter, so advance the session to CORRELATING here.
        if (workItems == 0) {
            enrichCompletion.checkAndTrigger(sessionId);
        }

        log.info("Ingest complete: session={} document={} windows={} anomalous={} workItems={} metricRows={}",
            sessionId, documentId, windows.size(), anomalousWindows, workItems, metricRows.size());
    }

    private List<String> readAllLines(String fileUrl) {
        List<String> lines = new ArrayList<>();
        try (InputStream in = fileStorageService.openStream(fileUrl);
             BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                lines.add(line);
            }
        } catch (IOException e) {
            throw new UncheckedIOException("Failed streaming staged file " + fileUrl, e);
        }
        return lines;
    }
}
