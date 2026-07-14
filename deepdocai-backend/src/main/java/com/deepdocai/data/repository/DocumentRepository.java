package com.deepdocai.data.repository;

import com.deepdocai.data.entity.Document;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface DocumentRepository extends JpaRepository<Document, UUID> {

    /** Duplicate-upload detection backed by the {@code uq_doc_per_session} constraint. */
    Optional<Document> findBySessionIdAndOriginalFileNameAndFileSizeBytes(
        UUID sessionId, String originalFileName, Long fileSizeBytes);

    List<Document> findBySessionIdOrderByUploadedAtDesc(UUID sessionId);
}
