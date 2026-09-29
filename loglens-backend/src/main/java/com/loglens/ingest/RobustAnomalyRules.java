package com.loglens.ingest;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Session-wide ("corpus") anomaly rules for {@code loglens.anomaly.mode=robust}.
 *
 * <p>Why: absolute rules ("any ERROR line", "5+ WARN lines per minute") flag
 * almost every window of a busy service, so the LLM gate stops saving anything.
 * These rules compare each window with the session's own baseline using the
 * median and the median absolute deviation (MAD), which stay stable even when a
 * large share of windows is abnormal (a p95 baseline breaks once an incident
 * covers more than 5% of windows).
 *
 * <ol>
 *   <li><b>Count spikes</b> for {@link #SOFT_METRICS}: modified z-score
 *       {@code (x - median) / (1.4826 * MAD) > 3.5} (Iglewicz &amp; Hoaglin), with the
 *       scale floored at 1 and {@code x >= 3}. Buckets without the metric count as 0.</li>
 *   <li><b>Latency spikes</b>: a bucket p95 above {@code 2 x median} and robust z &gt; 3.5.</li>
 *   <li><b>Rare signatures</b>: a WARN/ERROR/exception template seen in at most 2% of
 *       the session's buckets flags the buckets where it appears.</li>
 * </ol>
 *
 * <p>This class is the Java reference used by the eval harness; production runs
 * the same rules as one SQL statement in
 * {@link com.loglens.storage.SessionChunkRepository#flagRobustOutliers}.
 */
public final class RobustAnomalyRules {

    public static final List<String> SOFT_METRICS = List.of(
        "ERRORS|errors", "ERRORS|exceptions", "LEVEL|warn_lines", "API|api_5xx",
        "AUTH|auth_401", "AUTH|auth_403", "DATABASE|sql_failures");
    public static final double Z = 3.5;
    public static final double MAD_SCALE = 1.4826;
    public static final long MIN_COUNT = 3;
    public static final double LATENCY_MIN_RATIO = 2.0;
    public static final double RARE_SHARE = 0.02;

    private RobustAnomalyRules() {
    }

    /** One merged log_metrics row for a bucket. */
    public record Agg(long count, Double p95) {
    }

    /**
     * @param buckets every time bucket of the session (so absent metrics count as 0)
     * @param metrics bucket -> ("CATEGORY|metric" -> merged row)
     * @return flagged bucket -> rule names that fired
     */
    public static Map<Instant, List<String>> flag(Collection<Instant> buckets, Map<Instant, Map<String, Agg>> metrics) {
        Map<Instant, List<String>> out = new LinkedHashMap<>();
        // 1. count spikes
        for (String key : SOFT_METRICS) {
            double[] xs = new double[buckets.size()];
            int i = 0;
            for (Instant b : buckets) {
                Agg a = metrics.getOrDefault(b, Map.of()).get(key);
                xs[i++] = a == null ? 0 : a.count();
            }
            double med = median(xs);
            double scale = Math.max(MAD_SCALE * mad(xs, med), 1.0);
            for (Instant b : buckets) {
                Agg a = metrics.getOrDefault(b, Map.of()).get(key);
                long c = a == null ? 0 : a.count();
                if (c >= MIN_COUNT && c > med + Z * scale) {
                    out.computeIfAbsent(b, k -> new ArrayList<>()).add("SPIKE:" + key);
                }
            }
        }
        // 2. latency spikes (only buckets that have the metric)
        Map<String, Map<Instant, Double>> lat = new HashMap<>();
        metrics.forEach((b, m) -> m.forEach((k, a) -> {
            if (a.p95() != null) {
                lat.computeIfAbsent(k, x -> new HashMap<>()).put(b, a.p95());
            }
        }));
        lat.forEach((key, perBucket) -> {
            double[] xs = perBucket.values().stream().mapToDouble(Double::doubleValue).toArray();
            double med = median(xs);
            double scale = Math.max(MAD_SCALE * mad(xs, med), 1.0);
            perBucket.forEach((b, v) -> {
                if (v > LATENCY_MIN_RATIO * med && v > med + Z * scale) {
                    out.computeIfAbsent(b, k -> new ArrayList<>()).add("LATENCY:" + key);
                }
            });
        });
        // 3. rare signatures
        Map<String, List<Instant>> sigBuckets = new HashMap<>();
        metrics.forEach((b, m) -> m.keySet().forEach(k -> {
            if (k.startsWith("SIGNATURE|")) {
                sigBuckets.computeIfAbsent(k, x -> new ArrayList<>()).add(b);
            }
        }));
        double limit = Math.max(1.0, RARE_SHARE * buckets.size());
        sigBuckets.forEach((k, bs) -> {
            if (bs.size() <= limit) {
                for (Instant b : bs) {
                    out.computeIfAbsent(b, x -> new ArrayList<>()).add("RARE_SIGNATURE");
                }
            }
        });
        return out;
    }

    /** Postgres percentile_cont(0.5) semantics. */
    static double median(double[] xs) {
        if (xs.length == 0) {
            return 0;
        }
        double[] s = xs.clone();
        java.util.Arrays.sort(s);
        double pos = (s.length - 1) * 0.5;
        int lo = (int) Math.floor(pos);
        int hi = (int) Math.ceil(pos);
        return s[lo] + (s[hi] - s[lo]) * (pos - lo);
    }

    static double mad(double[] xs, double med) {
        double[] d = new double[xs.length];
        for (int i = 0; i < xs.length; i++) {
            d[i] = Math.abs(xs[i] - med);
        }
        return median(d);
    }

    /** Buckets flagged by any rule. */
    public static Set<Instant> flaggedBuckets(Collection<Instant> buckets, Map<Instant, Map<String, Agg>> metrics) {
        return flag(buckets, metrics).keySet();
    }
}
