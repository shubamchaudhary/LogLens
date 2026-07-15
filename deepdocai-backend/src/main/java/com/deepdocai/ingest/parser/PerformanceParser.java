package com.deepdocai.ingest.parser;

import com.deepdocai.ingest.model.LogWindow;
import com.deepdocai.ingest.model.MetricRow;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Performance (§5.5): GC pauses, memory warnings, thread-pool saturation and
 * out-of-memory conditions. GC pause durations are aggregated in milliseconds.
 * An OOM makes the window anomalous.
 */
@Component
public class PerformanceParser implements LogWindowParser {

    private static final String CAT = "PERFORMANCE";

    private static final Pattern GC_PAUSE = Pattern.compile(
        "(?i)(?:gc|garbage collect)[^\\n]{0,60}?(\\d+(?:\\.\\d+)?)\\s?ms|pause[^\\n]{0,20}?(\\d+(?:\\.\\d+)?)\\s?ms");
    private static final Pattern OOM = Pattern.compile(
        "(?i)OutOfMemoryError|out of memory|OOMKilled|heap space|GC overhead limit");
    private static final Pattern MEMORY_WARN = Pattern.compile(
        "(?i)memory (?:usage )?(?:high|warning|pressure)|low (?:free )?memory|heap (?:usage )?(?:high|above)");
    private static final Pattern THREAD_POOL = Pattern.compile(
        "(?i)thread[\\s_-]?pool.*(?:satur|exhaust|full|reject)|task rejected|rejectedexecution|queue (?:is )?full|no available threads");

    @Override
    public List<MetricRow> parse(LogWindow window) {
        long gcCount = 0, oom = 0, memWarn = 0, threadPool = 0;
        List<Long> gcPauses = new ArrayList<>();

        for (String line : window.lines()) {
            Matcher gc = GC_PAUSE.matcher(line);
            if (gc.find()) {
                gcCount++;
                String v = gc.group(1) != null ? gc.group(1) : gc.group(2);
                if (v != null) {
                    gcPauses.add((long) Math.round(Double.parseDouble(v)));
                }
            }
            if (OOM.matcher(line).find()) {
                oom++;
            }
            if (MEMORY_WARN.matcher(line).find()) {
                memWarn++;
            }
            if (THREAD_POOL.matcher(line).find()) {
                threadPool++;
            }
        }

        List<MetricRow> out = new ArrayList<>();
        if (!gcPauses.isEmpty()) {
            out.add(MetricRow.latency(CAT, "gc_pause_ms", gcPauses));
        } else if (gcCount > 0) {
            out.add(MetricRow.count(CAT, "gc_events", gcCount));
        }
        if (oom > 0) {
            out.add(MetricRow.count(CAT, "oom", oom));
        }
        if (memWarn > 0) {
            out.add(MetricRow.count(CAT, "memory_warnings", memWarn));
        }
        if (threadPool > 0) {
            out.add(MetricRow.count(CAT, "thread_pool_saturation", threadPool));
        }
        return out;
    }

    @Override
    public boolean isAnomalous(LogWindow window) {
        for (String line : window.lines()) {
            if (OOM.matcher(line).find() || THREAD_POOL.matcher(line).find()) {
                return true;
            }
        }
        return false;
    }
}
