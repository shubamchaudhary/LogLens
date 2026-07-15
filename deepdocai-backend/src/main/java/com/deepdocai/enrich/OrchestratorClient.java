package com.deepdocai.enrich;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Fire-and-forget trigger for the Python LangGraph orchestrator (Graph 1).
 * Called once, by the single thread that wins the ENRICHING→CORRELATING flip,
 * to hand a fully-enriched session off for correlation and reporting.
 *
 * <p>Best-effort with a few short retries: if the orchestrator is unreachable we
 * log and move on rather than wedge the Kafka consumer — the session is already
 * durably CORRELATING and can be re-triggered.
 */
@Component
@Slf4j
public class OrchestratorClient {

    private static final int MAX_ATTEMPTS = 3;
    private static final Duration DRILLDOWN_TIMEOUT = Duration.ofSeconds(120);

    private final WebClient webClient;

    public OrchestratorClient(WebClient.Builder webClientBuilder,
                              @Value("${chunkai.orchestrator.url}") String baseUrl) {
        this.webClient = webClientBuilder.baseUrl(baseUrl).build();
    }

    public void analyze(UUID sessionId) {
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                webClient.post()
                    .uri("/analyze/{sessionId}", sessionId)
                    .retrieve()
                    .toBodilessEntity()
                    .block();
                log.info("Triggered orchestrator /analyze/{}", sessionId);
                return;
            } catch (Exception e) {
                log.warn("orchestrator /analyze/{} attempt {}/{} failed: {}",
                    sessionId, attempt, MAX_ATTEMPTS, e.toString());
                if (attempt < MAX_ATTEMPTS) {
                    sleepQuietly(500L * attempt);
                }
            }
        }
        log.error("Gave up triggering orchestrator for session {} after {} attempts "
            + "(session remains CORRELATING and can be re-triggered)", sessionId, MAX_ATTEMPTS);
    }

    private static void sleepQuietly(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Synchronous drill-down proxy (Graph 2). Unlike {@link #analyze(UUID)} this
     * is request/response — the caller (query API) forwards the user's question
     * and returns the cited answer — so failures propagate to the caller to map
     * onto an HTTP status rather than being swallowed.
     */
    public DrilldownResult drilldown(UUID sessionId, String question) {
        return webClient.post()
            .uri("/drilldown")
            .bodyValue(Map.of("session_id", sessionId.toString(), "question", question))
            .retrieve()
            .bodyToMono(DrilldownResult.class)
            .block(DRILLDOWN_TIMEOUT);
    }

    /** Orchestrator drill-down answer: prose grounded in the cited chunk ids. */
    public record DrilldownResult(String answer, List<String> citations) {
    }
}
