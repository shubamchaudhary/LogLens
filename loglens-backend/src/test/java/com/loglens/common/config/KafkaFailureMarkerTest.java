package com.loglens.common.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import org.junit.jupiter.api.Test;

class KafkaFailureMarkerTest {

    @Test
    void reasonWithNulByteBecomesStorable() {
        // The Postgres error for a NUL byte quotes the offending row, NUL included.
        String reason = KafkaFailureMarker.truncate("Part 3 failed: ... 'ERROR binary \u0000\u0000 payload' ...", 1000);
        assertFalse(reason.indexOf('\u0000') >= 0);
        assertEquals("Part 3 failed: ... 'ERROR binary �� payload' ...", reason);
    }

    @Test
    void longReasonIsTruncated() {
        assertEquals(1000, KafkaFailureMarker.truncate("x".repeat(5000), 1000).length());
    }
}
