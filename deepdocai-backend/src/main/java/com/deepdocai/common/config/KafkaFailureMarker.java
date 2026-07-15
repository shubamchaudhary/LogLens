package com.deepdocai.common.config;

import com.deepdocai.common.constants.KafkaTopics;
import com.deepdocai.common.messages.IngestRequest;
import com.deepdocai.data.repository.DocumentRepository;
import com.deepdocai.data.repository.SessionRepository;
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
            }
        } catch (Exception inner) {
            log.error("Failure marker could not record consumer failure for topic {}", record.topic(), inner);
        }
    }

    private IngestRequest parseIngest(Object value) throws Exception {
        if (value instanceof IngestRequest ir) {
            return ir;
        }
        if (value instanceof String s) {
            return objectMapper.readValue(s, IngestRequest.class);
        }
        if (value instanceof byte[] bytes) {
            return objectMapper.readValue(bytes, IngestRequest.class);
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

    private static String truncate(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }
}
