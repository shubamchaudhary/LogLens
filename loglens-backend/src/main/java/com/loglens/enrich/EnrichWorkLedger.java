package com.loglens.enrich;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.UUID;

/**
 * Idempotency ledger for the enrichment lane, the twin of
 * {@link com.loglens.ingest.IngestPartRepository}: one row per {@code workId}
 * that has committed its effects. {@link #claim} runs inside the same
 * transaction as the findings/embedding writes and the completion counter, so a
 * redelivered or replayed work item inserts 0 rows and writes nothing.
 */
@Repository
public class EnrichWorkLedger {

    private final JdbcTemplate jdbc;

    public EnrichWorkLedger(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** Cheap pre-check so a replayed item does not even call the LLM again. */
    public boolean isDone(UUID workId) {
        Integer n = jdbc.queryForObject(
            "SELECT count(*) FROM enrich_work_done WHERE work_id = ?", Integer.class, workId);
        return n != null && n > 0;
    }

    /** Insert the marker; {@code true} only for the first committer of this work id. */
    public boolean claim(UUID workId, UUID sessionId) {
        return jdbc.update(
            "INSERT INTO enrich_work_done (work_id, session_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
            workId, sessionId) == 1;
    }
}
