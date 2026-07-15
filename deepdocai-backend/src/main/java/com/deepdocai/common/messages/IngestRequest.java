package com.deepdocai.common.messages;

import java.util.UUID;

/**
 * Produced to {@code log.ingest.requests} when an upload has been staged in
 * MinIO. The ingest consumer (Phase 2) streams the file back from
 * {@code fileUrl}, chunks it, and provisions Layer-1 metrics.
 */
public record IngestRequest(
    UUID sessionId,
    UUID userId,
    UUID documentId,
    String fileUrl
) {
}
