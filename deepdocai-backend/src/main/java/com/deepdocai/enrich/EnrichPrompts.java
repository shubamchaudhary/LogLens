package com.deepdocai.enrich;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;

/**
 * Prompt text and the finding fingerprint for the enrichment lane.
 *
 * <p>The model is asked for a strict JSON object (or array of objects) with
 * exactly {@code {category, severity, title, explanation, confidence}}. Evidence
 * chunk ids are attached by code, never by the model, so a hallucinated id can
 * never enter the grounded evidence set.
 */
public final class EnrichPrompts {

    private EnrichPrompts() {
    }

    public static final String SYSTEM = """
        You are a production-log analyst. You receive one time window of application
        logs plus the exact metrics a deterministic parser already extracted from it.
        Explain what went wrong (or notably happened) in that window for an on-call
        engineer. Ground every statement in the provided lines and metrics — never
        invent request ids, stack frames, or numbers.

        Respond with STRICT JSON and nothing else: either a single object or an array
        of objects, each shaped exactly:
        {
          "category":    one of API|DATABASE|ERRORS|LIFECYCLE|PERFORMANCE|AUTH|TRAFFIC|DEPENDENCY,
          "severity":    one of INFO|WARN|ERROR|CRITICAL,
          "title":       short imperative summary (<= 80 chars),
          "explanation": 1-3 sentences citing the concrete evidence,
          "confidence":  number between 0 and 1
        }
        Emit one object per distinct insight. If the window is unremarkable, return [].
        Do not wrap the JSON in markdown fences.""";

    /** Builds the user turn: the window content plus the parser's metric context. */
    public static String user(String windowContent, List<String> metricContext) {
        StringBuilder sb = new StringBuilder();
        sb.append("METRICS (parser-extracted, authoritative):\n");
        if (metricContext == null || metricContext.isEmpty()) {
            sb.append("  (none)\n");
        } else {
            for (String line : metricContext) {
                sb.append("  ").append(line).append('\n');
            }
        }
        sb.append("\nLOG WINDOW:\n").append(windowContent);
        return sb.toString();
    }

    /**
     * Stable dedup key for a finding: SHA-256 of the category plus a normalized
     * title (lower-cased, digits dropped, whitespace collapsed) so the same
     * recurring anomaly folds onto one row regardless of the exact counts.
     */
    public static String fingerprint(String category, String title) {
        String normalizedTitle = (title == null ? "" : title)
            .toLowerCase()
            .replaceAll("\\d+", "")
            .replaceAll("\\s+", " ")
            .trim();
        String basis = (category == null ? "" : category.trim().toUpperCase()) + "|" + normalizedTitle;
        return sha256Hex(basis);
    }

    private static String sha256Hex(String input) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16));
                hex.append(Character.forDigit(b & 0xF, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
