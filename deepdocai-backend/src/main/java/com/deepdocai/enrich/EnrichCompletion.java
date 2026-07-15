package com.deepdocai.enrich;

import com.deepdocai.data.entity.Session;
import com.deepdocai.data.repository.SessionRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.UUID;

/**
 * Decides when a session's enrichment is finished and hands it off to correlation.
 *
 * <p>Every enrichment/embedding work item — success or failure — calls
 * {@link #checkAndTrigger} after bumping {@code enriched_windows}. When the count
 * reaches {@code total_windows}, exactly one caller wins the atomic
 * ENRICHING→CORRELATING flip and triggers the orchestrator; concurrent callers on
 * the other partitions see the flip already spent and stand down. This is the only
 * place the session leaves ENRICHING on the happy path.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class EnrichCompletion {

    private final SessionRepository sessionRepository;
    private final OrchestratorClient orchestratorClient;

    public void checkAndTrigger(UUID sessionId) {
        Session session = sessionRepository.findById(sessionId).orElse(null);
        if (session == null) {
            return;
        }
        int enriched = session.getEnrichedWindows() == null ? 0 : session.getEnrichedWindows();
        int total = session.getTotalWindows() == null ? 0 : session.getTotalWindows();
        if (enriched < total) {
            return;
        }
        int won = sessionRepository.flipEnrichingToCorrelating(sessionId);
        if (won == 1) {
            log.info("Session {} enrichment complete ({}/{}) → CORRELATING", sessionId, enriched, total);
            orchestratorClient.analyze(sessionId);
        }
    }
}
