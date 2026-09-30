package com.loglens.common.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.concurrent.CompletableFuture;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.header.Header;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer;
import org.springframework.kafka.listener.ListenerExecutionFailedException;

class BoundedExceptionHeadersTest {

    /** A JDBC batch failure quotes the bound values: here a 14 MB chunk, like a busy minute. */
    private static Exception hugeFailure() {
        String sqlWithValues = "Batch entry 0 INSERT INTO log_chunks_s_x VALUES ('" + "x".repeat(14_000_000) + "')";
        RuntimeException jdbc = new RuntimeException("ERROR: string is too long for tsvector; " + sqlWithValues);
        RuntimeException spring = new RuntimeException("PreparedStatementCallback; " + sqlWithValues, jdbc);
        return new ListenerExecutionFailedException("Listener method threw exception", spring);
    }

    private static int headerBytes(DeadLetterPublishingRecoverer.ExceptionHeadersCreator creator) {
        @SuppressWarnings("unchecked")
        KafkaTemplate<Object, Object> template = mock(KafkaTemplate.class);
        when(template.send(any(ProducerRecord.class))).thenReturn(CompletableFuture.completedFuture(null));
        DeadLetterPublishingRecoverer recoverer = new DeadLetterPublishingRecoverer(
            template, (r, e) -> new TopicPartition("log.ingest.dlq", 0));
        if (creator != null) {
            recoverer.setExceptionHeadersCreator(creator);
        }
        recoverer.accept(new ConsumerRecord<>("log.ingest.parts", 2, 300L, "doc:0", "{\"partIdx\":0}"), hugeFailure());
        @SuppressWarnings({"unchecked", "rawtypes"})
        ArgumentCaptor<ProducerRecord<Object, Object>> sent = ArgumentCaptor.forClass((Class) ProducerRecord.class);
        verify(template).send(sent.capture());
        int total = 0;
        for (Header h : sent.getValue().headers()) {
            total += h.key().length() + (h.value() == null ? 0 : h.value().length);
        }
        return total;
    }

    @Test
    void springDefaultHeadersExceedKafkasOneMegabyteLimit() {
        int bytes = headerBytes(null);
        System.out.println("DLQ exception header bytes, Spring default: " + bytes);
        assertTrue(bytes > 1_048_576, "the default copies the whole message into the DLQ record");
    }

    @Test
    void boundedHeadersKeepTheDlqRecordSmall() {
        int bytes = headerBytes(new BoundedExceptionHeaders());
        System.out.println("DLQ exception header bytes, bounded: " + bytes);
        assertTrue(bytes < 32 * 1024, "DLQ exception headers were " + bytes + " bytes");
    }

    @Test
    void compactTraceKeepsEveryCauseClassWithShortMessages() {
        String trace = BoundedExceptionHeaders.compactTrace(hugeFailure());
        assertTrue(trace.startsWith(ListenerExecutionFailedException.class.getName()));
        assertEquals(2, trace.split("Caused by: java.lang.RuntimeException").length - 1);
        assertTrue(trace.contains("...[truncated "));
    }
}
