package com.deepdocai.api.controller;

import com.deepdocai.common.constants.AnalysisStatus;
import com.deepdocai.data.entity.Session;
import com.deepdocai.data.repository.SessionRepository;
import com.deepdocai.storage.SessionChunkTableManager;
import lombok.Builder;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * CRUD for sessions. Creating a session also provisions its per-session chunk
 * table; deleting a session cascades its rows (documents/metrics/findings/…)
 * via {@code ON DELETE CASCADE} and then drops the chunk table.
 */
@RestController
@RequestMapping("/api/v1/sessions")
@RequiredArgsConstructor
@Slf4j
public class SessionController {

    private final SessionRepository sessionRepository;
    private final SessionChunkTableManager chunkTableManager;

    @PostMapping
    public ResponseEntity<SessionResponse> create(
        @RequestBody(required = false) SessionRequest body,
        Authentication authentication
    ) {
        UUID userId = UUID.fromString(authentication.getName());
        String title = (body != null && body.getTitle() != null && !body.getTitle().isBlank())
            ? body.getTitle().trim() : "New Session";

        Session session = sessionRepository.save(Session.builder()
            .userId(userId)
            .title(title)
            .analysisStatus(AnalysisStatus.CREATED)
            .build());

        // Provision the chunk table via DDL, outside the entity's short transaction.
        // If it fails, roll back the just-created row so we never leave a session
        // without its backing table.
        try {
            chunkTableManager.createFor(session.getId());
        } catch (RuntimeException e) {
            sessionRepository.deleteById(session.getId());
            throw e;
        }

        log.info("Created session {} for user {}", session.getId(), userId);
        return ResponseEntity.status(HttpStatus.CREATED).body(SessionResponse.from(session));
    }

    @GetMapping
    public ResponseEntity<List<SessionResponse>> list(Authentication authentication) {
        UUID userId = UUID.fromString(authentication.getName());
        List<SessionResponse> sessions = sessionRepository.findByUserIdOrderByUpdatedAtDesc(userId)
            .stream().map(SessionResponse::from).toList();
        return ResponseEntity.ok(sessions);
    }

    @GetMapping("/{id}")
    public ResponseEntity<SessionResponse> get(@PathVariable UUID id, Authentication authentication) {
        UUID userId = UUID.fromString(authentication.getName());
        return sessionRepository.findByIdAndUserId(id, userId)
            .<ResponseEntity<SessionResponse>>map(s -> ResponseEntity.ok(SessionResponse.from(s)))
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PatchMapping("/{id}")
    public ResponseEntity<SessionResponse> rename(
        @PathVariable UUID id,
        @RequestBody SessionRequest body,
        Authentication authentication
    ) {
        UUID userId = UUID.fromString(authentication.getName());
        Optional<Session> found = sessionRepository.findByIdAndUserId(id, userId);
        if (found.isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        Session session = found.get();
        if (body != null && body.getTitle() != null && !body.getTitle().isBlank()) {
            session.setTitle(body.getTitle().trim());
            session = sessionRepository.save(session);
        }
        return ResponseEntity.ok(SessionResponse.from(session));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable UUID id, Authentication authentication) {
        UUID userId = UUID.fromString(authentication.getName());
        Optional<Session> found = sessionRepository.findByIdAndUserId(id, userId);
        if (found.isEmpty()) {
            return ResponseEntity.notFound().build();
        }

        // Remove the row first (cascades child tables), then drop the chunk table.
        sessionRepository.delete(found.get());
        chunkTableManager.dropFor(id);

        log.info("Deleted session {} for user {}", id, userId);
        return ResponseEntity.noContent().build();
    }

    @Data
    public static class SessionRequest {
        private String title;
    }

    @Data
    @Builder
    public static class SessionResponse {
        private UUID id;
        private String title;
        private AnalysisStatus analysisStatus;
        private Integer totalWindows;
        private Integer enrichedWindows;
        private String errorMessage;
        private Instant createdAt;
        private Instant updatedAt;

        static SessionResponse from(Session s) {
            return SessionResponse.builder()
                .id(s.getId())
                .title(s.getTitle())
                .analysisStatus(s.getAnalysisStatus())
                .totalWindows(s.getTotalWindows())
                .enrichedWindows(s.getEnrichedWindows())
                .errorMessage(s.getErrorMessage())
                .createdAt(s.getCreatedAt())
                .updatedAt(s.getUpdatedAt())
                .build();
        }
    }
}
