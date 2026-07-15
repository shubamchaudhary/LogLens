package com.deepdocai.ingest.parser;

import com.deepdocai.ingest.model.LogWindow;
import com.deepdocai.ingest.model.MetricRow;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Database activity (§5.2): query volume, slow queries and failure modes
 * (deadlocks, timeouts, connection-pool exhaustion). Query latency, when logged,
 * is aggregated exactly.
 */
@Component
public class SqlParser implements LogWindowParser {

    private static final String CAT = "DATABASE";

    private static final Pattern QUERY = Pattern.compile(
        "(?i)\\b(SELECT|INSERT|UPDATE|DELETE|MERGE)\\b|\\bexecuting query\\b|\\bhibernate:\\b");
    private static final Pattern DEADLOCK = Pattern.compile(
        "(?i)deadlock");
    private static final Pattern TIMEOUT = Pattern.compile(
        "(?i)(?:query|statement|lock)\\s*timeout|timeout.*(?:query|statement|sql)|SQLTimeoutException");
    private static final Pattern POOL = Pattern.compile(
        "(?i)connection\\s*pool|HikariPool|pool.*exhaust|unable to acquire.*connection|connection is not available");
    private static final Pattern FAILURE = Pattern.compile(
        "(?i)SQLException|SQLState|constraint violation|could not (?:execute|extract|prepare)|ORA-\\d+|duplicate key");
    private static final Pattern SLOW = Pattern.compile(
        "(?i)slow query|slow sql");
    private static final Pattern QUERY_LATENCY = Pattern.compile(
        "(?i)(?:query|sql|statement|db)[^\\n]{0,40}?(\\d+)\\s?ms");

    @Override
    public List<MetricRow> parse(LogWindow window) {
        long queries = 0, deadlocks = 0, timeouts = 0, poolEvents = 0, failures = 0, slow = 0;
        List<Long> latencies = new ArrayList<>();

        for (String line : window.lines()) {
            if (QUERY.matcher(line).find()) {
                queries++;
                Matcher ql = QUERY_LATENCY.matcher(line);
                if (ql.find()) {
                    latencies.add(Long.parseLong(ql.group(1)));
                }
            }
            if (DEADLOCK.matcher(line).find()) {
                deadlocks++;
            }
            if (TIMEOUT.matcher(line).find()) {
                timeouts++;
            }
            if (POOL.matcher(line).find()) {
                poolEvents++;
            }
            if (FAILURE.matcher(line).find()) {
                failures++;
            }
            if (SLOW.matcher(line).find()) {
                slow++;
            }
        }

        List<MetricRow> out = new ArrayList<>();
        if (queries > 0) {
            out.add(MetricRow.count(CAT, "sql_queries", queries));
        }
        if (!latencies.isEmpty()) {
            out.add(MetricRow.latency(CAT, "sql_latency_ms", latencies));
        }
        if (slow > 0) {
            out.add(MetricRow.count(CAT, "slow_queries", slow));
        }
        if (deadlocks > 0) {
            out.add(MetricRow.count(CAT, "sql_deadlocks", deadlocks));
        }
        if (timeouts > 0) {
            out.add(MetricRow.count(CAT, "sql_timeouts", timeouts));
        }
        if (poolEvents > 0) {
            out.add(MetricRow.count(CAT, "pool_events", poolEvents));
        }
        if (failures > 0) {
            out.add(MetricRow.count(CAT, "sql_failures", failures));
        }
        return out;
    }

    @Override
    public boolean isAnomalous(LogWindow window) {
        for (String line : window.lines()) {
            if (DEADLOCK.matcher(line).find()
                || TIMEOUT.matcher(line).find()
                || POOL.matcher(line).find()) {
                return true;
            }
        }
        return false;
    }
}
