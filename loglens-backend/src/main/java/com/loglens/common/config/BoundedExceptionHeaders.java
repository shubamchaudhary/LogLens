package com.loglens.common.config;

import java.nio.charset.StandardCharsets;
import org.apache.kafka.common.header.Headers;
import org.springframework.core.NestedExceptionUtils;
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer;

/**
 * Exception headers for dead-letter records, with a size cap.
 *
 * <p>Spring's default copies the full exception message and stack trace into the DLQ
 * record. A JDBC batch failure quotes every bound value, so one 14 MB chunk produced a
 * 42 MB DLQ record: the send failed ({@code max.request.size} is 1 MB), the record was
 * never recovered, and its partition was retried forever, stalling every later upload
 * with a part on it. Here each message is capped and the trace keeps only the class,
 * a short message and the top frames of each cause.
 */
final class BoundedExceptionHeaders implements DeadLetterPublishingRecoverer.ExceptionHeadersCreator {

    static final int MAX_MESSAGE_CHARS = 4 * 1024;
    static final int MAX_CAUSE_MESSAGE_CHARS = 512;
    static final int FRAMES_PER_CAUSE = 12;
    static final int MAX_CAUSES = 8;

    @Override
    public void create(Headers headers, Exception exception, boolean isKey,
                       DeadLetterPublishingRecoverer.HeaderNames names) {
        DeadLetterPublishingRecoverer.HeaderNames.ExceptionInfo info = names.getExceptionInfo();
        Throwable root = NestedExceptionUtils.getMostSpecificCause(exception);
        headers.add(isKey ? info.getKeyExceptionFqcn() : info.getExceptionFqcn(), bytes(exception.getClass().getName()));
        if (!isKey && root != exception) {
            headers.add(info.getExceptionCauseFqcn(), bytes(root.getClass().getName()));
        }
        headers.add(isKey ? info.getKeyExceptionMessage() : info.getExceptionMessage(),
            bytes(cap(String.valueOf(root.getMessage()), MAX_MESSAGE_CHARS)));
        headers.add(isKey ? info.getKeyExceptionStacktrace() : info.getExceptionStacktrace(),
            bytes(compactTrace(exception)));
    }

    /** Class, capped message and top frames of each throwable in the cause chain. */
    static String compactTrace(Throwable t) {
        StringBuilder sb = new StringBuilder();
        int depth = 0;
        for (Throwable c = t; c != null && depth < MAX_CAUSES; c = c.getCause() == c ? null : c.getCause(), depth++) {
            sb.append(depth == 0 ? "" : "Caused by: ").append(c.getClass().getName());
            if (c.getMessage() != null) {
                sb.append(": ").append(cap(c.getMessage(), MAX_CAUSE_MESSAGE_CHARS));
            }
            sb.append('\n');
            StackTraceElement[] frames = c.getStackTrace();
            for (int i = 0; i < Math.min(FRAMES_PER_CAUSE, frames.length); i++) {
                sb.append("\tat ").append(frames[i]).append('\n');
            }
            if (frames.length > FRAMES_PER_CAUSE) {
                sb.append("\t... ").append(frames.length - FRAMES_PER_CAUSE).append(" more\n");
            }
        }
        return sb.toString();
    }

    static String cap(String s, int max) {
        String safe = s.replace('\u0000', '�');
        return safe.length() <= max ? safe : safe.substring(0, max) + " ...[truncated " + (safe.length() - max) + " chars]";
    }

    private static byte[] bytes(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }
}
