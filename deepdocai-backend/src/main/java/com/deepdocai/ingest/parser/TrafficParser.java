package com.deepdocai.ingest.parser;

import com.deepdocai.ingest.model.LogWindow;
import com.deepdocai.ingest.model.MetricRow;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Traffic shape (§5.8): raw line volume and request volume per time bucket. These
 * counters are what later reveal spikes and dead periods when charted across
 * buckets.
 */
@Component
public class TrafficParser implements LogWindowParser {

    private static final String CAT = "TRAFFIC";

    private static final Pattern REQUEST = Pattern.compile(
        "(?i)\\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\\s+/|\\bHTTP/\\d\\.\\d\\b|incoming request|request received");

    @Override
    public List<MetricRow> parse(LogWindow window) {
        long lines = 0, requests = 0;
        for (String line : window.lines()) {
            lines++;
            if (REQUEST.matcher(line).find()) {
                requests++;
            }
        }
        List<MetricRow> out = new ArrayList<>();
        if (lines > 0) {
            out.add(MetricRow.count(CAT, "lines", lines));
        }
        if (requests > 0) {
            out.add(MetricRow.count(CAT, "requests", requests));
        }
        return out;
    }
}
