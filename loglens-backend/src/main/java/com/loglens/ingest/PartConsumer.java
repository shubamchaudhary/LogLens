package com.loglens.ingest;

import com.loglens.common.messages.IngestPartRequest;
import com.loglens.ingest.model.LogWindow;
import com.loglens.ingest.model.MetricRow;
import com.loglens.ingest.parser.LogWindowParser;
import com.loglens.storage.FileStorageService;
import com.loglens.storage.SessionChunkRepository;
import com.loglens.data.repository.DocumentRepository;
import lombok.extern.slf4j.Slf4j;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Processes ONE virtual part of a staged file, in parallel with its siblings.
 * Reads only its byte slice via a ranged GET (O(one part) heap), chunks it into
 * time windows, runs the Layer-1 parsers, applies LOCAL anomaly rules, then commits
 * everything in ONE short transaction whose first act is inserting the part marker:
 * a redelivered part hits the marker's PK conflict and skips all writes — an
 * exactly-once EFFECT on Kafka's at-least-once delivery. The last part to complete
 * triggers the {@link IngestFinalizer}.
 */
@Component
@Slf4j
public class PartConsumer {

    private final FileStorageService fileStorageService;
    private final TimeWindowChunker chunker;
    private final List<LogWindowParser> parsers;
    private final AnomalyDetector anomalyDetector;
    private final MetricsWriter metricsWriter;
    private final SessionChunkRepository chunkRepository;
    private final IngestPartRepository partRepository;
    private final DocumentRepository documentRepository;
    private final IngestFinalizer finalizer;
    private final TransactionTemplate txTemplate;

    public PartConsumer(
        FileStorageService fileStorageService,
        TimeWindowChunker chunker,
        List<LogWindowParser> parsers,
        AnomalyDetector anomalyDetector,
        MetricsWriter metricsWriter,
        SessionChunkRepository chunkRepository,
        IngestPartRepository partRepository,
        DocumentRepository documentRepository,
        IngestFinalizer finalizer,
        PlatformTransactionManager txManager
    ) {
        this.fileStorageService = fileStorageService;
        this.chunker = chunker;
        this.parsers = parsers;
        this.anomalyDetector = anomalyDetector;
        this.metricsWriter = metricsWriter;
        this.chunkRepository = chunkRepository;
        this.partRepository = partRepository;
        this.documentRepository = documentRepository;
        this.finalizer = finalizer;
        this.txTemplate = new TransactionTemplate(txManager);
    }

    // Parallel part processing: N threads over the 6 partitions. Bounded so peak
    // heap stays modest on a small box — each in-flight part holds only its ~5 MB
    // slice, so N × (slice + parse overhead) is the memory ceiling, not the file.
    @KafkaListener(topics = "#{T(com.loglens.common.constants.KafkaTopics).LOG_INGEST_PARTS}",
        groupId = "ingest-part-workers",
        concurrency = "${loglens.ingest.part-concurrency:3}")
    public void onPart(IngestPartRequest part, Acknowledgment ack) {
        process(part);
        ack.acknowledge();
    }

    private void process(IngestPartRequest part) {
        UUID sessionId = part.sessionId();
        UUID documentId = part.documentId();
        long length = part.byteEndExclusive() - part.byteStart();

        if (partRepository.isProcessed(documentId, part.partIdx())) {
            log.info("Part {}:{} already processed — skipping before any read (redelivery/replay)",
                documentId, part.partIdx());
            finalizer.tryFinalize(sessionId, documentId, part.fileUrl());
            return;
        }

        // --- slow work OUTSIDE any transaction: ranged read + chunk + parse ---
        List<String> lines = readSlice(part.fileUrl(), part.byteStart(), length);
        long lineOffset = part.firstLineNumber() - 1; // slice line 1 → global firstLineNumber
        List<LogWindow> windows = chunker.chunk(lines, lineOffset);
        for (LogWindow w : windows) {
            w.setChunkId(UUID.randomUUID());
        }

        Map<LogWindow, List<MetricRow>> metricsByWindow = new LinkedHashMap<>();
        for (LogWindow w : windows) {
            List<MetricRow> rows = new ArrayList<>();
            for (LogWindowParser parser : parsers) {
                rows.addAll(parser.parse(w));
            }
            metricsByWindow.put(w, rows);
        }
        anomalyDetector.detectLocal(windows); // p95 rule deferred to the finalizer

        List<SessionChunkRepository.NewChunk> chunkRows = new ArrayList<>(windows.size());
        for (LogWindow w : windows) {
            chunkRows.add(new SessionChunkRepository.NewChunk(
                w.chunkId(), documentId, w.timeBucket(),
                (int) (w.lineStart() + lineOffset), (int) (w.lineEnd() + lineOffset),
                w.content(), w.isAnomalous()));
        }
        List<MetricsWriter.MetricUpsert> metricRows = new ArrayList<>();
        for (LogWindow w : windows) {
            for (MetricRow row : metricsByWindow.get(w)) {
                metricRows.add(new MetricsWriter.MetricUpsert(
                    w.timeBucket(), row.category(), row.metric(),
                    row.count(), row.sumMs(), row.avgMs(), row.p95Ms(), w.chunkId()));
            }
        }

        // --- ONE short transaction: marker + chunks + metrics + counter ---
        Boolean processed = txTemplate.execute(status -> {
            if (!partRepository.claimPart(documentId, part.partIdx())) {
                log.info("Part {}:{} already processed — skipping (redelivery)", documentId, part.partIdx());
                return Boolean.FALSE;
            }
            chunkRepository.insertBatch(sessionId, chunkRows);
            metricsWriter.upsert(sessionId, metricRows);
            documentRepository.incrementParsedParts(documentId);
            return Boolean.TRUE;
        });

        if (Boolean.TRUE.equals(processed)) {
            log.info("Part {}:{} done — {} windows, {} metric rows (lines {}..)",
                documentId, part.partIdx(), windows.size(), metricRows.size(), part.firstLineNumber());
        }
        // ALWAYS attempt finalize — even for a redelivered (already-processed) part.
        // If the last part committed but crashed before finalizing, its redelivery
        // skips the writes yet must still trigger the finalizer. tryFinalize's atomic
        // claim makes this a no-op unless this caller is the one that completes it.
        finalizer.tryFinalize(sessionId, documentId, part.fileUrl());
    }

    /** Longest line kept per log line; the rest is dropped with a marker (a 100 MB line would OOM the part). */
    static final int MAX_LINE_CHARS = 64 * 1024;

    private List<String> readSlice(String fileUrl, long offset, long length) {
        List<String> lines = new ArrayList<>();
        try (InputStream in = fileStorageService.openStream(fileUrl, offset, length);
             BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = readBoundedLine(reader)) != null) {
                // Postgres TEXT cannot store NUL (0x00): one binary byte used to fail the whole part.
                lines.add(line.indexOf('\u0000') >= 0 ? line.replace('\u0000', '\uFFFD') : line);
            }
        } catch (IOException e) {
            throw new UncheckedIOException("Failed ranged read of " + fileUrl
                + " [" + offset + "," + (offset + length) + ")", e);
        }
        return lines;
    }

    /** readLine() that never holds more than MAX_LINE_CHARS of one line. */
    static String readBoundedLine(BufferedReader reader) throws IOException {
        StringBuilder sb = null;
        long dropped = 0;
        int c;
        while ((c = reader.read()) != -1) {
            if (sb == null) {
                sb = new StringBuilder(128);
            }
            if (c == '\n') {
                break;
            }
            if (sb.length() < MAX_LINE_CHARS) {
                sb.append((char) c);
            } else {
                dropped++;
            }
        }
        if (sb == null) {
            return null;
        }
        int len = sb.length();
        if (len > 0 && sb.charAt(len - 1) == '\r') {
            sb.setLength(len - 1);
        }
        if (dropped > 0) {
            sb.append(" ...[truncated ").append(dropped).append(" chars]");
        }
        return sb.toString();
    }
}
