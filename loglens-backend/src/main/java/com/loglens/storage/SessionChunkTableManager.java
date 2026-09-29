package com.loglens.storage;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Provisions and drops the per-session chunk table {@code log_chunks_s_<tid>}
 * (template lives at the bottom of schema-v2.sql), where {@code <tid>} is the
 * session UUID with hyphens replaced by underscores.
 *
 * <p><strong>Injection guard:</strong> table and index names are derived
 * exclusively from a validated UUID — the input is never a raw string, so no
 * user data is ever spliced into DDL.
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class SessionChunkTableManager {

    private static final String PREFIX = "log_chunks_s_";
    private static final Pattern UUID_RE = Pattern.compile(
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$");

    private final JdbcTemplate jdbcTemplate;

    /** {@code log_chunks_s_<uuid-with-underscores>} for a validated UUID. */
    public String tableName(UUID sessionId) {
        String s = sessionId.toString();
        if (!UUID_RE.matcher(s).matches()) {
            throw new IllegalArgumentException("Refusing to build a table name from a non-UUID: " + sessionId);
        }
        return PREFIX + s.replace('-', '_');
    }

    public void createFor(UUID sessionId) {
        String table = tableName(sessionId);
        String tid = table.substring(PREFIX.length());

        jdbcTemplate.execute(
            "CREATE TABLE IF NOT EXISTS " + table + " (" +
            "chunk_id UUID PRIMARY KEY DEFAULT uuid_generate_v4()," +
            "document_id UUID NOT NULL," +
            "time_bucket TIMESTAMPTZ NOT NULL," +
            "line_start INTEGER," +
            "line_end INTEGER," +
            "content TEXT NOT NULL," +
            "embedding vector(768)," +
            "is_anomalous BOOLEAN DEFAULT FALSE," +
            "created_at TIMESTAMPTZ DEFAULT NOW()," +
            // Stored once at insert: ts_rank over the expression recomputed the
            // tsvector of every matching 16 KB chunk per query (~1.4 s p50).
            "content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED)");

        jdbcTemplate.execute(
            "CREATE INDEX IF NOT EXISTS idx_lc_" + tid + "_hnsw ON " + table +
            " USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)");
        jdbcTemplate.execute(
            "CREATE INDEX IF NOT EXISTS idx_lc_" + tid + "_fts ON " + table +
            " USING gin (content_tsv)");
        jdbcTemplate.execute(
            "CREATE INDEX IF NOT EXISTS idx_lc_" + tid + "_time ON " + table + " (time_bucket)");

        log.info("Provisioned per-session chunk table {}", table);
    }

    public void dropFor(UUID sessionId) {
        String table = tableName(sessionId);
        jdbcTemplate.execute("DROP TABLE IF EXISTS " + table);
        log.info("Dropped per-session chunk table {}", table);
    }
}
