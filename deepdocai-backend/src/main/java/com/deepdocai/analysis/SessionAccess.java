package com.deepdocai.analysis;

import com.deepdocai.data.entity.Session;
import com.deepdocai.data.repository.SessionRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Component;

import java.util.Optional;
import java.util.UUID;

/**
 * Shared session-ownership guard for the analysis read/query endpoints.
 *
 * <p>Every analysis endpoint must confirm the caller owns the session before
 * returning any of its data. This helper centralises that check and reports the
 * exact HTTP status to use — {@code 404} when the session does not exist and
 * {@code 403} when it exists but belongs to another user — so callers stay
 * uniform and never leak one user's analysis to another.
 *
 * <p>The check is returned rather than thrown on purpose: the app's
 * {@code GlobalExceptionHandler} has a catch-all {@code @ExceptionHandler(Exception.class)}
 * that maps any thrown exception to 500, which would clobber a 403/404. Returning
 * a {@link Result} lets controllers emit the precise status via {@code ResponseEntity}.
 */
@Component
@RequiredArgsConstructor
public class SessionAccess {

    private final SessionRepository sessionRepository;

    @org.springframework.beans.factory.annotation.Value("${chunkai.guest.session-id:}")
    private String guestSessionId;

    /**
     * Resolve whether {@code authentication} may access {@code sessionId}.
     *
     * @return a granted {@link Result} carrying the session, or a denied result
     *         carrying {@link HttpStatus#NOT_FOUND} / {@link HttpStatus#FORBIDDEN}.
     */
    public Result check(UUID sessionId, Authentication authentication) {
        UUID userId = UUID.fromString(authentication.getName());
        Optional<Session> found = sessionRepository.findById(sessionId);
        if (found.isEmpty()) {
            return Result.denied(HttpStatus.NOT_FOUND);
        }
        Session session = found.get();
        // Owner always has access.
        if (session.getUserId().equals(userId)) {
            return Result.granted(session);
        }
        // Guest user may access the designated demo session.
        if (guestSessionId != null && !guestSessionId.isBlank()
                && sessionId.toString().equals(guestSessionId)) {
            return Result.granted(session);
        }
        return Result.denied(HttpStatus.FORBIDDEN);
    }

    /** Outcome of an ownership check: either a granted session or a denial status. */
    public record Result(Session session, HttpStatus errorStatus) {

        static Result granted(Session session) {
            return new Result(session, null);
        }

        static Result denied(HttpStatus status) {
            return new Result(null, status);
        }

        public boolean denied() {
            return session == null;
        }
    }
}
