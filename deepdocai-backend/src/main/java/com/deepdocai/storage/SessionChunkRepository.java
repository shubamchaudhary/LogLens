package com.deepdocai.storage;

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
