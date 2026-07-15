package com.deepdocai.ingest;

import org.springframework.jdbc.core.BatchPreparedStatementSetter;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Types;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Writes Layer-1 measurements to {@code log_metrics} with an idempotent upsert on
 * the natural key {@code (session_id, time_bucket, category, metric)}. Additive
 * merge semantics make at-least-once Kafka redelivery safe: re-processing the
 * same window sums into the existing row rather than duplicating it.
 */
@Component
public class MetricsWriter {

    private static final String UPSERT_SQL =
        "INSERT INTO log_metrics " +
        "(session_id, time_bucket, category, metric, count, sum_ms, avg_ms, p95_ms, sample_chunk_ids) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ARRAY[?]::uuid[]) " +
        "ON CONFLICT (session_id, time_bucket, category, metric) DO UPDATE SET " +
        "count = log_metrics.count + EXCLUDED.count, " +
        "sum_ms = COALESCE(log_metrics.sum_ms, 0) + COALESCE(EXCLUDED.sum_ms, 0), " +
        "avg_ms = CASE WHEN (log_metrics.count + EXCLUDED.count) > 0 " +
        "  THEN (COALESCE(log_metrics.sum_ms, 0) + COALESCE(EXCLUDED.sum_ms, 0))::numeric " +
        "       / (log_metrics.count + EXCLUDED.count) ELSE NULL END, " +
        "p95_ms = GREATEST(COALESCE(log_metrics.p95_ms, 0), COALESCE(EXCLUDED.p95_ms, 0)), " +
        "sample_chunk_ids = " +
        "  (COALESCE(log_metrics.sample_chunk_ids, '{}'::uuid[]) || EXCLUDED.sample_chunk_ids)[1:20]";

    private final JdbcTemplate jdbc;

    public MetricsWriter(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** One metric to upsert; {@code time_bucket} and {@code sampleChunkId} come from the window. */
    public record MetricUpsert(
        Instant timeBucket,
        String category,
        String metric,
        long count,
        Long sumMs,
        Double avgMs,
        Double p95Ms,
        UUID sampleChunkId
    ) {
    }

    @Transactional
    public void upsert(UUID sessionId, List<MetricUpsert> rows) {
        if (rows.isEmpty()) {
            return;
        }
        jdbc.batchUpdate(UPSERT_SQL, new BatchPreparedStatementSetter() {
            @Override
            public void setValues(PreparedStatement ps, int i) throws SQLException {
                MetricUpsert r = rows.get(i);
                ps.setObject(1, sessionId);
                ps.setObject(2, r.timeBucket().atOffset(ZoneOffset.UTC));
                ps.setString(3, r.category());
                ps.setString(4, r.metric());
                ps.setLong(5, r.count());
                if (r.sumMs() != null) {
                    ps.setLong(6, r.sumMs());
                } else {
                    ps.setNull(6, Types.BIGINT);
                }
                if (r.avgMs() != null) {
                    ps.setBigDecimal(7, java.math.BigDecimal.valueOf(r.avgMs()));
                } else {
                    ps.setNull(7, Types.NUMERIC);
                }
                if (r.p95Ms() != null) {
                    ps.setBigDecimal(8, java.math.BigDecimal.valueOf(r.p95Ms()));
                } else {
                    ps.setNull(8, Types.NUMERIC);
                }
                ps.setString(9, r.sampleChunkId().toString());
            }

            @Override
            public int getBatchSize() {
                return rows.size();
            }
        });
    }

    /**
     * Compact, human-readable metric lines for the window(s) covered by
     * {@code buckets} — fed to the enrichment prompt as the authoritative,
     * parser-extracted context so the model explains numbers it cannot see in the
     * raw lines alone. Queried as a {@code [min,max]} bucket range (for a single
     * window min == max, i.e. that exact minute).
     */
    public List<String> metricContext(UUID sessionId, List<Instant> buckets) {
        if (buckets == null || buckets.isEmpty()) {
            return List.of();
        }
        Instant min = buckets.get(0);
        Instant max = buckets.get(0);
        for (Instant b : buckets) {
            if (b.isBefore(min)) {
                min = b;
            }
            if (b.isAfter(max)) {
                max = b;
            }
        }
        final OffsetDateTime lo = min.atOffset(ZoneOffset.UTC);
        final OffsetDateTime hi = max.atOffset(ZoneOffset.UTC);
        String sql = "SELECT category, metric, count, avg_ms, p95_ms FROM log_metrics " +
            "WHERE session_id = ? AND time_bucket >= ? AND time_bucket <= ? ORDER BY category, metric";

        List<String> lines = new ArrayList<>();
        jdbc.query(
            con -> {
                PreparedStatement ps = con.prepareStatement(sql);
                ps.setObject(1, sessionId);
                ps.setObject(2, lo);
                ps.setObject(3, hi);
                return ps;
            },
            rs -> {
                StringBuilder sb = new StringBuilder();
                sb.append(rs.getString("category")).append('.').append(rs.getString("metric"))
                    .append(" count=").append(rs.getLong("count"));
                java.math.BigDecimal avg = rs.getBigDecimal("avg_ms");
                if (avg != null) {
                    sb.append(" avg=").append(avg.stripTrailingZeros().toPlainString()).append("ms");
                }
                java.math.BigDecimal p95 = rs.getBigDecimal("p95_ms");
                if (p95 != null) {
                    sb.append(" p95=").append(p95.stripTrailingZeros().toPlainString()).append("ms");
                }
                lines.add(sb.toString());
            });
        return lines;
    }
}
