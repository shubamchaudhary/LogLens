package com.loglens.enrich;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Record-aware splitting of a window's log text into LLM-sized segments, moved
 * out of {@link EnrichConsumer} unchanged so the eval harness can count exactly
 * how many enrichment calls a window costs.
 */
public final class RecordAwareSplitter {

    private RecordAwareSplitter() {
    }

    /**
     * A line begins a new logical record when it starts (after optional leading
     * whitespace) with a recognisable timestamp. Mirrors the formats
     * {@link com.loglens.ingest.TimeWindowChunker} recognises (ISO-8601 /
     * {@code yyyy-MM-dd HH:mm:ss} / syslog) so record-aware splitting agrees
     * with chunking. Lines without a leading timestamp (stack frames,
     * {@code Caused by:}, {@code ... N more}) are continuations.
     */
    private static final Pattern RECORD_START = Pattern.compile(
        "^\\s*(?:\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}"
        + "|[A-Z][a-z]{2}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2})");

    /**
     * Splits a window's log content into segments each within {@code max}
     * characters so a large window is fully analyzed rather than truncated —
     * every segment is enriched in its own LLM call and duplicate insights fold
     * together via the {@code (session_id, fingerprint)} upsert.
     *
     * <p>Bounding each call also keeps it under a provider's per-request token
     * budget: Groq's {@code llama-3.1-8b-instant} free tier caps at 6000
     * tokens/minute and rejects an oversized prompt with a non-retryable 413.
     * {@code loglens.enrich.max-content-chars} leaves headroom for the system
     * prompt, metric context, and the model's output. Bursts that trip the
     * per-minute ceiling surface as a 429 and are handled by the retry lane.
     *
     * <p>Splitting is <b>record-aware</b>: lines are first grouped into logical
     * records (a timestamped line plus its continuation lines — stack frames,
     * {@code Caused by:}, {@code ... N more} — which carry no timestamp), then
     * whole records are greedily packed up to {@code max} so a multi-line event
     * (e.g. a stack trace) is never split across two calls and its reasoning is
     * never lost. A single record larger than {@code max} is hard-split on line
     * boundaries as a last resort so no content is ever dropped.
     */
    public static List<String> split(String content, int max) {
        List<String> segments = new ArrayList<>();
        if (max <= 0 || content.length() <= max) {
            segments.add(content);
            return segments;
        }
        StringBuilder seg = new StringBuilder();
        for (String record : groupRecords(content)) {
            if (record.length() > max) {
                if (seg.length() > 0) {
                    segments.add(seg.toString());
                    seg.setLength(0);
                }
                hardSplit(record, max, segments);
                continue;
            }
            int extra = record.length() + (seg.length() > 0 ? 1 : 0);
            if (seg.length() + extra > max && seg.length() > 0) {
                segments.add(seg.toString());
                seg.setLength(0);
            }
            if (seg.length() > 0) {
                seg.append('\n');
            }
            seg.append(record);
        }
        if (seg.length() > 0) {
            segments.add(seg.toString());
        }
        return segments;
    }

    /**
     * Groups raw lines into logical records. A line starts a new record when it
     * begins with a recognisable timestamp ({@link #RECORD_START}); a line
     * without one is a continuation of the current record (stack frame,
     * {@code Caused by:}, {@code ... N more}, or a plain multi-line message).
     */
    private static List<String> groupRecords(String content) {
        List<String> records = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        for (String line : content.split("\n", -1)) {
            if (RECORD_START.matcher(line).find() && cur.length() > 0) {
                records.add(cur.toString());
                cur.setLength(0);
            }
            if (cur.length() > 0) {
                cur.append('\n');
            }
            cur.append(line);
        }
        if (cur.length() > 0) {
            records.add(cur.toString());
        }
        return records;
    }

    /**
     * Fallback for a single logical record larger than the cap (rare — e.g. a
     * huge stack trace). Splits on line boundaries; a single line longer than
     * {@code max} is chopped so nothing is dropped.
     */
    private static void hardSplit(String record, int max, List<String> out) {
        StringBuilder seg = new StringBuilder();
        for (String rawLine : record.split("\n", -1)) {
            String line = rawLine;
            while (line.length() > max) {
                if (seg.length() > 0) {
                    out.add(seg.toString());
                    seg.setLength(0);
                }
                out.add(line.substring(0, max));
                line = line.substring(max);
            }
            int extra = line.length() + (seg.length() > 0 ? 1 : 0);
            if (seg.length() + extra > max && seg.length() > 0) {
                out.add(seg.toString());
                seg.setLength(0);
            }
            if (seg.length() > 0) {
                seg.append('\n');
            }
            seg.append(line);
        }
        if (seg.length() > 0) {
            out.add(seg.toString());
        }
    }
}
