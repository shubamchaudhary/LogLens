package com.deepdocai.analysis;

import com.deepdocai.enrich.OrchestratorClient;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.reactive.function.client.WebClientResponseException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Read-side of the analysis pipeline: serves the metrics, findings, incidents,
 * report and raw evidence a session has produced, and proxies free-form
 * drill-down questions to the Python orchestrator (Graph 2).
 *
 * <p>Every endpoint is scoped to a single session and gated by {@link SessionAccess}:
 * a session that does not exist returns {@code 404}; one owned by another user
 * returns {@code 403}. The guard is returned (not thrown) because the global
 * catch-all handler would otherwise remap a thrown status to 500.
 */
@RestController
@RequestMapping("/api/v1/sessions/{id}")
@RequiredArgsConstructor
@Slf4j
public class AnalysisQueryController {

    private final SessionAccess access;
    private final AnalysisReadRepository repo;
    private final DrilldownRepository drilldownRepo;
    private final OrchestratorClient orchestrator;

    @GetMapping("/metrics")
    public ResponseEntity<?> metrics(
        @PathVariable UUID id,
        @RequestParam(required = false) String category,
        @RequestParam(required = false) String metric,
        @RequestParam(required = false) Instant from,
        @RequestParam(required = false) Instant to,
        Authentication authentication
    ) {
        SessionAccess.Result a = access.check(id, authentication);
        if (a.denied()) {
            return ResponseEntity.status(a.errorStatus()).build();
        }
        return ResponseEntity.ok(repo.metrics(id, category, metric, from, to));
    }

    @GetMapping("/findings")
    public ResponseEntity<?> findings(
        @PathVariable UUID id,
        @RequestParam(required = false) String category,
        @RequestParam(required = false) String severity,
        Authentication authentication
    ) {
        SessionAccess.Result a = access.check(id, authentication);
        if (a.denied()) {
            return ResponseEntity.status(a.errorStatus()).build();
        }
        return ResponseEntity.ok(repo.findings(id, category, severity));
    }

    @GetMapping("/incidents")
    public ResponseEntity<?> incidents(@PathVariable UUID id, Authentication authentication) {
        SessionAccess.Result a = access.check(id, authentication);
        if (a.denied()) {
            return ResponseEntity.status(a.errorStatus()).build();
        }
        return ResponseEntity.ok(repo.incidents(id));
    }

    @GetMapping("/report")
    public ResponseEntity<?> report(@PathVariable UUID id, Authentication authentication) {
        SessionAccess.Result a = access.check(id, authentication);
        if (a.denied()) {
            return ResponseEntity.status(a.errorStatus()).build();
        }
        return repo.report(id)
            .<ResponseEntity<?>>map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.noContent().build());
    }

    @GetMapping("/evidence")
    public ResponseEntity<?> evidence(
        @PathVariable UUID id,
        @RequestParam(required = false) List<UUID> chunkIds,
        Authentication authentication
    ) {
        SessionAccess.Result a = access.check(id, authentication);
        if (a.denied()) {
            return ResponseEntity.status(a.errorStatus()).build();
        }
        return ResponseEntity.ok(repo.evidence(id, chunkIds));
    }

    @PostMapping("/drilldown")
    public ResponseEntity<?> drilldown(
        @PathVariable UUID id,
        @RequestBody(required = false) DrilldownRequest body,
        Authentication authentication
    ) {
        SessionAccess.Result a = access.check(id, authentication);
        if (a.denied()) {
            return ResponseEntity.status(a.errorStatus()).build();
        }
        if (body == null || body.getQuestion() == null || body.getQuestion().isBlank()) {
            return ResponseEntity.badRequest().body("question is required");
        }
        String question = body.getQuestion().trim();
        try {
            OrchestratorClient.DrilldownResult result = orchestrator.drilldown(id, question);
            // Persist the turn so the chat survives logout/reload/device changes.
            // Best-effort: a storage hiccup must not fail the answer to the user.
            try {
                drilldownRepo.save(id, question, result.answer(), toUuids(result.citations()));
            } catch (Exception e) {
                log.warn("failed to persist drilldown turn for session {}: {}", id, e.toString());
            }
            return ResponseEntity.ok(result);
        } catch (WebClientResponseException e) {
            // Orchestrator reachable but the model call failed. A 429 means every
            // AI key is rate-limited (usually a daily quota cap) — surface it as a
            // distinct 429 so the UI can say "rate-limited, try later" instead of
            // the misleading "is the Python service running?".
            if (e.getStatusCode().value() == 429) {
                log.warn("drilldown for session {} rate-limited by orchestrator: {}", id, e.toString());
                return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                    .body("AI provider is rate-limited right now — please try again in a few minutes.");
            }
            log.warn("drilldown proxy for session {} failed: {}", id, e.toString());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                .body("drill-down is unavailable right now");
        } catch (Exception e) {
            log.warn("drilldown proxy for session {} failed: {}", id, e.toString());
            return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                .body("drill-down is unavailable right now");
        }
    }

    @GetMapping("/drilldown")
    public ResponseEntity<?> drilldownHistory(@PathVariable UUID id, Authentication authentication) {
        SessionAccess.Result a = access.check(id, authentication);
        if (a.denied()) {
            return ResponseEntity.status(a.errorStatus()).build();
        }
        return ResponseEntity.ok(drilldownRepo.history(id));
    }

    @DeleteMapping("/drilldown")
    public ResponseEntity<?> clearDrilldown(@PathVariable UUID id, Authentication authentication) {
        SessionAccess.Result a = access.check(id, authentication);
        if (a.denied()) {
            return ResponseEntity.status(a.errorStatus()).build();
        }
        drilldownRepo.clear(id);
        return ResponseEntity.noContent().build();
    }

    /** Parse orchestrator citation strings into chunk-id UUIDs, dropping any non-UUIDs. */
    private static List<UUID> toUuids(List<String> raw) {
        if (raw == null || raw.isEmpty()) {
            return List.of();
        }
        List<UUID> out = new ArrayList<>(raw.size());
        for (String s : raw) {
            try {
                out.add(UUID.fromString(s));
            } catch (IllegalArgumentException ignore) {
                // Non-UUID citation (shouldn't happen) — skip it.
            }
        }
        return out;
    }

    @Data
    public static class DrilldownRequest {
        private String question;
    }
}
