package com.deepdocai.common.messages;

import java.util.List;
import java.util.UUID;

/**
 * A single unit of LLM work on the enrichment lane ({@code llm.enrich.requests}).
 *
 * <p>Two kinds share the topic so they ride the same partition-per-API-key lanes:
 * <ul>
 *   <li>{@link #ENRICH_WINDOW} — explain one anomalous window; {@code chunkIds}
 *       holds that window's chunk id(s).</li>
 *   <li>{@link #EMBED_BATCH} — embed up to 80 chunks; {@code chunkIds} holds the
 *       batch.</li>
 * </ul>
 *
 * @param workId          unique id for this work item (stable across retries;
 *                        also selects the partition/key).
 * @param sessionId       owning session.
 * @param kind            {@link #ENRICH_WINDOW} or {@link #EMBED_BATCH}.
 * @param chunkIds        chunk ids this item operates on.
 * @param attempt         delivery attempt (0 first time; {@code >= 3} → DLQ).
 * @param notBeforeEpochMs earliest epoch-ms this item may be re-released from the
 *                        retry lane (0 for the first attempt).
 */
public record EnrichRequest(
    UUID workId,
    UUID sessionId,
    String kind,
    List<UUID> chunkIds,
    int attempt,
    long notBeforeEpochMs
) {
    public static final String ENRICH_WINDOW = "ENRICH_WINDOW";
    public static final String EMBED_BATCH = "EMBED_BATCH";

    /** A copy with the attempt counter bumped and a new not-before deadline. */
    public EnrichRequest retry(long notBeforeEpochMs) {
        return new EnrichRequest(workId, sessionId, kind, chunkIds, attempt + 1, notBeforeEpochMs);
    }
}
