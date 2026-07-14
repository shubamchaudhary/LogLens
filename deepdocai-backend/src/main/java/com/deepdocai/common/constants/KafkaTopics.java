package com.deepdocai.common.constants;

/**
 * Central registry of Kafka topic names so producers and consumers never
 * duplicate string literals. Topics themselves are declared as {@code NewTopic}
 * beans in the enrich configuration (Phase 3); Phase 1 relies on broker
 * auto-creation for {@link #LOG_INGEST_REQUESTS}.
 */
public final class KafkaTopics {

    private KafkaTopics() {
    }

    /** Upload accepted → request ingest/chunking. Key = sessionId. */
    public static final String LOG_INGEST_REQUESTS = "log.ingest.requests";
}
