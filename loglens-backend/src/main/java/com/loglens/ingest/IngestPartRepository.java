package com.loglens.ingest;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.UUID;

/**
 * Idempotency marker for partitioned ingest. The marker insert runs inside the
 * SAME transaction as a part's chunk/metric writes (no {@code @Transactional} here
 * — it joins the ambient transaction), so a redelivered part hits the primary-key
 * conflict, inserts 0 rows, and the caller skips all of the part's writes: an
 * exactly-once EFFECT on Kafka's at-least-once delivery.
 */
@Repository
public class IngestPartRepository {

    private final JdbcTemplate jdbc;

    public IngestPartRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Claim a part by inserting its marker. Returns {@code true} if THIS caller
     * inserted the marker (proceed with the writes); {@code false} if it already
     * existed (redelivery — skip everything).
     */
    /**
     * Cheap pre-check before any I/O. A part replayed after its document was
     * finalized must be skipped BEFORE the ranged read: the finalizer deletes the
     * staged blob, so reading first turned a harmless replay into a failure that
     * dead-lettered the part and marked a finished session FAILED (bench/chaos.py
     * replay scenario). {@link #claimPart} stays the authoritative guard.
     */
    public boolean isProcessed(UUID documentId, int partIdx) {
        Integer n = jdbc.queryForObject(
            "SELECT count(*) FROM ingest_parts WHERE document_id = ? AND part_idx = ?", Integer.class,
            documentId, partIdx);
        return n != null && n > 0;
    }

    public boolean claimPart(UUID documentId, int partIdx) {
        int rows = jdbc.update(
            "INSERT INTO ingest_parts (document_id, part_idx) VALUES (?, ?) ON CONFLICT DO NOTHING",
            documentId, partIdx);
        return rows == 1;
    }
}
