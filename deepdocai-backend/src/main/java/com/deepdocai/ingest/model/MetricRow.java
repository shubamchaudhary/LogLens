package com.deepdocai.ingest.model;

import java.util.List;

/**
 * One Layer-1 measurement produced by a {@link com.deepdocai.ingest.parser.LogWindowParser}
 * for a single window. The window's {@code time_bucket}, {@code session_id} and
 * sample chunk id are attached by the ingest pipeline when it writes
 * {@code log_metrics} — a parser only knows the count and (optionally) latency
 * aggregates.
 *
 * <p>Latency fields are {@code null} for pure counters (e.g. {@code sql_failures});
 * they are populated for timing metrics (e.g. {@code api_latency_ms}).
 */
public record MetricRow(
    String category,
    String metric,
    long count,
    Long sumMs,
    Double avgMs,
    Double p95Ms
) {

    /** A pure counter (no latency aggregates). */
    public static MetricRow count(String category, String metric, long count) {
        return new MetricRow(category, metric, count, null, null, null);
    }

    /**
     * A latency metric derived from the millisecond samples observed in one
     * window: {@code count} = sample size, {@code sum_ms}/{@code avg_ms}/{@code p95_ms}
     * computed exactly (never by an LLM).
     */
    public static MetricRow latency(String category, String metric, List<Long> samplesMs) {
        long n = samplesMs.size();
        long sum = 0;
        for (Long v : samplesMs) {
            sum += v;
        }
        double avg = n == 0 ? 0 : (double) sum / n;
        double p95 = Stats.p95(samplesMs);
        return new MetricRow(category, metric, n, sum, avg, p95);
    }

    public boolean hasLatency() {
        return p95Ms != null;
    }
}
