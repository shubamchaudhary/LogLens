package com.deepdocai.ingest.parser;

import com.deepdocai.ingest.model.LogWindow;
import com.deepdocai.ingest.model.MetricRow;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Lifecycle events (§5.7): restarts, deploys, config reloads and health-check
 * failures — often the <em>cause</em> of everything else in a window. A failed
 * health check marks the window anomalous.
 */
@Component
public class LifecycleParser implements LogWindowParser {

    private static final String CAT = "LIFECYCLE";

    private static final Pattern STARTUP = Pattern.compile(
        "(?i)started \\w+ in \\d|starting \\w+Application|tomcat started|jvm running|application startup|springapplication");
    private static final Pattern SHUTDOWN = Pattern.compile(
        "(?i)shutting down|shutdown initiated|graceful shutdown|stopping \\w+Application|jvm shutting down");
    private static final Pattern DEPLOY = Pattern.compile(
        "(?i)deploy(?:ing|ed|ment)|new version|rolling out|release \\d");
    private static final Pattern CONFIG_RELOAD = Pattern.compile(
        "(?i)config(?:uration)? (?:reload|refresh|chang)|refreshing (?:context|configuration)|reloaded properties");
    private static final Pattern HEALTH_FAIL = Pattern.compile(
        "(?i)health[\\s_-]?check (?:failed|down)|liveness (?:probe )?failed|readiness (?:probe )?failed|status\\s*[=:]\\s*DOWN");

    @Override
    public List<MetricRow> parse(LogWindow window) {
        long restarts = 0, shutdowns = 0, deploys = 0, reloads = 0, healthFails = 0;
        for (String line : window.lines()) {
            if (STARTUP.matcher(line).find()) {
                restarts++;
            }
            if (SHUTDOWN.matcher(line).find()) {
                shutdowns++;
            }
            if (DEPLOY.matcher(line).find()) {
                deploys++;
            }
            if (CONFIG_RELOAD.matcher(line).find()) {
                reloads++;
            }
            if (HEALTH_FAIL.matcher(line).find()) {
                healthFails++;
            }
        }
        List<MetricRow> out = new ArrayList<>();
        if (restarts > 0) {
            out.add(MetricRow.count(CAT, "restarts", restarts));
        }
        if (shutdowns > 0) {
            out.add(MetricRow.count(CAT, "shutdowns", shutdowns));
        }
        if (deploys > 0) {
            out.add(MetricRow.count(CAT, "deploys", deploys));
        }
        if (reloads > 0) {
            out.add(MetricRow.count(CAT, "config_reloads", reloads));
        }
        if (healthFails > 0) {
            out.add(MetricRow.count(CAT, "health_check_failures", healthFails));
        }
        return out;
    }

    @Override
    public boolean isAnomalous(LogWindow window) {
        for (String line : window.lines()) {
            if (HEALTH_FAIL.matcher(line).find()) {
                return true;
            }
        }
        return false;
    }
}
