package com.deepdocai.enrich;

import com.deepdocai.common.messages.EnrichRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;

/**
 * Drains the 429 back-off lane. This is a dedicated single-thread container whose
 * whole job is to hold a throttled work item until its {@code notBeforeEpochMs}
 * deadline, then re-release it to {@code llm.enrich.requests}. Sleeping here keeps
 * the fast {@link EnrichConsumer} worker threads free to make progress on other
 * partitions instead of blocking 60s on a rate-limited key.
 *
 * <p>Single-threaded (concurrency=1) so retries drain roughly in deadline order;
 * manual ack after re-publish preserves at-least-once.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class RetryConsumer {

    private final EnrichProducer enrichProducer;

    @KafkaListener(
        topics = "#{T(com.deepdocai.common.constants.KafkaTopics).LLM_ENRICH_RETRY_60S}",
        groupId = "llm-retry",
        concurrency = "1")
    public void onRetry(EnrichRequest request, Acknowledgment ack) {
        long waitMs = request.notBeforeEpochMs() - System.currentTimeMillis();
        if (waitMs > 0) {
            try {
                Thread.sleep(waitMs);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new RuntimeException("Interrupted while holding retry for work " + request.workId(), e);
            }
        }
        enrichProducer.send(request);
        log.info("Re-released work {} ({}) to enrich lane (attempt {})",
            request.workId(), request.kind(), request.attempt());
        ack.acknowledge();
    }
}
