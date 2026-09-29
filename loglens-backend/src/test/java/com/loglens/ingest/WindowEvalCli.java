package com.loglens.ingest;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.loglens.enrich.EnrichPrompts;
import com.loglens.enrich.RecordAwareSplitter;
import com.loglens.ingest.model.LogWindow;
import com.loglens.ingest.model.MetricRow;
import com.loglens.ingest.parser.ApiCallParser;
import com.loglens.ingest.parser.AuthParser;
import com.loglens.ingest.parser.ErrorParser;
import com.loglens.ingest.parser.LifecycleParser;
import com.loglens.ingest.parser.LogWindowParser;
import com.loglens.ingest.parser.PerformanceParser;
import com.loglens.ingest.parser.SignatureParser;
import com.loglens.ingest.parser.SqlParser;
import com.loglens.ingest.parser.TrafficParser;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Eval harness entry point: runs the PRODUCTION Layer-1 path (TimeWindowChunker,
 * the seven parsers, AnomalyDetector local rules, and a Java port of the
 * finalizer's SQL percentile_cont latency rule) over one log file and writes a
 * JSON record per window. Python evals score these records against labels.
 *
 * <p>Nothing here calls an LLM. The per-window LLM cost is computed with the same
 * splitter and token estimate the enrichment lane uses, so "calls with gating"
 * and "calls without gating" are exact counts for this code, not guesses.
 *
 * <p>Usage: {@code WindowEvalCli <input.log> <output.json> [windowSeconds] [maxContentChars] [legacy|robust]}
 */
public final class WindowEvalCli {

    private static final double LATENCY_MULTIPLIER = 3.0;   // SessionChunkRepository.flagLatencyOutliers
    private static final int OUTPUT_TOKEN_ESTIMATE = 512;    // EnrichConsumer.OUTPUT_TOKEN_ESTIMATE

    private WindowEvalCli() {
    }

    public static void main(String[] args) throws Exception {
        Path in = Path.of(args[0]);
        File out = new File(args[1]);
        long windowSeconds = args.length > 2 ? Long.parseLong(args[2]) : 60;
        int maxChars = args.length > 3 ? Integer.parseInt(args[3]) : 5000;
        String mode = args.length > 4 ? args[4] : "robust";

        List<LogWindowParser> parsers = List.of(new ApiCallParser(), new SqlParser(), new ErrorParser(),
            new PerformanceParser(), new AuthParser(), new LifecycleParser(), new TrafficParser(), new SignatureParser());
        TimeWindowChunker chunker = new TimeWindowChunker(windowSeconds);
        AnomalyDetector detector = new AnomalyDetector(parsers, mode);

        long t0 = System.nanoTime();
        List<String> lines = Files.readAllLines(in, StandardCharsets.UTF_8);
        long tsRecognized = 0;
        for (String l : lines) {
            if (chunker.extractTimestamp(l) != null) {
                tsRecognized++;
            }
        }
        List<LogWindow> windows = chunker.chunk(lines, 0);
        Map<LogWindow, List<MetricRow>> metrics = new LinkedHashMap<>();
        for (LogWindow w : windows) {
            List<MetricRow> rows = new ArrayList<>();
            for (LogWindowParser p : parsers) {
                rows.addAll(p.parse(w));
            }
            metrics.put(w, rows);
        }
        detector.detectLocal(windows);
        Map<Instant, List<String>> corpusFlags = detector.isRobust()
            ? RobustAnomalyRules.flag(distinctBuckets(windows), mergedPerBucket(windows, metrics))
            : legacyLatency(windows, metrics);
        long parseNanos = System.nanoTime() - t0;

        List<Map<String, Object>> records = new ArrayList<>();
        for (LogWindow w : windows) {
            List<String> reasons = new ArrayList<>(detector.explainLocal(w));
            boolean anomalous = w.isAnomalous();
            List<String> corpus = corpusFlags.get(w.timeBucket());
            if (corpus != null) {
                reasons.addAll(new java.util.TreeSet<>(corpus));
                anomalous = true;
            }
            String content = w.content();
            List<String> metricLines = new ArrayList<>();
            for (MetricRow m : metrics.get(w)) {
                metricLines.add(m.category() + "." + m.metric() + " count=" + m.count()
                    + (m.p95Ms() == null ? "" : " p95=" + m.p95Ms() + "ms"));
            }
            List<String> segments = RecordAwareSplitter.split(content, maxChars);
            long tokens = 0;
            for (String seg : segments) {
                String user = EnrichPrompts.user(seg, metricLines);
                tokens += (EnrichPrompts.SYSTEM.length() + user.length()) / 4L + OUTPUT_TOKEN_ESTIMATE;
            }
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("bucket", w.timeBucket().toString());
            r.put("lineStart", w.lineStart());
            r.put("lineEnd", w.lineEnd());
            r.put("chars", content.length());
            r.put("anomalous", anomalous);
            r.put("reasons", reasons);
            r.put("llmCalls", segments.size());
            r.put("estTokens", tokens);
            records.add(r);
        }

        Map<String, Object> doc = new LinkedHashMap<>();
        doc.put("input", in.getFileName().toString());
        doc.put("lines", lines.size());
        doc.put("timestampRecognizedLines", tsRecognized);
        doc.put("windowSeconds", windowSeconds);
        doc.put("maxContentChars", maxChars);
        doc.put("anomalyMode", detector.isRobust() ? "robust" : "legacy");
        doc.put("layer1Millis", parseNanos / 1_000_000);
        doc.put("windows", records);
        new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT).writeValue(out, doc);
        System.out.println("windows=" + windows.size() + " lines=" + lines.size() + " -> " + out);
    }

    static Map<Instant, List<String>> legacyLatency(List<LogWindow> windows, Map<LogWindow, List<MetricRow>> metrics) {
        Map<Instant, List<String>> out = new LinkedHashMap<>();
        for (Instant b : latencyOutlierBuckets(windows, metrics)) {
            out.put(b, List.of("LATENCY_P95"));
        }
        return out;
    }

    static List<Instant> distinctBuckets(List<LogWindow> windows) {
        return new ArrayList<>(new java.util.LinkedHashSet<>(windows.stream().map(LogWindow::timeBucket).toList()));
    }

    /** Merge metric rows per bucket exactly like the log_metrics upsert (count +=, p95 = GREATEST). */
    static Map<Instant, Map<String, RobustAnomalyRules.Agg>> mergedPerBucket(
        List<LogWindow> windows, Map<LogWindow, List<MetricRow>> metrics) {
        Map<Instant, Map<String, RobustAnomalyRules.Agg>> out = new HashMap<>();
        for (LogWindow w : windows) {
            Map<String, RobustAnomalyRules.Agg> m = out.computeIfAbsent(w.timeBucket(), k -> new HashMap<>());
            for (MetricRow r : metrics.get(w)) {
                m.merge(r.category() + "|" + r.metric(), new RobustAnomalyRules.Agg(r.count(), r.p95Ms()),
                    (a, b) -> new RobustAnomalyRules.Agg(a.count() + b.count(),
                        a.p95() == null && b.p95() == null ? null
                            : Math.max(a.p95() == null ? 0 : a.p95(), b.p95() == null ? 0 : b.p95())));
            }
        }
        return out;
    }

    /**
     * Java port of {@code SessionChunkRepository.flagLatencyOutliers}: merge metric
     * rows per (bucket, category, metric) like the log_metrics upsert (p95 =
     * GREATEST), compute the corpus p95 of those bucket p95s with SQL
     * percentile_cont semantics, and flag buckets above 3x.
     */
    static Set<Instant> latencyOutlierBuckets(List<LogWindow> windows, Map<LogWindow, List<MetricRow>> metrics) {
        Map<String, Map<Instant, Double>> byMetric = new HashMap<>();
        for (LogWindow w : windows) {
            for (MetricRow m : metrics.get(w)) {
                if (m.p95Ms() == null) {
                    continue;
                }
                byMetric.computeIfAbsent(m.category() + "|" + m.metric(), k -> new HashMap<>())
                    .merge(w.timeBucket(), m.p95Ms(), Math::max);
            }
        }
        Set<Instant> flagged = new HashSet<>();
        for (Map<Instant, Double> perBucket : byMetric.values()) {
            List<Double> vals = new ArrayList<>(perBucket.values());
            vals.sort(Double::compare);
            double corpus = percentileCont(vals, 0.95);
            if (corpus <= 0) {
                continue;
            }
            perBucket.forEach((bucket, p95) -> {
                if (p95 > LATENCY_MULTIPLIER * corpus) {
                    flagged.add(bucket);
                }
            });
        }
        return flagged;
    }

    /** Postgres percentile_cont: linear interpolation at position (n-1)*p over sorted values. */
    static double percentileCont(List<Double> sorted, double p) {
        if (sorted.isEmpty()) {
            return 0;
        }
        double pos = (sorted.size() - 1) * p;
        int lo = (int) Math.floor(pos);
        int hi = (int) Math.ceil(pos);
        return sorted.get(lo) + (sorted.get(hi) - sorted.get(lo)) * (pos - lo);
    }
}
