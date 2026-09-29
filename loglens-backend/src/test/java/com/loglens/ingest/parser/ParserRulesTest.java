package com.loglens.ingest.parser;

import com.loglens.ingest.model.LogWindow;
import com.loglens.ingest.model.MetricRow;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ParserRulesTest {

    private static LogWindow window(String... lines) {
        return new LogWindow(Instant.EPOCH, 1, lines.length, List.of(lines));
    }

    @Test
    void errorLevelIsCaseSensitiveSoMessageTextDoesNotCount() {
        ErrorParser p = new ErrorParser();
        LogWindow w = window("2005-06-03 15:42:50 RAS KERNEL INFO instruction cache parity error corrected");
        assertTrue(p.parse(w).stream().noneMatch(r -> r.metric().equals("errors")));
        assertFalse(p.isHardAnomaly(w));
        // the legacy rule (kept behind loglens.anomaly.mode=legacy) still fires, as before
        assertTrue(p.isAnomalous(w));
    }

    @Test
    void fatalIsAHardAnomalyButPlainErrorIsNot() {
        ErrorParser p = new ErrorParser();
        assertTrue(p.isHardAnomaly(window("2026-07-15 10:00:00 FATAL [x] - boom")));
        assertFalse(p.isHardAnomaly(window("2026-07-15 10:00:00 ERROR [x] - Failed to send email (will retry)")));
        assertTrue(p.isHardAnomaly(window("ts=1 level=fatal msg=\"disk gone\"")));
    }

    @Test
    void hikariStartupIsNotPoolExhaustion() {
        SqlParser p = new SqlParser();
        assertFalse(p.isHardAnomaly(window("2026-07-15 09:00:00 INFO HikariPool-1 - Starting...")));
        assertTrue(p.isHardAnomaly(window(
            "2026-07-15 09:00:00 WARN HikariPool-1 - Connection is not available, request timed out after 30000ms")));
    }

    @Test
    void signatureTemplateDropsVariablePartsButKeepsWords() {
        String a = SignatureParser.template(
            "2026-07-15 09:30:02.123 ERROR [db-proxy] tenant=acme traceId=TR101802 host=pod-2 - SQL timeout duration=12000ms");
        String b = SignatureParser.template(
            "2026-07-15 11:01:44.900 ERROR [db-proxy] tenant=hooli traceId=TR999999 host=pod-5 - SQL timeout duration=31000ms");
        assertEquals(a, b);
        assertTrue(a.contains("SQL timeout"));
        assertEquals(SignatureParser.signatureKey("x 0xdeadbeef ERROR 42"), SignatureParser.signatureKey("x 0xfeed ERROR 7"));
    }

    @Test
    void signatureParserCountsWarnAndEmitsOneRowPerTemplate() {
        SignatureParser p = new SignatureParser();
        List<MetricRow> rows = p.parse(window(
            "2026-07-15 09:00:00 WARN [a] lag=10 - Consumer lag high",
            "2026-07-15 09:00:01 WARN [a] lag=99 - Consumer lag high",
            "2026-07-15 09:00:02 INFO [a] - fine",
            "2026-07-15 09:00:03 ERROR [b] - java.lang.IllegalStateException: nope"));
        assertEquals(2, rows.stream().filter(r -> r.metric().equals("warn_lines")).findFirst().orElseThrow().count());
        assertEquals(2, rows.stream().filter(r -> r.category().equals(SignatureParser.SIGNATURE)).count());
    }
}
