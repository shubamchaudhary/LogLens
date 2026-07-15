package com.deepdocai.ingest;

import com.deepdocai.ingest.model.LogWindow;
import com.deepdocai.ingest.model.MetricRow;
import com.deepdocai.ingest.parser.LogWindowParser;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Decides which windows are anomalous and therefore worth Layer-2 LLM
 * enrichment (§5). A window is anomalous if any of:
 * <ul>
 *   <li>a parser recognises an intrinsic problem (exception, OOM, deadlock,
 *       failed health check — see {@link LogWindowParser#isAnomalous});</li>
 *   <li>it contains at least {@value #WARN_THRESHOLD} WARN lines;</li>
 *   <li>any of its latency metrics exceeds {@value #LATENCY_MULTIPLIER}× the
 *       corpus-wide p95 for that metric (computed after the full parse pass).</li>
 * </ul>
 * Keeping enrichment to anomalous windows is what makes the LLM spend bounded:
 * boring windows never reach Gemini.
 */
@Component
public class AnomalyDetector {

    private static final int WARN_THRESHOLD = 5;
    private static final double LATENCY_MULTIPLIER = 3.0;
    private static final Pattern WARN = Pattern.compile("(?i)\\bWARN(?:ING)?\\b");

    private final List<LogWindowParser> parsers;

    public AnomalyDetector(List<LogWindowParser> parsers) {
        this.parsers = parsers;
    }

    /**
     * Sets {@link LogWindow#setAnomalous} for every window, using the metrics
     * already extracted for each window. Two passes: gather the corpus-wide p95
     * per latency metric, then flag.
     */
    public void detect(List<LogWindow> windows, Map<LogWindow, List<MetricRow>> metricsByWindow) {
        // Pass 1 — collect each window's p95 per latency metric key.
        Map<String, List<Double>> windowP95s = new java.util.HashMap<>();
        for (LogWindow w : windows) {
            for (MetricRow row : metricsByWindow.getOrDefault(w, List.of())) {
                if (row.hasLatency()) {
                    windowP95s.computeIfAbsent(key(row), k -> new ArrayList<>()).add(row.p95Ms());
                }
            }
        }
        Map<String, Double> globalP95 = new java.util.HashMap<>();
        windowP95s.forEach((k, v) -> globalP95.put(k, percentile95(v)));

        // Pass 2 — flag windows.
        for (LogWindow w : windows) {
            boolean anomalous = false;
            for (LogWindowParser p : parsers) {
                if (p.isAnomalous(w)) {
                    anomalous = true;
                    break;
                }
            }
            if (!anomalous && warnCount(w) >= WARN_THRESHOLD) {
                anomalous = true;
            }
            if (!anomalous) {
                for (MetricRow row : metricsByWindow.getOrDefault(w, List.of())) {
                    if (!row.hasLatency()) {
                        continue;
                    }
                    Double corpus = globalP95.get(key(row));
                    if (corpus != null && corpus > 0 && row.p95Ms() > LATENCY_MULTIPLIER * corpus) {
                        anomalous = true;
                        break;
                    }
                }
            }
            w.setAnomalous(anomalous);
        }
    }

    private long warnCount(LogWindow window) {
        long c = 0;
        for (String line : window.lines()) {
            if (WARN.matcher(line).find()) {
                c++;
            }
        }
        return c;
    }

    private static String key(MetricRow row) {
        return row.category() + "|" + row.metric();
    }

    private static double percentile95(List<Double> values) {
        if (values == null || values.isEmpty()) {
            return 0;
        }
        List<Double> sorted = new ArrayList<>(values);
        Collections.sort(sorted);
        int rank = (int) Math.ceil(0.95 * sorted.size());
        int idx = Math.min(sorted.size(), Math.max(1, rank)) - 1;
        return sorted.get(idx);
    }
}
