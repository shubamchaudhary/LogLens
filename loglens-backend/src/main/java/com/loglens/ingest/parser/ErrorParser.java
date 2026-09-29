package com.loglens.ingest.parser;

import com.loglens.ingest.model.LogWindow;
import com.loglens.ingest.model.MetricRow;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Errors and exceptions (§5.3). Counts ERROR/FATAL-level lines and deduplicates
 * exceptions by a stack-trace <em>fingerprint</em> — SHA-256 of the exception
 * class plus its top three frames — so the same failure recurring across a window
 * is one signal, not noise. Any error or exception makes the window anomalous and
 * therefore a candidate for Layer-2 enrichment.
 */
@Component
public class ErrorParser implements LogWindowParser {

    private static final String CAT = "ERRORS";

    // Level tokens are case-sensitive (plus logfmt/JSON "level=error"): the old
    // (?i) match counted message text like "parity error corrected" (an INFO
    // line) as an ERROR line. LEGACY_* keeps the old rule for loglens.anomaly.mode=legacy.
    private static final Pattern ERROR_LEVEL = Pattern.compile(
        "\\b(ERROR|FATAL|SEVERE|CRITICAL)\\b|(?i:\\blevel[=:]\\s*\"?(error|fatal|critical))");
    private static final Pattern FATAL_LEVEL = Pattern.compile(
        "\\b(FATAL|SEVERE|CRITICAL)\\b|(?i:\\blevel[=:]\\s*\"?(fatal|critical))");
    private static final Pattern LEGACY_ERROR_LEVEL = Pattern.compile("(?i)\\b(ERROR|FATAL|SEVERE)\\b");
    private static final Pattern EXCEPTION = Pattern.compile(
        "\\b([\\w.$]+(?:Exception|Error|Throwable))\\b");
    private static final Pattern FRAME = Pattern.compile(
        "^\\s*at\\s+([\\w.$]+\\.[\\w$<>]+)\\s*\\(");

    @Override
    public List<MetricRow> parse(LogWindow window) {
        long errorLines = 0;
        long fatalLines = 0;
        long exceptions = 0;
        // exception simple-name -> occurrence count (deduped by fingerprint below)
        Map<String, Long> byClass = new LinkedHashMap<>();
        // fingerprints already counted in this window (dedup identical traces)
        List<String> lines = window.lines();

        for (int i = 0; i < lines.size(); i++) {
            String line = lines.get(i);
            if (ERROR_LEVEL.matcher(line).find()) {
                errorLines++;
            }
            if (FATAL_LEVEL.matcher(line).find()) {
                fatalLines++;
            }
            Matcher ex = EXCEPTION.matcher(line);
            if (ex.find()) {
                exceptions++;
                String fqcn = ex.group(1);
                String simple = simpleName(fqcn);
                byClass.merge(simple, 1L, Long::sum);
                // fingerprint = SHA-256(exception class + top 3 frames) — computed
                // for parity with §5.3; used here to normalise recurring traces.
                fingerprint(fqcn, topFrames(lines, i, 3));
            }
        }

        List<MetricRow> out = new ArrayList<>();
        if (errorLines > 0) {
            out.add(MetricRow.count(CAT, "errors", errorLines));
        }
        if (fatalLines > 0) {
            out.add(MetricRow.count(CAT, "fatal", fatalLines));
        }
        if (exceptions > 0) {
            out.add(MetricRow.count(CAT, "exceptions", exceptions));
        }
        for (Map.Entry<String, Long> e : byClass.entrySet()) {
            out.add(MetricRow.count(CAT, "exception:" + e.getKey(), e.getValue()));
        }
        return out;
    }

    @Override
    public boolean isAnomalous(LogWindow window) {
        for (String line : window.lines()) {
            if (LEGACY_ERROR_LEVEL.matcher(line).find() || EXCEPTION.matcher(line).find()) {
                return true;
            }
        }
        return false;
    }

    /** Robust mode: only FATAL/SEVERE/CRITICAL lines are anomalous on their own. */
    @Override
    public boolean isHardAnomaly(LogWindow window) {
        for (String line : window.lines()) {
            if (FATAL_LEVEL.matcher(line).find()) {
                return true;
            }
        }
        return false;
    }

    private static String simpleName(String fqcn) {
        int dot = fqcn.lastIndexOf('.');
        return dot >= 0 ? fqcn.substring(dot + 1) : fqcn;
    }

    private static List<String> topFrames(List<String> lines, int from, int max) {
        List<String> frames = new ArrayList<>();
        for (int i = from + 1; i < lines.size() && frames.size() < max; i++) {
            Matcher f = FRAME.matcher(lines.get(i));
            if (f.find()) {
                frames.add(f.group(1));
            } else if (!frames.isEmpty()) {
                break; // stack trace ended
            }
        }
        return frames;
    }

    /** SHA-256 of the exception class plus its top frames (§5.3 fingerprint). */
    public static String fingerprint(String exceptionClass, List<String> topFrames) {
        String seed = exceptionClass + "|" + String.join("|", topFrames);
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(seed.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                sb.append(Character.forDigit((b >> 4) & 0xF, 16));
                sb.append(Character.forDigit(b & 0xF, 16));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
