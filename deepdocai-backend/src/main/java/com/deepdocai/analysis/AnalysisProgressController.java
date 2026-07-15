package com.deepdocai.analysis;

import com.deepdocai.data.entity.Session;
import com.deepdocai.data.repository.SessionRepository;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Collectors;

/**
 * Live analysis-progress stream. A client opens an {@link SseEmitter} on
 * {@code GET /api/v1/sessions/{id}/progress} and receives {@code {status, enriched, total}}
 * updates until the session reaches {@code DONE} or {@code FAILED}.
 *
 * <p>Rather than one polling thread per connection, a single
 * {@link Scheduled} task sweeps every open emitter on a fixed delay, reads the
 * current session rows once, and pushes only when something changed. Ownership is
 * enforced up front; denied requests get the exact status ({@code 403}/{@code 404})
 * with no stream opened.
 */
@RestController
@RequestMapping("/api/v1/sessions")
@RequiredArgsConstructor
@Slf4j
public class AnalysisProgressController {

    /** Cap a stream's lifetime so a wedged session can't leak an emitter forever. */
    private static final long EMITTER_TIMEOUT_MS = 10 * 60 * 1000L;

    private final SessionAccess access;
    private final SessionRepository sessionRepository;

    private final CopyOnWriteArrayList<Sub> subs = new CopyOnWriteArrayList<>();

    /** One open subscription: which session, the emitter, and the last signature sent. */
    private record Sub(UUID sessionId, SseEmitter emitter, AtomicReference<String> lastSig) {
    }

    @GetMapping("/{id}/progress")
    public SseEmitter progress(@PathVariable UUID id, Authentication authentication, HttpServletResponse response) {
        SessionAccess.Result a = access.check(id, authentication);
        if (a.denied()) {
            // No emitter: set the status and return null. Spring's SSE return-value
            // handler treats a null return as "request handled", leaving this status.
            response.setStatus(a.errorStatus().value());
            return null;
        }

        SseEmitter emitter = new SseEmitter(EMITTER_TIMEOUT_MS);
        Sub sub = new Sub(id, emitter, new AtomicReference<>(""));
        subs.add(sub);
        emitter.onCompletion(() -> subs.remove(sub));
        emitter.onTimeout(() -> {
            subs.remove(sub);
            emitter.complete();
        });
        emitter.onError(e -> subs.remove(sub));

        // Push an immediate snapshot so the client sees current state without
        // waiting for the next sweep. Also completes right away if already terminal.
        push(sub, a.session());
        return emitter;
    }

    @Scheduled(fixedDelay = 1500)
    public void sweep() {
        if (subs.isEmpty()) {
            return;
        }
        Set<UUID> ids = subs.stream().map(Sub::sessionId).collect(Collectors.toSet());
        Map<UUID, Session> current = new HashMap<>();
        sessionRepository.findAllById(ids).forEach(s -> current.put(s.getId(), s));
        for (Sub sub : subs) {
            Session s = current.get(sub.sessionId());
            if (s != null) {
                push(sub, s);
            }
        }
    }

    /**
     * Emit one progress event for a subscription if state changed, and complete
     * the stream when the session is terminal. Synchronized on the emitter so the
     * initial snapshot and the sweep never write concurrently.
     */
    private void push(Sub sub, Session s) {
        String status = s.getAnalysisStatus().name();
        int enriched = s.getEnrichedWindows() == null ? 0 : s.getEnrichedWindows();
        int total = s.getTotalWindows() == null ? 0 : s.getTotalWindows();
        boolean terminal = "DONE".equals(status) || "FAILED".equals(status);
        String sig = status + ":" + enriched + ":" + total;

        synchronized (sub.emitter()) {
            if (sig.equals(sub.lastSig().get()) && !terminal) {
                return;
            }
            try {
                sub.emitter().send(SseEmitter.event()
                    .name("progress")
                    .data(Map.of("status", status, "enriched", enriched, "total", total)));
                sub.lastSig().set(sig);
                if (terminal) {
                    sub.emitter().complete();
                }
            } catch (Exception e) {
                // Client went away or the emitter is already closed — drop it.
                subs.remove(sub);
            }
        }
    }

    /** Package-visible for readability; not part of the public API. */
    List<Sub> openSubscriptions() {
        return List.copyOf(subs);
    }
}
