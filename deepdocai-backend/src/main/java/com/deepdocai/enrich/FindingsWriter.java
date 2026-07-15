package com.deepdocai.enrich;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.sql.Array;
import java.sql.PreparedStatement;
import java.sql.Types;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;

/**
 * Idempotent writer for {@code log_findings}. Dedups on the natural key
 * {@code (session_id, fingerprint)}: the same recurring anomaly bumps
 * {@code occurrence_count} and merges its evidence/time-range into the existing
 * row instead of inserting a duplicate — which is exactly what keeps at-least-once
 * Kafka redelivery and repeated windows from inflating the findings list.
 */
@Repository
public class FindingsWriter {

    private static final String UPSERT_SQL =
        "INSERT INTO log_findings " +
        "(session_id, category, severity, title, explanation, evidence_chunk_ids, " +
        " time_range_start, time_range_end, fingerprint, confidence) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (session_id, fingerprint) DO UPDATE SET " +
        "occurrence_count = log_findings.occurrence_count + 1, " +
        "evidence_chunk_ids = ARRAY(SELECT DISTINCT unnest(" +
        "  log_findings.evidence_chunk_ids || EXCLUDED.evidence_chunk_ids)), " +
        "time_range_start = LEAST(log_findings.time_range_start, EXCLUDED.time_range_start), " +
        "time_range_end = GREATEST(log_findings.time_range_end, EXCLUDED.time_range_end), " +
        "explanation = EXCLUDED.explanation, " +
        "severity = EXCLUDED.severity, " +
        "confidence = EXCLUDED.confidence";

    private final JdbcTemplate jdbc;

    public FindingsWriter(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** A finding to persist. Evidence ids and time range are supplied by code, not the model. */
    public record Finding(
        UUID sessionId,
        String category,
        String severity,
        String title,
        String explanation,
        List<UUID> evidenceChunkIds,
        Instant timeRangeStart,
        Instant timeRangeEnd,
        String fingerprint,
        Double confidence
    ) {
    }

    @Transactional
    public void upsert(Finding f) {
        jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement(UPSERT_SQL);
            ps.setObject(1, f.sessionId());
            ps.setString(2, f.category());
            ps.setString(3, f.severity());
            ps.setString(4, f.title());
            ps.setString(5, f.explanation());
            Array evidence = con.createArrayOf("uuid",
                f.evidenceChunkIds().stream().map(UUID::toString).toArray());
            ps.setArray(6, evidence);
            setTimestamp(ps, 7, f.timeRangeStart());
            setTimestamp(ps, 8, f.timeRangeEnd());
            ps.setString(9, f.fingerprint());
            if (f.confidence() != null) {
                ps.setBigDecimal(10, BigDecimal.valueOf(f.confidence()));
            } else {
                ps.setNull(10, Types.NUMERIC);
            }
            return ps;
        });
    }

    private static void setTimestamp(PreparedStatement ps, int index, Instant value) throws java.sql.SQLException {
        if (value != null) {
            ps.setObject(index, OffsetDateTime.ofInstant(value, ZoneOffset.UTC));
        } else {
            ps.setNull(index, Types.TIMESTAMP_WITH_TIMEZONE);
        }
    }
}
