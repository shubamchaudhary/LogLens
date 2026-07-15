package com.deepdocai.data.repository;

import com.deepdocai.data.entity.Document;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface DocumentRepository extends JpaRepository<Document, UUID> {

    /** Duplicate-upload detection backed by the {@code uq_doc_per_session} constraint. */
    Optional<Document> findBySessionIdAndOriginalFileNameAndFileSizeBytes(
        UUID sessionId, String originalFileName, Long fileSizeBytes);

    List<Document> findBySessionIdOrderByUploadedAtDesc(UUID sessionId);

    @Modifying
    @Transactional
    @Query("update Document d set d.processingStatus = com.deepdocai.common.constants.ProcessingStatus.PROCESSING "
        + "where d.id = :id")
    void markProcessing(@Param("id") UUID id);

    @Modifying
    @Transactional
    @Query("update Document d set d.processingStatus = com.deepdocai.common.constants.ProcessingStatus.COMPLETED, "
        + "d.stagedFileDeleted = true, d.processedAt = :processedAt where d.id = :id")
    void markCompleted(@Param("id") UUID id, @Param("processedAt") Instant processedAt);

    @Modifying
    @Transactional
    @Query("update Document d set d.processingStatus = com.deepdocai.common.constants.ProcessingStatus.FAILED, "
        + "d.errorMessage = :message where d.id = :id")
    void markFailed(@Param("id") UUID id, @Param("message") String message);
}
