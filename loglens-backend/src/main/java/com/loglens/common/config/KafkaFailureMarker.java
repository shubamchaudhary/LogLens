package com.loglens.common.config;

import com.loglens.common.constants.KafkaTopics;
import com.loglens.common.messages.IngestPartRequest;
import com.loglens.common.messages.IngestRequest;
import com.loglens.data.repository.DocumentRepository;
import com.loglens.data.repository.SessionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.springframework.kafka.listener.ListenerExecutionFailedException;
import org.springframework.stereotype.Component;

/**
 * Best-effort bridge from a dead-lettered consumer record to a durable
 * {@code FAILED} status on the owning session/document. When the ingest lane
 * exhausts its retries, this records <em>why</em> in the database (more useful to
 * an operator than a raw DLQ record) before the poison message is parked on the
 * dead-letter topic.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class KafkaFailureMarker {

    private final SessionRepository sessionRepository;
    private final DocumentRepository documentRepository;
    private final ObjectMapper objectMapper;

    public void mark(ConsumerRecord<?, ?> record, Exception ex) {
        try {
            if (KafkaTopics.LOG_INGEST_REQUESTS.equals(record.topic()) && record.value() != null) {
                IngestRequest req = parseIngest(record.value());
                if (req != null) {
                    String message = truncate("Ingest failed: " + rootMessage(ex), 1000);
                    sessionRepository.setFailed(req.sessionId(), message);
                    documentRepository.markFailed(req.documentId(), message);
                    log.warn("Marked session {} / document {} FAILED after exhausted ingest retries: {}",
                        req.sessionId(), req.documentId(), message);
                }
            } else if (KafkaTopics.LOG_INGEST_PARTS.equals(record.topic()) && record.value() != null) {
                IngestPartRequest part = parse(record.value(), IngestPartRequest.class);
                if (part != null && documentRepository.findById(part.documentId())
                        .map(d -> d.getProcessingStatus() == com.loglens.common.constants.ProcessingStatus.COMPLETED)
                        .orElse(false)) {
                    // A late failure of an already-finalized document must not undo a finished session.
                    log.warn("Ignoring failure of part {} for COMPLETED document {}: {}",
                        part.partIdx(), part.documentId(), rootMessage(ex));
                } else if (part != null) {
                    String message = truncate("Part " + part.partIdx() + " failed: " + rootMessage(ex), 1000);
                    sessionRepository.setFailed(part.sessionId(), message);
                    documentRepository.markFailed(part.documentId(), message);
                    log.warn("Marked session {} / document {} FAILED after a poison part {}: {}",
                        part.sessionId(), part.documentId(), part.partIdx(), message);
                }
            }
        } catch (Exception inner) {
            log.error("Failure marker could not record consumer failure for topic {}", record.topic(), inner);
        }
    }

    private IngestRequest parseIngest(Object value) throws Exception {
        return parse(value, IngestRequest.class);
    }

    private <T> T parse(Object value, Class<T> type) throws Exception {
        if (type.isInstance(value)) {
            return type.cast(value);
        }
        if (value instanceof String s) {
            return objectMapper.readValue(s, type);
        }
        if (value instanceof byte[] bytes) {
            return objectMapper.readValue(bytes, type);
        }
        return null;
    }

    private static String rootMessage(Throwable ex) {
        Throwable cause = ex;
        while (cause instanceof ListenerExecutionFailedException && cause.getCause() != null) {
            cause = cause.getCause();
        }
        String msg = cause.getMessage();
        return msg != null ? msg : cause.getClass().getSimpleName();
    }

    /**
     * Truncates and makes the reason storable: Postgres text rejects NUL (0x00), and a
     * failure caused by a NUL byte echoes that byte in its own message. Without this the
     * FAILED update itself fails and the session is left in PARSING forever.
     */
    static String truncate(String s, int max) {
        String safe = s.replace('\u0000', '�');
        return safe.length() <= max ? safe : safe.substring(0, max);
    }
}
