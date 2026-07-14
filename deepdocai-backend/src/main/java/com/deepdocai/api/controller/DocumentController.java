package com.deepdocai.api.controller;

import com.deepdocai.api.dto.response.DocumentResponse;
import com.deepdocai.common.constants.FileTypes;
import com.deepdocai.common.constants.ProcessingStatus;
import com.deepdocai.common.util.FileUtils;
import com.deepdocai.core.service.FileStorageService;
import com.deepdocai.data.entity.Chat;
import com.deepdocai.data.entity.Document;
import com.deepdocai.data.entity.ProcessingJob;
import com.deepdocai.data.entity.User;
import com.deepdocai.data.repository.ChatRepository;
import com.deepdocai.data.repository.DocumentRepository;
import com.deepdocai.data.repository.ProcessingJobRepository;
import com.deepdocai.data.repository.UserRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import jakarta.servlet.http.HttpServletRequest;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/documents")
@RequiredArgsConstructor
@Slf4j
public class DocumentController {
    
    private final DocumentRepository documentRepository;
    private final ProcessingJobRepository jobRepository;
    private final UserRepository userRepository;
    private final ChatRepository chatRepository;
    private final FileStorageService fileStorageService;
    private final com.deepdocai.data.repository.DocumentChunkRepository chunkRepository;
    
    @PostMapping(value = "/upload", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<DocumentResponse> uploadDocument(
            @RequestParam("file") MultipartFile file,
            @RequestParam("chatId") UUID chatId,
            Authentication authentication,
            HttpServletRequest request
    ) {
        log.debug("Upload request received. Content-Type: {}", request.getContentType());
        log.debug("File received: name={}, size={}, contentType={}, chatId={}", 
            file != null ? file.getOriginalFilename() : "null",
            file != null ? file.getSize() : 0,
            file != null ? file.getContentType() : "null",
            chatId);
        
        if (file == null || file.isEmpty()) {
            log.error("File is null or empty. Content-Type: {}", request.getContentType());
            return ResponseEntity.badRequest().build();
        }
        
        if (chatId == null) {
            return ResponseEntity.badRequest().build();
        }
        
        UUID userId = UUID.fromString(authentication.getName());
        User user = userRepository.findById(userId)
            .orElseThrow(() -> new RuntimeException("User not found"));
        
        Chat chat = chatRepository.findById(chatId)
            .orElseThrow(() -> new RuntimeException("Chat not found"));
        
        // Verify chat belongs to user
        if (!chat.getUser().getId().equals(userId)) {
            return ResponseEntity.status(403).build();
        }
        
        if (!FileUtils.isValidFile(file.getOriginalFilename(), file.getSize())) {
            return ResponseEntity.badRequest().build();
        }
        
        // Check for duplicate: same filename and file size in this chat
        Optional<Document> existingDoc = documentRepository.findByChatIdAndOriginalFileNameAndFileSizeBytes(
            chatId,
            file.getOriginalFilename(),
            file.getSize()
        );
        
        if (existingDoc.isPresent()) {
            log.warn("Duplicate document detected: {} (size: {} bytes) already exists in chat {}", 
                file.getOriginalFilename(), file.getSize(), chatId);
            // Return existing document with 200 OK (not an error, just informational)
            Document existing = existingDoc.get();
            return ResponseEntity.ok(DocumentResponse.builder()
                .id(existing.getId())
                .fileName(existing.getFileName())
                .fileType(existing.getFileType())
                .fileSizeBytes(existing.getFileSizeBytes())
                .totalPages(existing.getTotalPages())
                .totalChunks(existing.getTotalChunks())
                .processingStatus(existing.getProcessingStatus())
                .errorMessage(existing.getErrorMessage())
                .createdAt(existing.getCreatedAt())
                .processingCompletedAt(existing.getProcessingCompletedAt())
                .build());
        }
        
        String extension = FileUtils.getFileExtension(file.getOriginalFilename());
        String sanitizedFileName = FileUtils.sanitizeFileName(file.getOriginalFilename());
        
        // Create document record first to get ID
        Document document = Document.builder()
            .user(user)
            .chat(chat)
            .fileName(sanitizedFileName)
            .originalFileName(file.getOriginalFilename())
            .fileType(extension)
            .fileSizeBytes(file.getSize())
            .mimeType(file.getContentType())
            .processingStatus(ProcessingStatus.PENDING)
            .build();
        
        document = documentRepository.save(document);
        
        // Save file to storage
        try {
            fileStorageService.saveFile(file, document.getId());
        } catch (Exception e) {
            // If file save fails, delete document record
            documentRepository.delete(document);
            throw new RuntimeException("Failed to save file", e);
        }
        
        // Create processing job
        ProcessingJob job = ProcessingJob.builder()
            .document(document)
            .status("QUEUED")
            .priority(5)
            .build();
        jobRepository.save(job);
        
        DocumentResponse response = DocumentResponse.builder()
            .id(document.getId())
            .fileName(document.getFileName())
            .fileType(document.getFileType())
            .fileSizeBytes(document.getFileSizeBytes())
            .processingStatus(document.getProcessingStatus())
            .createdAt(document.getCreatedAt())
            .build();
        
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(response);
    }
    
    @GetMapping
    public ResponseEntity<Page<DocumentResponse>> getDocuments(
            @RequestParam(required = false) UUID chatId,
            @RequestParam(required = false) ProcessingStatus status,
            Pageable pageable,
            Authentication authentication
    ) {
        UUID userId = UUID.fromString(authentication.getName());
        
        Page<Document> documents;
        if (chatId != null) {
            // Chat-scoped documents
            documents = documentRepository.findByChatId(chatId, pageable);
        } else if (status != null) {
            documents = documentRepository.findByUserIdAndProcessingStatus(userId, status, pageable);
        } else {
            documents = documentRepository.findByUserId(userId, pageable);
        }
        
        Page<DocumentResponse> response = documents.map(doc -> DocumentResponse.builder()
            .id(doc.getId())
            .fileName(doc.getFileName())
            .fileType(doc.getFileType())
            .fileSizeBytes(doc.getFileSizeBytes())
            .totalPages(doc.getTotalPages())
            .totalChunks(doc.getTotalChunks())
            .processingStatus(doc.getProcessingStatus())
            .errorMessage(doc.getErrorMessage())
            .createdAt(doc.getCreatedAt())
            .processingCompletedAt(doc.getProcessingCompletedAt())
            .build());
        
        return ResponseEntity.ok(response);
    }
    
    @GetMapping("/{documentId}")
    public ResponseEntity<DocumentResponse> getDocument(
            @PathVariable UUID documentId,
            Authentication authentication
    ) {
        UUID userId = UUID.fromString(authentication.getName());
        
        Document document = documentRepository.findById(documentId)
            .orElse(null);
        
        if (document == null || !document.getUser().getId().equals(userId)) {
            return ResponseEntity.notFound().build();
        }
        
        DocumentResponse response = DocumentResponse.builder()
            .id(document.getId())
            .fileName(document.getFileName())
            .fileType(document.getFileType())
            .fileSizeBytes(document.getFileSizeBytes())
            .totalPages(document.getTotalPages())
            .totalChunks(document.getTotalChunks())
            .processingStatus(document.getProcessingStatus())
            .errorMessage(document.getErrorMessage())
            .createdAt(document.getCreatedAt())
            .processingCompletedAt(document.getProcessingCompletedAt())
            .build();
        
        return ResponseEntity.ok(response);
    }
    
    @DeleteMapping("/{documentId}")
    @Transactional
    public ResponseEntity<Void> deleteDocument(
            @PathVariable UUID documentId,
            @RequestParam UUID chatId,
            Authentication authentication
    ) {
        UUID userId = UUID.fromString(authentication.getName());
        
        Document document = documentRepository.findByIdAndChatIdAndUserId(documentId, chatId, userId)
            .orElse(null);
        
        if (document == null) {
            return ResponseEntity.notFound().build();
        }
        
        // Delete file from storage first
        try {
            fileStorageService.deleteFile(documentId);
        } catch (Exception e) {
            log.warn("Failed to delete file for document {}", documentId, e);
        }
        
        // Delete chunks first to avoid vector loading issues during cascade
        chunkRepository.deleteByDocumentId(documentId);
        
        // Then delete the document
        documentRepository.delete(document);
        return ResponseEntity.noContent().build();
    }
    
    @PostMapping("/upload/bulk")
    public ResponseEntity<BulkUploadResponse> uploadBulkDocuments(
            @RequestParam("files") MultipartFile[] files,
            @RequestParam("chatId") UUID chatId,
            Authentication authentication
    ) {
        UUID userId = UUID.fromString(authentication.getName());
        User user = userRepository.findById(userId)
            .orElseThrow(() -> new RuntimeException("User not found"));
        
        if (chatId == null) {
            return ResponseEntity.badRequest().build();
        }
        
        Chat chat = chatRepository.findById(chatId)
            .orElseThrow(() -> new RuntimeException("Chat not found"));
        
        // Verify chat belongs to user
        if (!chat.getUser().getId().equals(userId)) {
            return ResponseEntity.status(403).build();
        }
        
        if (files.length > 100) {
            return ResponseEntity.badRequest().build();
        }
        
        List<DocumentResponse> uploads = new ArrayList<>();
        List<DuplicateFileInfo> duplicates = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        int queuedCount = 0;
        
        for (MultipartFile file : files) {
            if (file == null || file.isEmpty()) {
                errors.add("Empty file skipped");
                continue;
            }
            
            if (!FileUtils.isValidFile(file.getOriginalFilename(), file.getSize())) {
                errors.add(String.format("Invalid file: %s (size: %d bytes)", 
                    file.getOriginalFilename(), file.getSize()));
                continue;
            }
            
            // Check for duplicate: same filename and file size in this chat
            Optional<Document> existingDoc = documentRepository.findByChatIdAndOriginalFileNameAndFileSizeBytes(
                chatId,
                file.getOriginalFilename(),
                file.getSize()
            );
            
            if (existingDoc.isPresent()) {
                log.warn("Duplicate document detected in bulk upload: {} (size: {} bytes) already exists in chat {}", 
                    file.getOriginalFilename(), file.getSize(), chatId);
                duplicates.add(new DuplicateFileInfo(
                    file.getOriginalFilename(),
                    file.getSize(),
                    existingDoc.get().getId(),
                    existingDoc.get().getCreatedAt()
                ));
                continue; // Skip duplicate but continue processing others
            }
            
            try {
                String extension = FileUtils.getFileExtension(file.getOriginalFilename());
                String sanitizedFileName = FileUtils.sanitizeFileName(file.getOriginalFilename());
                
                Document document = Document.builder()
                    .user(user)
                    .chat(chat)
                    .fileName(sanitizedFileName)
                    .originalFileName(file.getOriginalFilename())
                    .fileType(extension)
                    .fileSizeBytes(file.getSize())
                    .mimeType(file.getContentType())
                    .processingStatus(ProcessingStatus.PENDING)
                    .build();
                
                document = documentRepository.save(document);
                
                // Save file
                fileStorageService.saveFile(file, document.getId());
                
                // Create processing job
                ProcessingJob job = ProcessingJob.builder()
                    .document(document)
                    .status("QUEUED")
                    .priority(5)
                    .build();
                jobRepository.save(job);
                queuedCount++;
                
                uploads.add(DocumentResponse.builder()
                    .id(document.getId())
                    .fileName(document.getFileName())
                    .fileType(document.getFileType())
                    .fileSizeBytes(document.getFileSizeBytes())
                    .processingStatus(document.getProcessingStatus())
                    .createdAt(document.getCreatedAt())
                    .build());
            } catch (Exception e) {
                log.error("Failed to upload file: {}", file.getOriginalFilename(), e);
                errors.add(String.format("Failed to upload %s: %s", 
                    file.getOriginalFilename(), e.getMessage()));
            }
        }
        
        BulkUploadResponse response = new BulkUploadResponse(
            uploads, 
            queuedCount, 
            duplicates, 
            errors,
            files.length,
            uploads.size(),
            duplicates.size(),
            errors.size()
        );
        
        // Return 200 OK if at least some files were processed, even if there are duplicates
        // Return 207 Multi-Status would be ideal but 200 is more compatible
        HttpStatus status = uploads.isEmpty() && duplicates.isEmpty() && !errors.isEmpty() 
            ? HttpStatus.BAD_REQUEST 
            : HttpStatus.OK;
        
        return ResponseEntity.status(status).body(response);
    }
    
    @GetMapping("/{documentId}/status")
    public ResponseEntity<DocumentStatusResponse> getDocumentStatus(
            @PathVariable UUID documentId,
            Authentication authentication
    ) {
        UUID userId = UUID.fromString(authentication.getName());
        
        Document document = documentRepository.findByIdAndUserId(documentId, userId)
            .orElse(null);
        
        if (document == null) {
            return ResponseEntity.notFound().build();
        }
        
        int progress = 0;
        if (document.getProcessingStatus() == ProcessingStatus.COMPLETED) {
            progress = 100;
        } else if (document.getProcessingStatus() == ProcessingStatus.PROCESSING) {
            // Estimate progress based on chunks processed
            if (document.getTotalPages() != null && document.getTotalPages() > 0) {
                progress = Math.min(90, (document.getTotalChunks() * 100) / document.getTotalPages());
            } else {
                progress = 50; // Unknown, assume halfway
            }
        }
        
        DocumentStatusResponse response = DocumentStatusResponse.builder()
            .status(document.getProcessingStatus().toString())
            .progress(progress)
            .chunksProcessed(document.getTotalChunks())
            .totalChunks(document.getTotalChunks())
            .estimatedTimeRemaining(null) // Could calculate based on average processing time
            .build();
        
        return ResponseEntity.ok(response);
    }
    
    // Inner classes for responses
    private static class BulkUploadResponse {
        private List<DocumentResponse> uploads;
        private int totalQueued;
        private List<DuplicateFileInfo> duplicates;
        private List<String> errors;
        private int totalFiles;
        private int successfulUploads;
        private int duplicateCount;
        private int errorCount;
        private String message;
        
        public BulkUploadResponse(
            List<DocumentResponse> uploads, 
            int totalQueued,
            List<DuplicateFileInfo> duplicates,
            List<String> errors,
            int totalFiles,
            int successfulUploads,
            int duplicateCount,
            int errorCount
        ) {
            this.uploads = uploads;
            this.totalQueued = totalQueued;
            this.duplicates = duplicates;
            this.errors = errors;
            this.totalFiles = totalFiles;
            this.successfulUploads = successfulUploads;
            this.duplicateCount = duplicateCount;
            this.errorCount = errorCount;
            
            // Build summary message
            StringBuilder msg = new StringBuilder();
            if (successfulUploads > 0) {
                msg.append(String.format("Successfully uploaded %d file(s). ", successfulUploads));
            }
            if (duplicateCount > 0) {
                msg.append(String.format("%d duplicate file(s) skipped. ", duplicateCount));
            }
            if (errorCount > 0) {
                msg.append(String.format("%d file(s) failed. ", errorCount));
            }
            this.message = msg.toString().trim();
        }
        
        public List<DocumentResponse> getUploads() { return uploads; }
        public int getTotalQueued() { return totalQueued; }
        public List<DuplicateFileInfo> getDuplicates() { return duplicates; }
        public List<String> getErrors() { return errors; }
        public int getTotalFiles() { return totalFiles; }
        public int getSuccessfulUploads() { return successfulUploads; }
        public int getDuplicateCount() { return duplicateCount; }
        public int getErrorCount() { return errorCount; }
        public String getMessage() { return message; }
    }
    
    private static class DuplicateFileInfo {
        private String fileName;
        private long fileSizeBytes;
        private UUID existingDocumentId;
        private Instant existingDocumentCreatedAt;
        
        public DuplicateFileInfo(String fileName, long fileSizeBytes, UUID existingDocumentId, Instant existingDocumentCreatedAt) {
            this.fileName = fileName;
            this.fileSizeBytes = fileSizeBytes;
            this.existingDocumentId = existingDocumentId;
            this.existingDocumentCreatedAt = existingDocumentCreatedAt;
        }
        
        public String getFileName() { return fileName; }
        public long getFileSizeBytes() { return fileSizeBytes; }
        public UUID getExistingDocumentId() { return existingDocumentId; }
        public Instant getExistingDocumentCreatedAt() { return existingDocumentCreatedAt; }
    }
    
    private static class DocumentStatusResponse {
        private String status;
        private int progress;
        private Integer chunksProcessed;
        private Integer totalChunks;
        private Integer estimatedTimeRemaining;
        
        @lombok.Builder
        public DocumentStatusResponse(String status, int progress, Integer chunksProcessed, 
                                     Integer totalChunks, Integer estimatedTimeRemaining) {
            this.status = status;
            this.progress = progress;
            this.chunksProcessed = chunksProcessed;
            this.totalChunks = totalChunks;
            this.estimatedTimeRemaining = estimatedTimeRemaining;
        }
        
        public String getStatus() { return status; }
        public int getProgress() { return progress; }
        public Integer getChunksProcessed() { return chunksProcessed; }
        public Integer getTotalChunks() { return totalChunks; }
        public Integer getEstimatedTimeRemaining() { return estimatedTimeRemaining; }
    }
}

