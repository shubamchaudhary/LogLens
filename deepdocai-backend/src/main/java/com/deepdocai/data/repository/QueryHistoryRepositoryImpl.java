package com.deepdocai.data.repository;

import com.deepdocai.data.entity.QueryHistory;
import jakarta.persistence.EntityManager;
import jakarta.persistence.PersistenceContext;
import jakarta.persistence.Query;
import org.springframework.stereotype.Repository;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Repository
public class QueryHistoryRepositoryImpl implements QueryHistoryRepositoryCustom {
    
    @PersistenceContext
    private EntityManager entityManager;
    
    @Override
    public List<QueryHistory> findByChatIdExcludingEmbedding(UUID chatId, int limit) {
        // Select all columns except embedding to avoid vector type mapping issues
        String sql = """
            SELECT id, user_id, chat_id, query_text, marks_requested, answer_text,
                   sources_used, retrieval_time_ms, generation_time_ms, total_time_ms,
                   chunks_retrieved, created_at
            FROM query_history
            WHERE chat_id = :chatId
            ORDER BY created_at DESC
            LIMIT :limit
            """;
        
        Query query = entityManager.createNativeQuery(sql);
        query.setParameter("chatId", chatId);
        query.setParameter("limit", limit);
        
        @SuppressWarnings("unchecked")
        List<Object[]> results = query.getResultList();
        
        List<QueryHistory> history = new ArrayList<>();
        for (Object[] row : results) {
            UUID id = (UUID) row[0];
            UUID userId = (UUID) row[1];
            UUID chatIdFromRow = (UUID) row[2];
            String queryText = (String) row[3];
            Integer marksRequested = row[4] != null ? (Integer) row[4] : null;
            String answerText = (String) row[5];
            String sourcesUsed = (String) row[6];
            Integer retrievalTimeMs = row[7] != null ? (Integer) row[7] : null;
            Integer generationTimeMs = row[8] != null ? (Integer) row[8] : null;
            Integer totalTimeMs = row[9] != null ? (Integer) row[9] : null;
            Integer chunksRetrieved = row[10] != null ? (Integer) row[10] : null;
            
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
            
            QueryHistory qh = QueryHistory.builder()
                .id(id)
                .queryText(queryText)
                .marksRequested(marksRequested)
                .answerText(answerText)
                .sourcesUsed(sourcesUsed)
                .retrievalTimeMs(retrievalTimeMs)
                .generationTimeMs(generationTimeMs)
                .totalTimeMs(totalTimeMs)
                .chunksRetrieved(chunksRetrieved)
                .createdAt(createdAt)
                .queryEmbedding(null) // Exclude embedding
                .build();
            
            // Load user and chat separately
            qh.setUser(entityManager.find(com.deepdocai.data.entity.User.class, userId));
            qh.setChat(entityManager.find(com.deepdocai.data.entity.Chat.class, chatIdFromRow));
            
            history.add(qh);
        }
        
        return history;
    }
}

