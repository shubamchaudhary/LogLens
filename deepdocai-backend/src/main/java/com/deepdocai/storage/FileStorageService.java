package com.deepdocai.storage;

import java.io.InputStream;
import java.util.UUID;

/**
 * Object storage for raw uploaded log archives (MinIO in this deployment).
 * File URLs are opaque {@code s3://bucket/key} strings owned by the
 * implementation.
 */
public interface FileStorageService {

    /**
     * Stage an upload under {@code {sessionId}/{documentId}} and return its
     * {@code s3://...} URL.
     */
    String store(UUID sessionId, UUID documentId, InputStream data, long size, String contentType);

    /** Open the object referenced by a URL returned from {@link #store}. */
    InputStream openStream(String fileUrl);

    /** Remove the object referenced by a URL returned from {@link #store}. */
    void delete(String fileUrl);
}
