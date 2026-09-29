package com.loglens.ingest;

import com.loglens.common.constants.AnalysisStatus;
import com.loglens.common.constants.KafkaTopics;
import com.loglens.common.constants.ProcessingStatus;
import com.loglens.common.messages.IngestPartRequest;
import com.loglens.common.messages.IngestRequest;
import com.loglens.data.entity.Document;
import com.loglens.data.repository.DocumentRepository;
import com.loglens.data.repository.SessionRepository;
import com.loglens.enrich.EnrichCompletion;
import com.loglens.storage.FileStorageService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Partitioned-ingest entry point (replaces the old whole-file IngestConsumer).
 * Makes ONE streaming pass over the staged blob — holding only the current line,
 * O(1) heap regardless of file size — recording <b>window-aligned byte ranges</b>
 * ("virtual parts"). It writes nothing back to blob; it produces K tiny
 * {@link IngestPartRequest} pointers to {@code log.ingest.parts}, which parallel
 * part consumers process via ranged GETs.
 *
 * <p>A cut is placed at a window boundary (a line whose minute-bucket differs from
 * the previous line's) once ~{@code part-target-bytes} have accumulated; cuts land
 * only on record starts, so a multi-line stack trace never straddles two parts.
 * Files with no timestamps fall back to fixed line-count parts.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class IngestSplitter {

    private final SessionRepository sessionRepository;
    private final DocumentRepository documentRepository;
    private final FileStorageService fileStorageService;
    private final TimeWindowChunker chunker;
    private final EnrichCompletion enrichCompletion;
    private final KafkaTemplate<String, Object> kafkaTemplate;

    @Value("${loglens.ingest.part-target-bytes:5242880}")
    private long partTargetBytes;

    @Value("${loglens.ingest.fallback-lines-per-part:5000}")
    private int fallbackLinesPerPart;

    /**
     * Bytes of one line kept for timestamp detection. Longer lines are still
     * counted byte-for-byte (offsets stay exact) but not buffered, so one huge
     * line cannot grow the heap: the splitter stays O(1 MB), not O(longest line).
     */
    static final int MAX_LINE_BUFFER = 1 << 20;

    /** A computed virtual part: a byte range plus the global line number it starts at. */
    private record Part(long byteStart, long byteEndExclusive, long firstLineNumber) {
    }

    @KafkaListener(topics = "#{T(com.loglens.common.constants.KafkaTopics).LOG_INGEST_REQUESTS}",
        groupId = "ingest-workers")
    public void onIngest(IngestRequest request, Acknowledgment ack) {
        log.info("Ingest (split) request: session={} document={}", request.sessionId(), request.documentId());
        try {
            process(request);
        } catch (RuntimeException e) {
            log.error("Splitting failed for session={} document={}: {}",
                request.sessionId(), request.documentId(), e.getMessage(), e);
            documentRepository.markFailed(request.documentId(), truncate(e.getMessage()));
            sessionRepository.setFailed(request.sessionId(), "Ingest failed: " + truncate(e.getMessage()));
        }
        ack.acknowledge();
    }

    private void process(IngestRequest request) {
        UUID sessionId = request.sessionId();
        UUID documentId = request.documentId();

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

        sessionRepository.setStatus(sessionId, AnalysisStatus.CHUNKING);

        List<Part> parts = computeParts(request.fileUrl());

        if (parts.isEmpty()) {
            // Empty file: nothing to parse or enrich. Complete straight to DONE-path.
            log.info("Empty file for session={} document={} — completing with no parts", sessionId, documentId);
            documentRepository.setTotalPartsProcessing(documentId, 0);
            documentRepository.markStagedDeleted(documentId, Instant.now());
            fileStorageService.delete(request.fileUrl());
            sessionRepository.setTotalWindows(sessionId, 0);
            sessionRepository.setStatus(sessionId, AnalysisStatus.ENRICHING);
            enrichCompletion.checkAndTrigger(sessionId);
            return;
        }

        // Record the completion target BEFORE producing — the finalizer's atomic
        // claim (parsed_parts == total_parts) needs total_parts to already exist.
        documentRepository.setTotalPartsProcessing(documentId, parts.size());
        sessionRepository.setStatus(sessionId, AnalysisStatus.PARSING);

        for (int i = 0; i < parts.size(); i++) {
            Part p = parts.get(i);
            IngestPartRequest msg = new IngestPartRequest(
                sessionId, request.userId(), documentId, request.fileUrl(),
                i, parts.size(), p.byteStart(), p.byteEndExclusive(), p.firstLineNumber());
            // Key = documentId:partIdx so a document's parts SPREAD across partitions.
            kafkaTemplate.send(KafkaTopics.LOG_INGEST_PARTS, documentId + ":" + i, msg);
        }

        log.info("Split session={} document={} into {} part(s)", sessionId, documentId, parts.size());
    }

    /**
     * The streaming pass: read the object once, tracking absolute byte offsets and
     * timestamp buckets line by line, emitting window-aligned cuts. O(one line) heap.
     */
    private List<Part> computeParts(String fileUrl) {
        List<Part> parts = new ArrayList<>();
        long offset = 0;             // byte position of the START of the current line
        long lineNumber = 1;         // 1-based
        long partStartByte = 0;
        long partStartLine = 1;
        long bytesSinceCut = 0;
        long linesSinceCut = 0;
        boolean anyTimestamp = false;
        Instant prevBucket = null;

        try (InputStream raw = fileStorageService.openStream(fileUrl);
             BufferedInputStream in = new BufferedInputStream(raw, 1 << 16)) {
            ByteArrayOutputStream lineBuf = new ByteArrayOutputStream(256);
            int b;
            boolean pending = false; // bytes read for a line not yet flushed
            long overflow = 0;       // bytes of the current line beyond MAX_LINE_BUFFER
            in.mark(4);
            byte[] magic = in.readNBytes(4);
            in.reset();
            if (magic.length >= 2 && (magic[0] & 0xff) == 0x1f && (magic[1] & 0xff) == 0x8b
                || magic.length == 4 && magic[0] == 'P' && magic[1] == 'K' && magic[2] == 3 && magic[3] == 4) {
                // Byte ranges of a compressed stream are meaningless; fail with a reason, not garbage.
                throw new IllegalArgumentException(
                    "Compressed archive (gzip/zip) is not supported: upload the plain-text log");
            }
            while ((b = in.read()) != -1) {
                pending = true;
                if (b == '\n') {
                    long byteLen = lineBuf.size() + overflow + 1L; // include the newline
                    overflow = 0;
                    String text = lineBuf.toString(StandardCharsets.UTF_8);
                    lineBuf.reset();
                    // --- process one line ---
                    Instant ts = chunker.extractTimestamp(text);
                    Instant bucket = ts != null ? chunker.bucketOf(ts) : null;
                    boolean recordStart = (ts != null) || !anyTimestamp;
                    boolean windowBoundary = bucket != null && prevBucket != null && !bucket.equals(prevBucket);
                    if (linesSinceCut > 0 && recordStart) {
                        boolean cut =
                            (anyTimestamp && windowBoundary && bytesSinceCut >= partTargetBytes)
                            || (!anyTimestamp && linesSinceCut >= fallbackLinesPerPart)
                            || (bytesSinceCut >= partTargetBytes * 4L);
                        if (cut) {
                            parts.add(new Part(partStartByte, offset, partStartLine));
                            partStartByte = offset;
                            partStartLine = lineNumber;
                            bytesSinceCut = 0;
                            linesSinceCut = 0;
                        }
                    }
                    if (bucket != null) {
                        prevBucket = bucket;
                    }
                    if (ts != null) {
                        anyTimestamp = true;
                    }
                    offset += byteLen;
                    bytesSinceCut += byteLen;
                    linesSinceCut++;
                    lineNumber++;
                    pending = false;
                } else if (lineBuf.size() < MAX_LINE_BUFFER) {
                    lineBuf.write(b);
                } else {
                    overflow++;
                }
            }
            // Trailing line with no final newline.
            if (pending && lineBuf.size() + overflow > 0) {
                long byteLen = lineBuf.size() + overflow;
                offset += byteLen;
                bytesSinceCut += byteLen;
            }
        } catch (IOException e) {
            throw new UncheckedIOException("Failed streaming staged file " + fileUrl, e);
        }

        if (offset > partStartByte) {
            parts.add(new Part(partStartByte, offset, partStartLine));
        }
        return parts;
    }

    private static String truncate(String s) {
        if (s == null) {
            return "unknown error";
        }
        return s.length() > 500 ? s.substring(0, 500) : s;
    }
}
