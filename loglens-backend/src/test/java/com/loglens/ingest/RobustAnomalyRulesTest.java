package com.loglens.ingest;

import com.loglens.ingest.RobustAnomalyRules.Agg;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RobustAnomalyRulesTest {

    private static List<Instant> buckets(int n) {
        List<Instant> out = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            out.add(Instant.ofEpochSecond(60L * i));
        }
        return out;
    }

    @Test
    void medianMatchesPercentileContInterpolation() {
        assertEquals(2.5, RobustAnomalyRules.median(new double[]{4, 1, 3, 2}), 1e-9);
        assertEquals(3.0, RobustAnomalyRules.median(new double[]{5, 3, 1}), 1e-9);
    }

    @Test
    void steadyBackgroundErrorsAreNotSpikesButABurstIs() {
        List<Instant> b = buckets(200);
        Map<Instant, Map<String, Agg>> m = new HashMap<>();
        for (int i = 0; i < 200; i++) {
            m.put(b.get(i), new HashMap<>(Map.of("ERRORS|errors", new Agg(8 + (i % 3), null))));
        }
        m.get(b.get(120)).put("ERRORS|errors", new Agg(60, null));
        Map<Instant, List<String>> flagged = RobustAnomalyRules.flag(b, m);
        assertEquals(1, flagged.size(), "busy but steady windows must not be flagged");
        assertTrue(flagged.get(b.get(120)).contains("SPIKE:ERRORS|errors"));
    }

    @Test
    void sparseCountsNeedAtLeastThreeEvents() {
        List<Instant> b = buckets(100);
        Map<Instant, Map<String, Agg>> m = new HashMap<>();
        m.put(b.get(10), new HashMap<>(Map.of("LEVEL|warn_lines", new Agg(2, null))));
        m.put(b.get(20), new HashMap<>(Map.of("LEVEL|warn_lines", new Agg(7, null))));
        Map<Instant, List<String>> flagged = RobustAnomalyRules.flag(b, m);
        assertFalse(flagged.containsKey(b.get(10)));
        assertTrue(flagged.containsKey(b.get(20)));
    }

    @Test
    void latencyIncidentCoveringTenPercentIsStillCaught() {
        // A 3x-p95 rule is blind here: 10% of windows are slow, so the p95 IS the incident.
        List<Instant> b = buckets(100);
        Map<Instant, Map<String, Agg>> m = new HashMap<>();
        for (int i = 0; i < 100; i++) {
            double p95 = i >= 40 && i < 50 ? 4000 : 80 + (i % 7);
            m.put(b.get(i), new HashMap<>(Map.of("API|api_latency_ms", new Agg(100, p95))));
        }
        Map<Instant, List<String>> flagged = RobustAnomalyRules.flag(b, m);
        assertEquals(10, flagged.size());
    }

    @Test
    void rareSignatureFlagsOnlyWhereItAppears() {
        List<Instant> b = buckets(200);
        Map<Instant, Map<String, Agg>> m = new HashMap<>();
        for (int i = 0; i < 200; i++) {
            m.put(b.get(i), new HashMap<>(Map.of("SIGNATURE|sig:aaaaaa:email retry", new Agg(1, null))));
        }
        m.get(b.get(77)).put("SIGNATURE|sig:bbbbbb:OutOfMemoryError", new Agg(1, null));
        Map<Instant, List<String>> flagged = RobustAnomalyRules.flag(b, m);
        assertEquals(List.of("RARE_SIGNATURE"), flagged.get(b.get(77)));
        assertEquals(1, flagged.size());
    }
}
