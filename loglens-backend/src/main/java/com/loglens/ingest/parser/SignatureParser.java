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
import java.util.regex.Pattern;

/**
 * Inputs for the robust anomaly rules (see {@code AnomalyDetector} and the
 * finalizer): the number of WARN-level lines per window, and a count per
 * normalised <em>signature</em> (template) of every WARN / ERROR / FATAL /
 * exception line. A signature that shows up in only a few windows of the whole
 * session is "rare" and worth a look; one that appears all day (a retrying email
 * sender) is background noise.
 *
 * <p>Normalisation keeps the words and drops what varies per line: the leading
 * timestamp, {@code key=value} values, numbers, hex ids and UUIDs.
 */
@Component
public class SignatureParser implements LogWindowParser {

    public static final String LEVEL = "LEVEL";
    public static final String SIGNATURE = "SIGNATURE";

    /** Level tokens are matched case-sensitively: "parity error corrected" is not an ERROR line. */
    private static final Pattern WARN_LEVEL = Pattern.compile(
        "\\b(WARN|WARNING)\\b|(?i:\\blevel[=:]\\s*\"?warn)");
    private static final Pattern NOTABLE = Pattern.compile(
        "\\b(WARN|WARNING|ERROR|FATAL|SEVERE|CRITICAL)\\b|(?i:\\blevel[=:]\\s*\"?(warn|error|fatal))"
            + "|\\b[\\w.$]+(?:Exception|Error)\\b");
    private static final Pattern LEADING_TS = Pattern.compile(
        "^\\s*(\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?"
            + "|[A-Z][a-z]{2}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2})\\s*");
    private static final Pattern KV_VALUE = Pattern.compile("(\\w+)=(\"[^\"]*\"|\\S+)");
    private static final Pattern UUID_OR_HEX = Pattern.compile(
        "\\b[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}\\b|\\b0x[0-9a-fA-F]+\\b|\\b[0-9a-fA-F]{12,}\\b");
    private static final Pattern NUMBER = Pattern.compile("\\d+");
    private static final Pattern SPACES = Pattern.compile("\\s+");

    @Override
    public List<MetricRow> parse(LogWindow window) {
        long warn = 0;
        Map<String, Long> sigs = new LinkedHashMap<>();
        for (String line : window.lines()) {
            if (WARN_LEVEL.matcher(line).find()) {
                warn++;
            }
            if (NOTABLE.matcher(line).find()) {
                sigs.merge(signatureKey(line), 1L, Long::sum);
            }
        }
        List<MetricRow> out = new ArrayList<>();
        if (warn > 0) {
            out.add(MetricRow.count(LEVEL, "warn_lines", warn));
        }
        sigs.forEach((k, v) -> out.add(MetricRow.count(SIGNATURE, k, v)));
        return out;
    }

    /** Template text with variable parts removed. */
    public static String template(String line) {
        String s = LEADING_TS.matcher(line).replaceFirst("");
        s = KV_VALUE.matcher(s).replaceAll("$1=*");
        s = UUID_OR_HEX.matcher(s).replaceAll("#");
        s = NUMBER.matcher(s).replaceAll("#");
        return SPACES.matcher(s).replaceAll(" ").trim();
    }

    /** {@code sig:<6 hex of SHA-256>:<first 80 chars of the template>} — fits log_metrics.metric (100). */
    public static String signatureKey(String line) {
        String t = template(line);
        String head = t.length() > 80 ? t.substring(0, 80) : t;
        return "sig:" + sha256Hex(t).substring(0, 6) + ":" + head;
    }

    private static String sha256Hex(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < 4; i++) {
                hex.append(Character.forDigit((d[i] >> 4) & 0xF, 16)).append(Character.forDigit(d[i] & 0xF, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
