package com.loglens.ingest.parser;

import com.loglens.ingest.model.LogWindow;
import com.loglens.ingest.model.MetricRow;

import java.util.List;

/**
 * Layer-1 extraction: exact, regex-based, LLM-free. Each implementation owns one
 * slice of the {@code log_metrics} taxonomy (§5 of the architecture) and turns a
 * window's raw lines into precise counts and latency aggregates.
 *
 * <p>Parsers also contribute to anomaly detection: a parser that recognises a
 * clearly abnormal window (an exception, an OOM, a failed health check) returns
 * {@code true} from {@link #isAnomalous(LogWindow)} so the window is queued for
 * Layer-2 LLM enrichment.
 */
public interface LogWindowParser {

    /** The metrics this parser extracts from the window (may be empty). */
    List<MetricRow> parse(LogWindow window);

    /**
     * Whether this parser considers the window abnormal on its own. Defaults to
     * {@code false}; cross-cutting rules (WARN volume, latency outliers) live in
     * {@link com.loglens.ingest.AnomalyDetector}.
     */
    default boolean isAnomalous(LogWindow window) {
        return false;
    }

    /**
     * Robust mode ({@code loglens.anomaly.mode=robust}): only unambiguous,
     * traffic-independent problems (OOM, deadlock, FATAL, failed health check)
     * flag a window on their own. Volume-dependent signals (ERROR/WARN counts,
     * 5xx, 401s, latency, rare signatures) are judged later against the whole
     * session's baseline by the finalizer.
     */
    default boolean isHardAnomaly(LogWindow window) {
        return false;
    }
}
