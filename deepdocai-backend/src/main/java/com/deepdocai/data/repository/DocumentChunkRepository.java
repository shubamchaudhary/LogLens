package com.deepdocai.data.repository;

import com.deepdocai.data.entity.DocumentChunk;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Repository
public interface DocumentChunkRepository extends JpaRepository<DocumentChunk, UUID>, DocumentChunkRepositoryCustom {
    
    List<DocumentChunk> findByDocumentId(UUID documentId);
    
    // Use native query to delete without loading vector embeddings
    @Modifying
    @Transactional
    @Query(value = "DELETE FROM document_chunks WHERE document_id = :documentId", nativeQuery = true)
    void deleteByDocumentId(@Param("documentId") UUID documentId);
    
    // Use native query to delete chunks by chat without loading vector embeddings
    @Modifying
    @Transactional
    @Query(value = "DELETE FROM document_chunks WHERE chat_id = :chatId", nativeQuery = true)
    void deleteByChatId(@Param("chatId") UUID chatId);
    
    long countByUserId(UUID userId);
}

