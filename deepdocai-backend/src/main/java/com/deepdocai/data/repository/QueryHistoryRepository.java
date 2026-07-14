package com.deepdocai.data.repository;

import com.deepdocai.data.entity.QueryHistory;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Repository
public interface QueryHistoryRepository extends JpaRepository<QueryHistory, UUID>, QueryHistoryRepositoryCustom {
    // Use native query to exclude embedding column
    @Query(value = """
        SELECT qh.id, qh.user_id, qh.chat_id, qh.query_text, qh.marks_requested, 
               qh.answer_text, qh.sources_used, qh.retrieval_time_ms, 
               qh.generation_time_ms, qh.total_time_ms, qh.chunks_retrieved, qh.created_at
        FROM query_history qh
        WHERE qh.user_id = :userId
        ORDER BY qh.created_at DESC
        """, nativeQuery = true)
    List<Object[]> findHistoryByUserIdNative(@Param("userId") UUID userId, Pageable pageable);
    
    @Query(value = """
        SELECT qh.id, qh.user_id, qh.chat_id, qh.query_text, qh.marks_requested, 
               qh.answer_text, qh.sources_used, qh.retrieval_time_ms, 
               qh.generation_time_ms, qh.total_time_ms, qh.chunks_retrieved, qh.created_at
        FROM query_history qh
        WHERE qh.user_id = :userId AND qh.chat_id = :chatId
        ORDER BY qh.created_at DESC
        """, nativeQuery = true)
    List<Object[]> findHistoryByUserIdAndChatIdNative(@Param("userId") UUID userId, @Param("chatId") UUID chatId, Pageable pageable);
    
    // Use native query to delete query history without loading vector embeddings
    @Modifying
    @Transactional
    @Query(value = "DELETE FROM query_history WHERE chat_id = :chatId", nativeQuery = true)
    void deleteByChatId(@Param("chatId") UUID chatId);
}

