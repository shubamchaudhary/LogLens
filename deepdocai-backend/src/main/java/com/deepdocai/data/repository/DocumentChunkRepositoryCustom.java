package com.deepdocai.data.repository;

import com.deepdocai.data.entity.DocumentChunk;
import java.util.List;
import java.util.UUID;

public interface DocumentChunkRepositoryCustom {
    /**
     * Find similar chunks with chat scope support.
     * @param userId User ID
     * @param queryEmbedding Query embedding vector string
     * @param documentIds Optional document IDs to filter by
     * @param chatId Chat ID for chat-scoped search (null for cross-chat search)
     * @param useCrossChat If true, search across all user's chats (ignores chatId)
     * @param limit Maximum number of results
     * @return List of similar chunks
     */
    List<DocumentChunk> findSimilarChunksCustom(
        UUID userId,
        String queryEmbedding,
        UUID[] documentIds,
        UUID chatId,
        boolean useCrossChat,
        int limit
    );
    
    /**
     * Batch save document chunks with embeddings using native SQL.
     * This avoids Hibernate's float[] to pgvector mapping issues.
     * @param chunks List of chunks to save (must have embeddings as float[])
     */
    void batchSaveChunksWithEmbeddings(List<DocumentChunk> chunks);
}

