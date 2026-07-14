package com.deepdocai.llm.service;

/**
 * @deprecated Replaced by {@link com.deepdocai.llm.embedding.BatchEmbeddingService}.
 * Batch embedding with 5-thread worker pool is now used for all embedding operations.
 * This file is kept only as a placeholder — no Spring bean is registered here.
 */
@Deprecated
final class EmbeddingServiceLegacy {
    private EmbeddingServiceLegacy() {}
}
