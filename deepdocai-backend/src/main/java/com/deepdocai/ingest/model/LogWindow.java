package com.deepdocai.ingest.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * One time-window chunk: the unit of both storage (a row in the per-session
 * {@code log_chunks_s_<tid>} table) and enrichment (Phase 3 sends anomalous
 * windows to the LLM). A window groups consecutive log lines that fall in the
 * same {@code chunkai.window-seconds} bucket.
 *
 * <p>Mutable by design: {@link #chunkId} is assigned just before the chunk is
 * inserted, and {@link #anomalous} is set by {@link com.deepdocai.ingest.AnomalyDetector}
 * after the full parse pass.
 */
public class LogWindow {

    private final Instant timeBucket;
    private final int lineStart;
    private final int lineEnd;
    private final List<String> lines;

    private UUID chunkId;
    private boolean anomalous;

    public LogWindow(Instant timeBucket, int lineStart, int lineEnd, List<String> lines) {
        this.timeBucket = timeBucket;
        this.lineStart = lineStart;
        this.lineEnd = lineEnd;
        this.lines = lines;
    }

    public Instant timeBucket() {
        return timeBucket;
    }

    public int lineStart() {
        return lineStart;
    }

    public int lineEnd() {
        return lineEnd;
    }

    public List<String> lines() {
        return lines;
    }

    /** The chunk body persisted to {@code content} — the window's raw lines joined by newline. */
    public String content() {
        return String.join("\n", lines);
    }

    public UUID chunkId() {
        return chunkId;
    }

    public void setChunkId(UUID chunkId) {
        this.chunkId = chunkId;
    }

    public boolean isAnomalous() {
        return anomalous;
    }

    public void setAnomalous(boolean anomalous) {
        this.anomalous = anomalous;
    }
}
