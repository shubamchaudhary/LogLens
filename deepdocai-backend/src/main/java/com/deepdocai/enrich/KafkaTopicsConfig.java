package com.deepdocai.enrich;

import com.deepdocai.common.constants.KafkaTopics;
import com.deepdocai.llm.key.ApiKeyManager;
import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;

/**
 * Declares the pipeline's Kafka topics as {@link NewTopic} beans so the embedded
 * {@code KafkaAdmin} provisions them on boot (partition counts can only be raised
 * this way, never lowered).
 *
 * <p>The enrichment lanes have one partition per Gemini API key
 * ({@link ApiKeyManager#getSlotCount()}): each partition is consumed by exactly
 * one worker thread bound to one key, which is what makes the 7.5s per-key pacing
 * lock-free. The retry lane mirrors that width; the dead-letter lanes are single
 * partition (low volume, order irrelevant).
 */
@Configuration
public class KafkaTopicsConfig {

    private final int slotCount;

    public KafkaTopicsConfig(ApiKeyManager apiKeyManager) {
        this.slotCount = apiKeyManager.getSlotCount();
    }

    @Bean
    public NewTopic logIngestRequestsTopic() {
        return TopicBuilder.name(KafkaTopics.LOG_INGEST_REQUESTS).partitions(6).replicas(1).build();
    }

    @Bean
    public NewTopic logIngestDlqTopic() {
        return TopicBuilder.name(KafkaTopics.LOG_INGEST_DLQ).partitions(1).replicas(1).build();
    }

    @Bean
    public NewTopic llmEnrichRequestsTopic() {
        return TopicBuilder.name(KafkaTopics.LLM_ENRICH_REQUESTS).partitions(slotCount).replicas(1).build();
    }

    @Bean
    public NewTopic llmEnrichRetryTopic() {
        return TopicBuilder.name(KafkaTopics.LLM_ENRICH_RETRY_60S).partitions(slotCount).replicas(1).build();
    }

    @Bean
    public NewTopic llmEnrichDlqTopic() {
        return TopicBuilder.name(KafkaTopics.LLM_ENRICH_DLQ).partitions(1).replicas(1).build();
    }
}
