package com.deepdocai.data.repository;

import com.deepdocai.data.entity.DocumentChunk;
import jakarta.persistence.EntityManager;
import jakarta.persistence.PersistenceContext;
import jakarta.persistence.Query;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

@Repository
@Slf4j
public class DocumentChunkRepositoryImpl implements DocumentChunkRepositoryCustom {
    
    @PersistenceContext
    private EntityManager entityManager;
    
    @Override
    public List<DocumentChunk> findSimilarChunksCustom(
        UUID userId,
        String queryEmbedding,
        UUID[] documentIds,
        UUID chatId,
        boolean useCrossChat,
        int limit
    ) {
        String sql;
        Query query;
        
        // Build WHERE clause based on search scope
        StringBuilder sqlBuilder = new StringBuilder();
        sqlBuilder.append("SELECT dc.id FROM document_chunks dc ");
        sqlBuilder.append("JOIN documents d ON dc.document_id = d.id ");
        sqlBuilder.append("WHERE dc.user_id = :userId ");
        sqlBuilder.append("AND d.processing_status = 'COMPLETED' ");
        
        // Strict filtering: When useCrossChat is false, MUST filter by chatId
        // When useCrossChat is true, search across all user's chats (no chatId filter)
        if (!useCrossChat) {
            if (chatId == null) {
                // If chatId is null and useCrossChat is false, return empty results (no chat specified)
                log.warn("useCrossChat is false but chatId is null - returning empty results");
                return List.of();
            }
            sqlBuilder.append("AND dc.chat_id = :chatId ");
            log.debug("Filtering by chatId: {} (useCrossChat: false)", chatId);
        } else {
            log.debug("Searching across all chats (useCrossChat: true)");
        }
        
        if (documentIds != null && documentIds.length > 0) {
            sqlBuilder.append("AND dc.document_id = ANY(CAST(:documentIds AS uuid[])) ");
        }
        
        sqlBuilder.append("ORDER BY dc.embedding <=> CAST(:queryEmbedding AS vector) ");
        sqlBuilder.append("LIMIT :limit");
        
        sql = sqlBuilder.toString();
        query = entityManager.createNativeQuery(sql);
        query.setParameter("userId", userId);
        query.setParameter("queryEmbedding", queryEmbedding);
        query.setParameter("limit", limit);
        
        if (documentIds != null && documentIds.length > 0) {
            query.setParameter("documentIds", documentIds);
        }
        
        if (!useCrossChat && chatId != null) {
            query.setParameter("chatId", chatId);
        }
        
        @SuppressWarnings("unchecked")
        List<Object> idResults = query.getResultList();
        
        // Convert to UUIDs and load full entities
        List<UUID> chunkIds = idResults.stream()
            .map(id -> UUID.fromString(id.toString()))
            .collect(Collectors.toList());
        
        if (chunkIds.isEmpty()) {
            return List.of();
        }
        
        // Load entities using native query that excludes embedding column to avoid vector type issues
        // Add additional chatId filter for safety (double-check)
        StringBuilder loadSqlBuilder = new StringBuilder();
        loadSqlBuilder.append("""
            SELECT id, document_id, user_id, chat_id, chunk_index, content, content_hash, 
                   page_number, slide_number, section_title, token_count, created_at
            FROM document_chunks
            WHERE id = ANY(CAST(:ids AS uuid[]))
            """);
        
        // Add chatId filter if not using cross-chat search (extra safety check)
        if (!useCrossChat && chatId != null) {
            loadSqlBuilder.append(" AND chat_id = :chatId ");
        }
        
        Query loadQuery = entityManager.createNativeQuery(loadSqlBuilder.toString());
        loadQuery.setParameter("ids", chunkIds.toArray(new UUID[0]));
        
        if (!useCrossChat && chatId != null) {
            loadQuery.setParameter("chatId", chatId);
        }
        
        @SuppressWarnings("unchecked")
        List<Object[]> results = loadQuery.getResultList();
        
        // Map results to DocumentChunk entities
        Map<UUID, DocumentChunk> chunkMap = new LinkedHashMap<>();
        for (Object[] row : results) {
            UUID id = (UUID) row[0];
            UUID docId = (UUID) row[1];
            UUID chunkUserId = (UUID) row[2];
            UUID chunkChatId = (UUID) row[3];
            Integer chunkIndex = (Integer) row[4];
            String content = (String) row[5];
            String contentHash = (String) row[6];
            Integer pageNumber = row[7] != null ? (Integer) row[7] : null;
            Integer slideNumber = row[8] != null ? (Integer) row[8] : null;
            String sectionTitle = (String) row[9];
            Integer tokenCount = row[10] != null ? (Integer) row[10] : null;
            java.time.Instant createdAt = null;
            if (row[11] != null) {
                if (row[11] instanceof java.time.Instant) {
                    createdAt = (java.time.Instant) row[11];
                } else if (row[11] instanceof java.sql.Timestamp) {
                    createdAt = ((java.sql.Timestamp) row[11]).toInstant();
                } else if (row[11] instanceof java.time.OffsetDateTime) {
                    createdAt = ((java.time.OffsetDateTime) row[11]).toInstant();
                }
            }
            
            DocumentChunk chunk = DocumentChunk.builder()
                .id(id)
                .userId(chunkUserId)
                .chatId(chunkChatId)
                .chunkIndex(chunkIndex)
                .content(content)
                .contentHash(contentHash)
                .pageNumber(pageNumber)
                .slideNumber(slideNumber)
                .sectionTitle(sectionTitle)
                .tokenCount(tokenCount)
                .createdAt(createdAt)
                .embedding(null) // We don't need embedding for RAG, just content
                .build();
            
            // Load document separately
            chunk.setDocument(entityManager.find(com.deepdocai.data.entity.Document.class, docId));
            chunkMap.put(id, chunk);
        }
        
        // Return in the order from vector similarity search
        return chunkIds.stream()
            .map(chunkMap::get)
            .filter(chunk -> chunk != null)
            .collect(Collectors.toList());
    }
    
    @Override
    @Transactional  // Required for native SQL executeUpdate() - repository bean is called through proxy
    public void batchSaveChunksWithEmbeddings(List<DocumentChunk> chunks) {
        if (chunks == null || chunks.isEmpty()) {
            return;
        }
        
        log.info("Batch saving {} chunks with embeddings using native SQL", chunks.size());
        
        // Use individual inserts in a transaction (simpler and avoids parameter binding complexity)
        String insertSql = """
            INSERT INTO document_chunks 
            (id, document_id, user_id, chat_id, chunk_index, content, content_hash, 
             page_number, slide_number, section_title, embedding, token_count, created_at)
            VALUES (CAST(:id AS uuid), CAST(:docId AS uuid), CAST(:userId AS uuid), CAST(:chatId AS uuid), 
                    :chunkIndex, :content, :contentHash, :pageNum, :slideNum, :sectionTitle, 
                    CAST(:embedding AS vector), :tokenCount, NOW())
            """;
        
        int savedCount = 0;
        for (DocumentChunk chunk : chunks) {
            try {
                String embeddingStr = null;
                if (chunk.getEmbedding() != null && chunk.getEmbedding().length > 0) {
                    embeddingStr = convertEmbeddingToVectorString(chunk.getEmbedding());
                }
                
                UUID chunkId = chunk.getId() != null ? chunk.getId() : UUID.randomUUID();
                
                Query query = entityManager.createNativeQuery(insertSql);
                query.setParameter("id", chunkId.toString());
                query.setParameter("docId", chunk.getDocument().getId().toString());
                query.setParameter("userId", chunk.getUserId().toString());
                query.setParameter("chatId", chunk.getChatId().toString());
                query.setParameter("chunkIndex", chunk.getChunkIndex());
                query.setParameter("content", chunk.getContent());
                query.setParameter("contentHash", chunk.getContentHash());
                query.setParameter("pageNum", chunk.getPageNumber());
                query.setParameter("slideNum", chunk.getSlideNumber());
                query.setParameter("sectionTitle", chunk.getSectionTitle());
                query.setParameter("embedding", embeddingStr);
                query.setParameter("tokenCount", chunk.getTokenCount());
                
                query.executeUpdate();
                savedCount++;
            } catch (Exception e) {
                log.error("Failed to save chunk at index {}: {}", chunk.getChunkIndex(), e.getMessage(), e);
                throw new RuntimeException("Failed to save chunk: " + e.getMessage(), e);
            }
        }
        
        log.info("Batch insert completed: {} chunks saved", savedCount);
    }
    
    /**
     * Convert float[] embedding to PostgreSQL vector string format: [f1,f2,f3,...]
     */
    private String convertEmbeddingToVectorString(float[] embedding) {
        if (embedding == null || embedding.length == 0) {
            return null;
        }
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < embedding.length; i++) {
            if (i > 0) {
                sb.append(",");
            }
            sb.append(embedding[i]);
        }
        sb.append("]");
        return sb.toString();
    }
}

