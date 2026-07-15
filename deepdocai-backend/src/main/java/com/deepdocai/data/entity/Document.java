package com.deepdocai.data.entity;

import com.deepdocai.common.constants.ProcessingStatus;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;
import java.util.UUID;

/**
 * One uploaded log archive. The raw bytes live in MinIO staging
 * ({@code fileUrl = s3://staging/{sessionId}/{documentId}}) and are removed
 * after successful processing ({@code stagedFileDeleted}).
 *
 * <p>The id is assigned by the caller before staging so the MinIO object key
 * and {@code fileUrl} can be built up-front; hence no {@code @GeneratedValue}.
 * The {@code (session_id, original_file_name, file_size_bytes)} unique
 * constraint makes re-uploads idempotent.
 */
@Entity
@Table(name = "documents")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Document {

    @Id
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "session_id", nullable = false)
    private UUID sessionId;

    @Column(name = "original_file_name", nullable = false, length = 500)
    private String originalFileName;

    @Column(name = "file_url", nullable = false)
    private String fileUrl;

    @Column(name = "file_size_bytes", nullable = false)
    private Long fileSizeBytes;

    @Enumerated(EnumType.STRING)
    @Column(name = "processing_status", nullable = false, length = 20)
    @Builder.Default
    private ProcessingStatus processingStatus = ProcessingStatus.PENDING;

    @Column(name = "staged_file_deleted")
    @Builder.Default
    private Boolean stagedFileDeleted = false;

    @Column(name = "error_message")
    private String errorMessage;

    @CreationTimestamp
    @Column(name = "uploaded_at", updatable = false)
    private Instant uploadedAt;

    @Column(name = "processed_at")
    private Instant processedAt;
}
