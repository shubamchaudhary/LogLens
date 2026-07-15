package com.deepdocai.common.config;

import com.deepdocai.common.constants.KafkaTopics;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.kafka.common.TopicPartition;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.kafka.support.converter.RecordMessageConverter;
import org.springframework.kafka.support.converter.StringJsonMessageConverter;
import org.springframework.util.backoff.FixedBackOff;

/**
 * Cross-cutting Kafka consumer wiring shared by every lane (ingest here, LLM
 * enrichment in Phase 3):
 * <ul>
 *   <li>a {@link StringJsonMessageConverter} so listeners deserialize JSON into
 *       their declared payload type (type headers are off on the producer side —
 *       the target type is inferred per listener method);</li>
 *   <li>a {@link DefaultErrorHandler} implementing global decision #10: retry a
 *       failed record 3 times with backoff, then park it on the matching
 *       {@code .dlq} topic (and mark the owning session/document FAILED).</li>
 * </ul>
 * Spring Boot auto-wires the single {@code RecordMessageConverter} and
 * {@code CommonErrorHandler} beans into its default listener container factory;
 * manual ack mode comes from {@code spring.kafka.listener.ack-mode=MANUAL}.
 */
@Configuration
public class KafkaConsumerConfig {

    @Bean
    public RecordMessageConverter jsonMessageConverter(ObjectMapper objectMapper) {
        return new StringJsonMessageConverter(objectMapper);
    }

    @Bean
    public DefaultErrorHandler kafkaErrorHandler(
        KafkaTemplate<String, Object> kafkaTemplate,
        KafkaFailureMarker failureMarker
    ) {
        DeadLetterPublishingRecoverer dlqPublisher = new DeadLetterPublishingRecoverer(
            kafkaTemplate,
            (record, ex) -> new TopicPartition(dlqTopicFor(record.topic()), 0));

        DefaultErrorHandler handler = new DefaultErrorHandler(
            (record, ex) -> {
                failureMarker.mark(record, ex);
                dlqPublisher.accept(record, ex);
            },
            new FixedBackOff(2000L, 2L)); // 3 delivery attempts total
        handler.setCommitRecovered(true);
        return handler;
    }

    /** Maps a source topic to its dead-letter topic per the Phase-3 topic table. */
    private static String dlqTopicFor(String sourceTopic) {
        return switch (sourceTopic) {
            case KafkaTopics.LOG_INGEST_REQUESTS -> KafkaTopics.LOG_INGEST_DLQ;
            case KafkaTopics.LLM_ENRICH_REQUESTS, KafkaTopics.LLM_ENRICH_RETRY_60S -> KafkaTopics.LLM_ENRICH_DLQ;
            default -> sourceTopic + ".dlq";
        };
    }
}
