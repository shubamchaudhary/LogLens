package com.deepdocai.analysis;

import com.deepdocai.storage.SessionChunkTableManager;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.math.BigDecimal;
import java.sql.Array;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Read-only JDBC access for the analysis query endpoints. The pipeline writes
 * {@code log_metrics}, {@code log_findings}, {@code incidents} and {@code reports}
 * via native SQL (there are no JPA entities for them), so reads go through raw
 * JDBC here too. Per-session chunk rows live in dynamically-named tables, whose
 * names are resolved exclusively through {@link SessionChunkTableManager#tableName(UUID)}
 * (validated-UUID → no injection).
 */
@Repository
public class AnalysisReadRepository {

    private final JdbcTemplate jdbc;
    private final SessionChunkTableManager tableManager;

    public AnalysisReadRepository(JdbcTemplate jdbc, SessionChunkTableManager tableManager) {
        this.jdbc = jdbc;
        this.tableManager = tableManager;
    }

    // ---- DTOs (serialized straight to JSON) --------------------------------

    public record MetricRow(
        Instant timeBucket, String category, String metric,
        long count, Long sumMs, BigDecimal avgMs, BigDecimal p95Ms,
        List<UUID> sampleChunkIds) {
    }

    public record FindingRow(
        UUID id, String category, String severity, String title, String explanation,
        List<UUID> evidenceChunkIds, Instant timeRangeStart, Instant timeRangeEnd,
        int occurrenceCount, BigDecimal confidence, Instant createdAt) {
    }

    public record IncidentRow(
        UUID id, Instant timeRangeStart, Instant timeRangeEnd, List<UUID> findingIds,
        String narrative, String rootCauseHypothesis, Instant createdAt) {
    }

    public record ReportRow(Instant generatedAt, String contentMd) {
    }

    public record EvidenceRow(
        UUID chunkId, UUID documentId, Instant timeBucket, Integer lineStart,
        Integer lineEnd, String content, boolean anomalous) {
    }

    // ---- Queries -----------------------------------------------------------

    /** Rolled-up metric buckets, optionally narrowed by category/metric/time window. */
    public List<MetricRow> metrics(UUID sessionId, String category, String metric, Instant from, Instant to) {
        StringBuilder sql = new StringBuilder(
            "SELECT time_bucket, category, metric, count, sum_ms, avg_ms, p95_ms, sample_chunk_ids "
            + "FROM log_metrics WHERE session_id = ?");
        List<Object> params = new ArrayList<>();
        params.add(sessionId);
        if (isSet(category)) {
            sql.append(" AND category = ?");
            params.add(category);
        }
        if (isSet(metric)) {
            sql.append(" AND metric = ?");
            params.add(metric);
        }
        if (from != null) {
            sql.append(" AND time_bucket >= ?");
            params.add(OffsetDateTime.ofInstant(from, ZoneOffset.UTC));
        }
        if (to != null) {
            sql.append(" AND time_bucket < ?");
            params.add(OffsetDateTime.ofInstant(to, ZoneOffset.UTC));
        }
        sql.append(" ORDER BY time_bucket, category, metric");
        return jdbc.query(sql.toString(), METRIC_MAPPER, params.toArray());
    }

    /** LLM findings, optionally narrowed by category/severity, worst severity first. */
    public List<FindingRow> findings(UUID sessionId, String category, String severity) {
        StringBuilder sql = new StringBuilder(
            "SELECT id, category, severity, title, explanation, evidence_chunk_ids, "
            + "time_range_start, time_range_end, occurrence_count, confidence, created_at "
            + "FROM log_findings WHERE session_id = ?");
        List<Object> params = new ArrayList<>();
        params.add(sessionId);
        if (isSet(category)) {
            sql.append(" AND category = ?");
            params.add(category);
        }
        if (isSet(severity)) {
            sql.append(" AND severity = ?");
            params.add(severity);
        }
        sql.append(" ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'ERROR' THEN 1 "
            + "WHEN 'WARN' THEN 2 ELSE 3 END, time_range_start NULLS LAST, created_at");
        return jdbc.query(sql.toString(), FINDING_MAPPER, params.toArray());
    }

    /** Correlated incidents for the session, earliest first. */
    public List<IncidentRow> incidents(UUID sessionId) {
        return jdbc.query(
            "SELECT id, time_range_start, time_range_end, finding_ids, narrative, "
            + "root_cause_hypothesis, created_at FROM incidents WHERE session_id = ? "
            + "ORDER BY time_range_start NULLS LAST, created_at",
            INCIDENT_MAPPER, sessionId);
    }

    /** The single final report for the session, if one has been generated. */
    public Optional<ReportRow> report(UUID sessionId) {
        return jdbc.query(
            "SELECT generated_at, content_md FROM reports WHERE session_id = ?",
            REPORT_MAPPER, sessionId).stream().findFirst();
    }

    /** Raw chunk rows backing the given evidence ids, drawn from the session's chunk table. */
    public List<EvidenceRow> evidence(UUID sessionId, List<UUID> chunkIds) {
        if (chunkIds == null || chunkIds.isEmpty()) {
            return List.of();
        }
        String table = tableManager.tableName(sessionId); // validated UUID → safe
        String sql = "SELECT chunk_id, document_id, time_bucket, line_start, line_end, content, "
            + "is_anomalous FROM " + table + " WHERE chunk_id = ANY(?) "
            + "ORDER BY time_bucket NULLS LAST, line_start";
        return jdbc.query(con -> {
            PreparedStatement ps = con.prepareStatement(sql);
            Array arr = con.createArrayOf("uuid", chunkIds.stream().map(UUID::toString).toArray());
            ps.setArray(1, arr);
            return ps;
        }, EVIDENCE_MAPPER);
    }

    // ---- Row mappers -------------------------------------------------------

    private static final RowMapper<MetricRow> METRIC_MAPPER = (rs, i) -> new MetricRow(
        readInstant(rs, "time_bucket"),
        rs.getString("category"),
        rs.getString("metric"),
        rs.getLong("count"),
        readLong(rs, "sum_ms"),
        rs.getBigDecimal("avg_ms"),
        rs.getBigDecimal("p95_ms"),
        readUuidArray(rs, "sample_chunk_ids"));

    private static final RowMapper<FindingRow> FINDING_MAPPER = (rs, i) -> new FindingRow(
        rs.getObject("id", UUID.class),
        rs.getString("category"),
        rs.getString("severity"),
        rs.getString("title"),
        rs.getString("explanation"),
        readUuidArray(rs, "evidence_chunk_ids"),
        readInstant(rs, "time_range_start"),
        readInstant(rs, "time_range_end"),
        rs.getInt("occurrence_count"),
        rs.getBigDecimal("confidence"),
        readInstant(rs, "created_at"));

    private static final RowMapper<IncidentRow> INCIDENT_MAPPER = (rs, i) -> new IncidentRow(
        rs.getObject("id", UUID.class),
        readInstant(rs, "time_range_start"),
        readInstant(rs, "time_range_end"),
        readUuidArray(rs, "finding_ids"),
        rs.getString("narrative"),
        rs.getString("root_cause_hypothesis"),
        readInstant(rs, "created_at"));

    private static final RowMapper<ReportRow> REPORT_MAPPER = (rs, i) -> new ReportRow(
        readInstant(rs, "generated_at"),
        rs.getString("content_md"));

    private static final RowMapper<EvidenceRow> EVIDENCE_MAPPER = (rs, i) -> new EvidenceRow(
        rs.getObject("chunk_id", UUID.class),
        rs.getObject("document_id", UUID.class),
        readInstant(rs, "time_bucket"),
        readInteger(rs, "line_start"),
        readInteger(rs, "line_end"),
        rs.getString("content"),
        rs.getBoolean("is_anomalous"));

    // ---- Column helpers ----------------------------------------------------

    private static boolean isSet(String s) {
        return s != null && !s.isBlank();
    }

    private static Instant readInstant(ResultSet rs, String col) throws SQLException {
        OffsetDateTime odt = rs.getObject(col, OffsetDateTime.class);
        return odt == null ? null : odt.toInstant();
    }

    private static Long readLong(ResultSet rs, String col) throws SQLException {
        long v = rs.getLong(col);
        return rs.wasNull() ? null : v;
    }

    private static Integer readInteger(ResultSet rs, String col) throws SQLException {
        int v = rs.getInt(col);
        return rs.wasNull() ? null : v;
    }

    private static List<UUID> readUuidArray(ResultSet rs, String col) throws SQLException {
        Array a = rs.getArray(col);
        if (a == null) {
            return List.of();
        }
        Object raw = a.getArray();
        if (!(raw instanceof Object[] arr)) {
            return List.of();
        }
        List<UUID> out = new ArrayList<>(arr.length);
        for (Object o : arr) {
            if (o == null) {
                continue;
            }
            out.add(o instanceof UUID u ? u : UUID.fromString(o.toString()));
        }
        return out;
    }
}
