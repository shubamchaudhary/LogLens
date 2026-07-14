package com.deepdocai.api.controller;

import com.deepdocai.common.constants.KafkaTopics;
import com.deepdocai.common.constants.ProcessingStatus;
import com.deepdocai.common.messages.IngestRequest;
import com.deepdocai.data.entity.Document;
import com.deepdocai.data.repository.DocumentRepository;
import com.deepdocai.data.repository.SessionRepository;
import com.deepdocai.storage.FileStorageService;
import lombok.Builder;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Upload endpoint for a session's log archives. Flow:
 * validate → stage in MinIO → insert {@code documents} row →
 * produce {@link IngestRequest} to {@code log.ingest.requests} → 202.
 *
 * <p>The MinIO upload happens outside any DB transaction; the row insert is a
 * short transaction; the Kafka publish happens after the row is committed.
 * Re-uploading the same file (matched by the {@code uq_doc_per_session}
 * constraint) is idempotent and returns the existing document.
 */
@RestController
@RequestMapping("/api/v1/sessions/{sessionId}/documents")
@RequiredArgsConstructor
@Slf4j
public class DocumentController {

    private final SessionRepository sessionRepository;
    private final DocumentRepository documentRepository;
    private final FileStorageService fileStorageService;
    private final KafkaTemplate<String, Object> kafkaTemplate;

    @PostMapping
    public ResponseEntity<UploadResponse> upload(
        @PathVariable UUID sessionId,
        @RequestParam("file") MultipartFile file,
        Authentication authentication
    ) {
        UUID userId = UUID.fromString(authentication.getName());

        if (sessionRepository.findByIdAndUserId(sessionId, userId).isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        if (file == null || file.isEmpty()) {
            return ResponseEntity.badRequest().build();
        }

        String originalFileName = file.getOriginalFilename();
        if (originalFileName == null || originalFileName.isBlank()) {
            originalFileName = "upload-" + Instant.now().toEpochMilli();
        }
        long sizeBytes = file.getSize();

        // Idempotent duplicate detection before we touch storage.
        Optional<Document> existing = documentRepository
            .findBySessionIdAndOriginalFileNameAndFileSizeBytes(sessionId, originalFileName, sizeBytes);
        if (existing.isPresent()) {
            log.info("Duplicate upload for session {} ('{}'), returning existing document {}",
                sessionId, originalFileName, existing.get().getId());
            return ResponseEntity.ok(UploadResponse.of(existing.get()));
        }

        UUID documentId = UUID.randomUUID();

        // Stage the raw file in MinIO (IO — no DB transaction held here).
        String fileUrl;
        try (InputStream in = file.getInputStream()) {
            fileUrl = fileStorageService.store(sessionId, documentId, in, sizeBytes, file.getContentType());
        } catch (IOException e) {
            throw new RuntimeException("Failed to read uploaded file", e);
        }

        Document saved;
        try {
            saved = documentRepository.save(Document.builder()
                .id(documentId)
                .userId(userId)
                .sessionId(sessionId)
                .originalFileName(originalFileName)
                .fileUrl(fileUrl)
                .fileSizeBytes(sizeBytes)
                .processingStatus(ProcessingStatus.PENDING)
                .stagedFileDeleted(false)
                .build());
        } catch (DataIntegrityViolationException race) {
            // Lost a race on uq_doc_per_session — drop our staged object and return the winner.
            fileStorageService.delete(fileUrl);
            return documentRepository
                .findBySessionIdAndOriginalFileNameAndFileSizeBytes(sessionId, originalFileName, sizeBytes)
                .map(winner -> ResponseEntity.ok(UploadResponse.of(winner)))
                .orElseThrow(() -> race);
        }

        // Publish the ingest request only after the row is committed. key = sessionId.
        kafkaTemplate.send(KafkaTopics.LOG_INGEST_REQUESTS, sessionId.toString(),
            new IngestRequest(sessionId, userId, documentId, fileUrl));

        log.info("Accepted document {} for session {} ({} bytes) → {}",
            documentId, sessionId, sizeBytes, KafkaTopics.LOG_INGEST_REQUESTS);
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(UploadResponse.of(saved));
    }

    @GetMapping
    public ResponseEntity<List<UploadResponse>> list(
        @PathVariable UUID sessionId,
        Authentication authentication
    ) {
        UUID userId = UUID.fromString(authentication.getName());
        if (sessionRepository.findByIdAndUserId(sessionId, userId).isEmpty()) {
            return ResponseEntity.notFound().build();
        }
        List<UploadResponse> docs = documentRepository.findBySessionIdOrderByUploadedAtDesc(sessionId)
            .stream().map(UploadResponse::of).toList();
        return ResponseEntity.ok(docs);
    }

    @Data
    @Builder
    public static class UploadResponse {
        private UUID documentId;
        private UUID sessionId;
        private String originalFileName;
        private Long fileSizeBytes;
        private ProcessingStatus processingStatus;
        private Instant uploadedAt;

        static UploadResponse of(Document d) {
            return UploadResponse.builder()
                .documentId(d.getId())
                .sessionId(d.getSessionId())
                .originalFileName(d.getOriginalFileName())
                .fileSizeBytes(d.getFileSizeBytes())
                .processingStatus(d.getProcessingStatus())
                .uploadedAt(d.getUploadedAt())
                .build();
        }
    }
}
