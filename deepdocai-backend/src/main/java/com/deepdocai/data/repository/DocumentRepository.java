package com.deepdocai.data.repository;

import com.deepdocai.common.constants.ProcessingStatus;
import com.deepdocai.data.entity.Document;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface DocumentRepository extends JpaRepository<Document, UUID> {
    
    Page<Document> findByUserId(UUID userId, Pageable pageable);
    
    Page<Document> findByUserIdAndProcessingStatus(
        UUID userId, 
        ProcessingStatus status, 
        Pageable pageable
    );
    
    Optional<Document> findByIdAndUserId(UUID id, UUID userId);
    
    List<Document> findByUserIdAndProcessingStatusIn(
        UUID userId, 
        List<ProcessingStatus> statuses
    );
    
    @Query("""
        SELECT SUM(d.fileSizeBytes) 
        FROM Document d 
        WHERE d.user.id = :userId
    """)
    Long getTotalStorageByUserId(UUID userId);
    
    long countByUserId(UUID userId);
    
    /**
     * Check if a document with the same original filename and file size exists for the user.
     * Used for duplicate detection.
     */
    Optional<Document> findByUserIdAndOriginalFileNameAndFileSizeBytes(
        UUID userId,
        String originalFileName,
        Long fileSizeBytes
    );
    
    // Chat-scoped queries
    Page<Document> findByChatId(UUID chatId, Pageable pageable);
    
    List<Document> findByChatId(UUID chatId);
    
    Optional<Document> findByIdAndChatId(UUID id, UUID chatId);
    
    /**
     * Find document by ID, chat ID, and user ID (for security verification)
     */
    @Query("SELECT d FROM Document d WHERE d.id = :id AND d.chat.id = :chatId AND d.user.id = :userId")
    Optional<Document> findByIdAndChatIdAndUserId(
        @Param("id") UUID id,
        @Param("chatId") UUID chatId,
        @Param("userId") UUID userId
    );
    
    /**
     * Check if a document with the same original filename and file size exists in a chat.
     * Used for duplicate detection within a chat.
     */
    Optional<Document> findByChatIdAndOriginalFileNameAndFileSizeBytes(
        UUID chatId,
        String originalFileName,
        Long fileSizeBytes
    );
    
    long countByChatId(UUID chatId);
    
    // Use native query to delete documents without loading related entities
    @Modifying
    @Transactional
    @Query(value = "DELETE FROM documents WHERE chat_id = :chatId", nativeQuery = true)
    void deleteByChatId(@Param("chatId") UUID chatId);
    
    /**
     * Update document processing status and metadata using native SQL.
     * Avoids loading entity and related DocumentChunk entities with vector fields.
     */
    @Modifying
    @Transactional
    @Query(value = """
        UPDATE documents 
        SET processing_status = :status,
            total_pages = :totalPages,
            total_chunks = :totalChunks,
            processing_started_at = :startedAt,
            processing_completed_at = :completedAt,
            error_message = :errorMessage,
            updated_at = NOW()
        WHERE id = CAST(:documentId AS uuid)
        """, nativeQuery = true)
    int updateDocumentStatus(
        @Param("documentId") UUID documentId,
        @Param("status") String status,
        @Param("totalPages") Integer totalPages,
        @Param("totalChunks") Integer totalChunks,
        @Param("startedAt") java.time.Instant startedAt,
        @Param("completedAt") java.time.Instant completedAt,
        @Param("errorMessage") String errorMessage
    );
    
    /**
     * Update document status to PROCESSING using native SQL.
     */
    @Modifying
    @Transactional
    @Query(value = """
        UPDATE documents 
        SET processing_status = 'PROCESSING',
            processing_started_at = :startedAt,
            updated_at = NOW()
        WHERE id = CAST(:documentId AS uuid)
        """, nativeQuery = true)
    int setProcessingStatus(@Param("documentId") UUID documentId, @Param("startedAt") java.time.Instant startedAt);
    
    /**
     * Update document status to COMPLETED using native SQL.
     */
    @Modifying
    @Transactional
    @Query(value = """
        UPDATE documents 
        SET processing_status = 'COMPLETED',
            total_pages = :totalPages,
            total_chunks = :totalChunks,
            processing_completed_at = :completedAt,
            error_message = NULL,
            updated_at = NOW()
        WHERE id = CAST(:documentId AS uuid)
        """, nativeQuery = true)
    int setCompletedStatus(
        @Param("documentId") UUID documentId,
        @Param("totalPages") Integer totalPages,
        @Param("totalChunks") Integer totalChunks,
        @Param("completedAt") java.time.Instant completedAt
    );
    
    /**
     * Update document status to FAILED using native SQL.
     */
    @Modifying
    @Transactional
    @Query(value = """
        UPDATE documents 
        SET processing_status = 'FAILED',
            error_message = :errorMessage,
            updated_at = NOW()
        WHERE id = CAST(:documentId AS uuid)
        """, nativeQuery = true)
    int setFailedStatus(@Param("documentId") UUID documentId, @Param("errorMessage") String errorMessage);
    
}

