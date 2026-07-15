package com.deepdocai.ingest.parser;

import com.deepdocai.ingest.model.LogWindow;
import com.deepdocai.ingest.model.MetricRow;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * API activity (§5.1): request volume, status-code classes and request latency.
 * Recognises common access-log and app-log request lines; latency is captured in
 * milliseconds and aggregated exactly (count/sum/avg/p95).
 */
@Component
public class ApiCallParser implements LogWindowParser {

    private static final String CAT = "API";

    private static final Pattern METHOD_PATH = Pattern.compile(
        "(?i)\\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\\s+(/[\\w/{}.\\-:]*)");
    private static final Pattern STATUS_LABELLED = Pattern.compile(
        "(?i)(?:status|http_status|response|code)[=:\\s\"]+(\\d{3})\\b");
    private static final Pattern STATUS_HTTP = Pattern.compile(
        "(?i)HTTP/\\d\\.\\d\"?\\s+(\\d{3})\\b");
    private static final Pattern LATENCY_LABELLED = Pattern.compile(
        "(?i)(?:duration|latency|took|elapsed|responsetime|response_time|time)[=:\\s]+(\\d+)\\s?ms");
    private static final Pattern LATENCY_BARE = Pattern.compile(
        "(?i)\\b(\\d+)\\s?ms\\b");

    @Override
    public List<MetricRow> parse(LogWindow window) {
        long calls = 0;
        long ff = 0;
        long c2xx = 0, c4xx = 0, c5xx = 0;
        List<Long> latencies = new ArrayList<>();

        for (String line : window.lines()) {
            Matcher mp = METHOD_PATH.matcher(line);
            if (!mp.find()) {
                continue;
            }
            calls++;
            String path = mp.group(2).toLowerCase();
            if (path.contains("flag") || path.contains("feature")) {
                ff++;
            }
            Integer status = extractStatus(line);
            if (status != null) {
                if (status >= 500) {
                    c5xx++;
                } else if (status >= 400) {
                    c4xx++;
                } else if (status >= 200 && status < 300) {
                    c2xx++;
                }
            }
            Long ms = extractLatency(line);
            if (ms != null) {
                latencies.add(ms);
            }
        }

        List<MetricRow> out = new ArrayList<>();
        if (calls > 0) {
            out.add(MetricRow.count(CAT, "api_calls", calls));
        }
        if (ff > 0) {
            out.add(MetricRow.count(CAT, "ff_api_calls", ff));
        }
        if (c2xx > 0) {
            out.add(MetricRow.count(CAT, "api_2xx", c2xx));
        }
        if (c4xx > 0) {
            out.add(MetricRow.count(CAT, "api_4xx", c4xx));
        }
        if (c5xx > 0) {
            out.add(MetricRow.count(CAT, "api_5xx", c5xx));
        }
        if (!latencies.isEmpty()) {
            out.add(MetricRow.latency(CAT, "api_latency_ms", latencies));
        }
        return out;
    }

    private Integer extractStatus(String line) {
        Matcher s = STATUS_LABELLED.matcher(line);
        if (s.find()) {
            return Integer.parseInt(s.group(1));
        }
        s = STATUS_HTTP.matcher(line);
        if (s.find()) {
            return Integer.parseInt(s.group(1));
        }
        return null;
    }

    private Long extractLatency(String line) {
        Matcher l = LATENCY_LABELLED.matcher(line);
        if (l.find()) {
            return Long.parseLong(l.group(1));
        }
        l = LATENCY_BARE.matcher(line);
        if (l.find()) {
            return Long.parseLong(l.group(1));
        }
        return null;
    }
}
