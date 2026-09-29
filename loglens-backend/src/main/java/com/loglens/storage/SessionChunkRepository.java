package com.loglens.storage;

import org.springframework.jdbc.core.BatchPreparedStatementSetter;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.sql.Array;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * JDBC data access for the per-session chunk tables {@code log_chunks_s_<tid>}.
 * These tables are created dynamically per session, so JPA cannot map them; all
 * access goes through raw JDBC. Table names are resolved exclusively via
 * {@link SessionChunkTableManager#tableName(UUID)}, which validates the session
 * id is a real UUID before it is spliced into SQL (injection guard).
 */
@Repository
public class SessionChunkRepository {

    private static final int BATCH_SIZE = 500;

    private final JdbcTemplate jdbc;
    private final SessionChunkTableManager tableManager;

    public SessionChunkRepository(JdbcTemplate jdbc, SessionChunkTableManager tableManager) {
        this.jdbc = jdbc;
        this.tableManager = tableManager;
    }

    /** A chunk to persist. {@code chunkId} is assigned by the caller before insert. */
    public record NewChunk(
        UUID chunkId,
        UUID documentId,
        Instant timeBucket,
        int lineStart,
        int lineEnd,
        String content,
        boolean anomalous
    ) {
    }

    /**
     * Batch-insert chunks into the session's table in fixed-size JDBC batches
     * (500 rows per statement). Embeddings are left {@code NULL} here and filled
     * later by the Phase-3 enrichment lane.
     */
    @Transactional
    public int insertBatch(UUID sessionId, List<NewChunk> chunks) {
        if (chunks.isEmpty()) {
            return 0;
        }
        String table = tableManager.tableName(sessionId); // validated UUID → safe
        String sql = "INSERT INTO " + table +
            " (chunk_id, document_id, time_bucket, line_start, line_end, content, is_anomalous)" +
            " VALUES (?, ?, ?, ?, ?, ?, ?)";

        int inserted = 0;
        for (int start = 0; start < chunks.size(); start += BATCH_SIZE) {
            List<NewChunk> slice = chunks.subList(start, Math.min(start + BATCH_SIZE, chunks.size()));
            jdbc.batchUpdate(sql, new BatchPreparedStatementSetter() {
                @Override
                public void setValues(PreparedStatement ps, int i) throws SQLException {
                    NewChunk c = slice.get(i);
                    ps.setObject(1, c.chunkId());
                    ps.setObject(2, c.documentId());
                    ps.setObject(3, c.timeBucket().atOffset(ZoneOffset.UTC));
                    ps.setInt(4, c.lineStart());
                    ps.setInt(5, c.lineEnd());
                    ps.setString(6, c.content());
                    ps.setBoolean(7, c.anomalous());
                }

                @Override
                public int getBatchSize() {
                    return slice.size();
                }
            });
            inserted += slice.size();
        }
        return inserted;
    }

    /** Remove any chunks already staged for a document — makes re-ingest idempotent. */
    @Transactional
    public void deleteByDocument(UUID sessionId, UUID documentId) {
        String table = tableManager.tableName(sessionId); // validated UUID → safe
        jdbc.update("DELETE FROM " + table + " WHERE document_id = ?", documentId);
    }

    /** A chunk id + whether it is (finally) flagged anomalous — the finalizer's fan-out input. */
    public record ChunkRef(UUID chunkId, boolean anomalous) {
    }

    /** All chunk refs for a document, for the finalizer's enrichment fan-out. */
    public List<ChunkRef> listChunkRefs(UUID sessionId, UUID documentId) {
        String table = tableManager.tableName(sessionId); // validated UUID → safe
        return jdbc.query(
            "SELECT chunk_id, is_anomalous FROM " + table + " WHERE document_id = ? ORDER BY line_start",
            (rs, i) -> new ChunkRef(rs.getObject("chunk_id", UUID.class), rs.getBoolean("is_anomalous")),
            documentId);
    }

    /**
     * Global latency-outlier rule (replaces AnomalyDetector's in-memory p95 pass):
     * compute the corpus p95 per latency metric with SQL {@code percentile_cont},
     * then flag every chunk whose time bucket has a latency &gt; 3× that p95. Runs
     * once, in the finalizer, over metrics already in Postgres. Returns rows flagged.
     */
    @Transactional
    public int flagLatencyOutliers(UUID sessionId) {
        String table = tableManager.tableName(sessionId); // validated UUID → safe
        String sql =
            "WITH corpus AS (" +
            "  SELECT category, metric, " +
            "    percentile_cont(0.95) WITHIN GROUP (ORDER BY p95_ms::double precision) AS p95 " +
            "  FROM log_metrics WHERE session_id = ? AND p95_ms IS NOT NULL " +
            "  GROUP BY category, metric" +
            "), outlier_buckets AS (" +
            "  SELECT DISTINCT m.time_bucket FROM log_metrics m " +
            "  JOIN corpus c ON m.category = c.category AND m.metric = c.metric " +
            "  WHERE m.session_id = ? AND c.p95 > 0 AND m.p95_ms > 3 * c.p95" +
            ") UPDATE " + table + " lc SET is_anomalous = true " +
            "WHERE lc.is_anomalous = false " +
            "AND lc.time_bucket IN (SELECT time_bucket FROM outlier_buckets)";
        return jdbc.update(sql, sessionId, sessionId);
    }

    /**
     * Robust corpus rules ({@code loglens.anomaly.mode=robust}), the SQL twin of
     * {@link com.loglens.ingest.RobustAnomalyRules}: count spikes by modified
     * z-score (median + MAD) over every bucket of the session, latency spikes
     * against the median, and rare WARN/ERROR signatures. One statement, run once
     * by the finalizer over data already in Postgres. Returns chunks flagged.
     */
    @Transactional
    public int flagRobustOutliers(UUID sessionId) {
        String table = tableManager.tableName(sessionId); // validated UUID → safe
        StringBuilder soft = new StringBuilder();
        for (String key : com.loglens.ingest.RobustAnomalyRules.SOFT_METRICS) {
            String[] p = key.split("\\|");
            soft.append(soft.length() == 0 ? "" : ",").append("('").append(p[0]).append("','").append(p[1]).append("')");
        }
        double z = com.loglens.ingest.RobustAnomalyRules.Z;
        double k = com.loglens.ingest.RobustAnomalyRules.MAD_SCALE;
        String sql =
            "WITH b AS (SELECT DISTINCT time_bucket FROM " + table + "), " +
            "nb AS (SELECT count(*)::float8 AS n FROM b), " +
            "soft(category, metric) AS (VALUES " + soft + "), " +
            "grid AS (SELECT b.time_bucket, s.category, s.metric, COALESCE(m.count, 0)::float8 AS c " +
            "  FROM b CROSS JOIN soft s LEFT JOIN log_metrics m ON m.session_id = ? " +
            "  AND m.time_bucket = b.time_bucket AND m.category = s.category AND m.metric = s.metric), " +
            "gmed AS (SELECT category, metric, percentile_cont(0.5) WITHIN GROUP (ORDER BY c) AS med " +
            "  FROM grid GROUP BY 1, 2), " +
            "gmad AS (SELECT g.category, g.metric, percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(g.c - x.med)) AS mad " +
            "  FROM grid g JOIN gmed x USING (category, metric) GROUP BY 1, 2), " +
            "spike AS (SELECT g.time_bucket FROM grid g JOIN gmed USING (category, metric) JOIN gmad USING (category, metric) " +
            "  WHERE g.c >= " + com.loglens.ingest.RobustAnomalyRules.MIN_COUNT +
            "  AND g.c > gmed.med + " + z + " * GREATEST(" + k + " * gmad.mad, 1)), " +
            "lat AS (SELECT time_bucket, category, metric, p95_ms::float8 AS v FROM log_metrics " +
            "  WHERE session_id = ? AND p95_ms IS NOT NULL), " +
            "lmed AS (SELECT category, metric, percentile_cont(0.5) WITHIN GROUP (ORDER BY v) AS med FROM lat GROUP BY 1, 2), " +
            "lmad AS (SELECT l.category, l.metric, percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(l.v - x.med)) AS mad " +
            "  FROM lat l JOIN lmed x USING (category, metric) GROUP BY 1, 2), " +
            "slow AS (SELECT l.time_bucket FROM lat l JOIN lmed USING (category, metric) JOIN lmad USING (category, metric) " +
            "  WHERE l.v > " + com.loglens.ingest.RobustAnomalyRules.LATENCY_MIN_RATIO + " * lmed.med " +
            "  AND l.v > lmed.med + " + z + " * GREATEST(" + k + " * lmad.mad, 1)), " +
            "sig AS (SELECT metric, count(DISTINCT time_bucket) AS buckets FROM log_metrics " +
            "  WHERE session_id = ? AND category = 'SIGNATURE' GROUP BY metric), " +
            "rare AS (SELECT m.time_bucket FROM log_metrics m JOIN sig USING (metric) CROSS JOIN nb " +
            "  WHERE m.session_id = ? AND m.category = 'SIGNATURE' " +
            "  AND sig.buckets <= GREATEST(1, " + com.loglens.ingest.RobustAnomalyRules.RARE_SHARE + " * nb.n)), " +
            "flag AS (SELECT time_bucket FROM spike UNION SELECT time_bucket FROM slow UNION SELECT time_bucket FROM rare) " +
            "UPDATE " + table + " lc SET is_anomalous = true " +
            "WHERE lc.is_anomalous = false AND lc.time_bucket IN (SELECT time_bucket FROM flag)";
        return jdbc.update(sql, sessionId, sessionId, sessionId, sessionId);
    }

    /** A chunk's stored text plus its window bucket, for building enrichment prompts. */
    public record ChunkContent(UUID chunkId, Instant timeBucket, String content) {
    }

    /**
     * Load the given chunks (content + window bucket) from the session's table,
     * returned in the same order as {@code chunkIds}. Missing ids are skipped.
     */
    public List<ChunkContent> readChunks(UUID sessionId, List<UUID> chunkIds) {
        if (chunkIds == null || chunkIds.isEmpty()) {
            return List.of();
        }
        String table = tableManager.tableName(sessionId); // validated UUID → safe
        String sql = "SELECT chunk_id, time_bucket, content FROM " + table + " WHERE chunk_id = ANY(?)";

        Map<UUID, ChunkContent> byId = new LinkedHashMap<>();
        jdbc.query(
            con -> {
                PreparedStatement ps = con.prepareStatement(sql);
                Array arr = con.createArrayOf("uuid", chunkIds.stream().map(UUID::toString).toArray());
                ps.setArray(1, arr);
                return ps;
            },
            rs -> {
                UUID id = rs.getObject("chunk_id", UUID.class);
                Instant bucket = rs.getObject("time_bucket", java.time.OffsetDateTime.class).toInstant();
                byId.put(id, new ChunkContent(id, bucket, rs.getString("content")));
            });

        List<ChunkContent> ordered = new ArrayList<>(chunkIds.size());
        for (UUID id : chunkIds) {
            ChunkContent c = byId.get(id);
            if (c != null) {
                ordered.add(c);
            }
        }
        return ordered;
    }

    /** A computed embedding for one chunk, as a pgvector text literal (e.g. {@code [0.1,...]}). */
    public record ChunkEmbedding(UUID chunkId, String vectorLiteral) {
    }

    /**
     * Batch-write embeddings into the session's chunk table. The vector is bound as
     * text and cast to {@code vector} by Postgres. No-op for an empty list.
     */
    @Transactional
    public int updateEmbeddings(UUID sessionId, List<ChunkEmbedding> embeddings) {
        if (embeddings == null || embeddings.isEmpty()) {
            return 0;
        }
        String table = tableManager.tableName(sessionId); // validated UUID → safe
        String sql = "UPDATE " + table + " SET embedding = ?::vector WHERE chunk_id = ?";

        int[] counts = jdbc.batchUpdate(sql, new BatchPreparedStatementSetter() {
            @Override
            public void setValues(PreparedStatement ps, int i) throws SQLException {
                ChunkEmbedding e = embeddings.get(i);
                ps.setString(1, e.vectorLiteral());
                ps.setObject(2, e.chunkId());
            }

            @Override
            public int getBatchSize() {
                return embeddings.size();
            }
        });
        int updated = 0;
        for (int c : counts) {
            updated += Math.max(c, 0);
        }
        return updated;
    }
}
