package com.deepdocai.ingest.parser;

import com.deepdocai.ingest.model.LogWindow;
import com.deepdocai.ingest.model.MetricRow;

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
     * {@link com.deepdocai.ingest.AnomalyDetector}.
     */
    default boolean isAnomalous(LogWindow window) {
        return false;
    }
}
