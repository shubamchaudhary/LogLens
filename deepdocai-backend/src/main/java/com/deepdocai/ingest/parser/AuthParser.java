package com.deepdocai.ingest.parser;

import com.deepdocai.ingest.model.LogWindow;
import com.deepdocai.ingest.model.MetricRow;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Auth and security (§5.6): 401/403 responses, authentication failures and token
 * expiries. Spikes here frequently correlate with lifecycle or dependency events.
 */
@Component
public class AuthParser implements LogWindowParser {

    private static final String CAT = "AUTH";

    private static final Pattern UNAUTHORIZED = Pattern.compile(
        "(?i)\\b401\\b|unauthorized");
    private static final Pattern FORBIDDEN = Pattern.compile(
        "(?i)\\b403\\b|forbidden|access denied");
    private static final Pattern AUTH_FAIL = Pattern.compile(
        "(?i)authentication failed|auth(?:entication)? failure|bad credentials|invalid (?:password|credentials)|login failed");
    private static final Pattern TOKEN_EXPIRED = Pattern.compile(
        "(?i)token (?:has )?expired|expired (?:jwt|token)|jwt expired|ExpiredJwtException");

    @Override
    public List<MetricRow> parse(LogWindow window) {
        long unauth = 0, forbidden = 0, authFail = 0, tokenExpired = 0;
        for (String line : window.lines()) {
            if (UNAUTHORIZED.matcher(line).find()) {
                unauth++;
            }
            if (FORBIDDEN.matcher(line).find()) {
                forbidden++;
            }
            if (AUTH_FAIL.matcher(line).find()) {
                authFail++;
            }
            if (TOKEN_EXPIRED.matcher(line).find()) {
                tokenExpired++;
            }
        }
        List<MetricRow> out = new ArrayList<>();
        if (unauth > 0) {
            out.add(MetricRow.count(CAT, "auth_401", unauth));
        }
        if (forbidden > 0) {
            out.add(MetricRow.count(CAT, "auth_403", forbidden));
        }
        if (authFail > 0) {
            out.add(MetricRow.count(CAT, "auth_failures", authFail));
        }
        if (tokenExpired > 0) {
            out.add(MetricRow.count(CAT, "token_expired", tokenExpired));
        }
        return out;
    }
}
