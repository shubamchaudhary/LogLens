package com.deepdocai.core.service;

import com.deepdocai.core.model.ChunkingResult;
import com.deepdocai.core.model.ExtractionResult;
import com.deepdocai.core.processor.DocumentProcessor;
import com.deepdocai.core.processor.DocumentProcessorFactory;
import com.deepdocai.data.entity.Document;
import com.deepdocai.data.entity.DocumentChunk;
import com.deepdocai.data.repository.DocumentChunkRepository;
import com.deepdocai.data.repository.DocumentChunkRepositoryCustom;
import com.deepdocai.data.repository.DocumentRepository;
import com.deepdocai.llm.embedding.BatchEmbeddingService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Orchestrates document processing:
 *   1. Extract text (PDF/PPT/Image/Text)
 *   2. Chunk by page/slide
 *   3. Generate embeddings via BatchEmbeddingService (5 parallel threads, batch API)
 *   4. Save chunks with embeddings to PostgreSQL/pgvector
 *
 * Transaction boundaries are split deliberately:
 *   - initializeProcessing()   → short transaction (status update)
 *   - Extraction + embedding   → NO transaction (can take minutes; prevents connection leak)
 *   - saveChunksAndComplete()  → short transaction (batch insert + status update)
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class DocumentProcessingService {

    private final DocumentRepository documentRepository;
    private final DocumentChunkRepository chunkRepository;
    private final DocumentProcessorFactory processorFactory;
    private final ChunkingService chunkingService;
    private final BatchEmbeddingService batchEmbeddingService;
    private final FileStorageService fileStorageService;

    public void processDocument(UUID documentId) {
        Document document = initializeProcessing(documentId);

        try {
            log.info("Processing document: {}", document.getFileName());

            // Extract text
            DocumentProcessor processor = processorFactory.getProcessor(document.getFileType());
            InputStream fileStream = waitForFileAndGet(documentId, 5, 1000);
            ExtractionResult extractionResult = processor.extract(fileStream, document.getFileType());
            fileStream.close();

            // Chunk by page/slide
            List<ChunkingResult> chunks = chunkingService.chunkByPages(
                extractionResult.getPageContents(),
                extractionResult.getPageTitles()
            );

            if (chunks.isEmpty()) {
                log.warn("Document {} produced 0 chunks after extraction.", documentId);
                saveChunksAndComplete(documentId, List.of(), extractionResult.getTotalPages());
                return;
            }

            log.info("Document {} → {} chunks. Submitting to BatchEmbeddingService.", documentId, chunks.size());

            // Generate all embeddings via the worker pool (batch API, 5 parallel threads)
            List<String> texts = chunks.stream().map(ChunkingResult::getContent).collect(Collectors.toList());
            List<float[]> embeddings = batchEmbeddingService.generateEmbeddings(texts);

            // Build DocumentChunk entities (skip chunks with failed embeddings)
            UUID userId = document.getUser().getId();
            UUID chatId = document.getChat().getId();
            List<DocumentChunk> documentChunks = new ArrayList<>();
            int skipped = 0;

            for (int i = 0; i < chunks.size(); i++) {
                float[] embedding = embeddings.get(i);
                if (embedding == null) {
                    log.warn("Chunk {} of document {} has null embedding — skipping.", i, documentId);
                    skipped++;
                    continue;
                }
                ChunkingResult chunk = chunks.get(i);
                documentChunks.add(DocumentChunk.builder()
                    .document(document)
                    .userId(userId)
                    .chatId(chatId)
                    .chunkIndex(chunk.getChunkIndex())
                    .content(chunk.getContent())
                    .contentHash(computeHash(chunk.getContent()))
                    .pageNumber(chunk.getPageNumber())
                    .slideNumber(chunk.getSlideNumber())
                    .sectionTitle(chunk.getSectionTitle())
                    .embedding(embedding)
                    .tokenCount(chunk.getTokenCount())
                    .build());
            }

            if (skipped > 0) {
                log.warn("Skipped {} chunks due to embedding failures for document {}.", skipped, documentId);
            }

            saveChunksAndComplete(documentId, documentChunks, extractionResult.getTotalPages());
            log.info("Completed: document {} → {} chunks saved ({} skipped).", documentId, documentChunks.size(), skipped);

        } catch (Exception e) {
            log.error("Failed to process document {}", documentId, e);
            markAsFailed(documentId, e.getMessage());
            throw new RuntimeException("Failed to process document: " + documentId, e);
        }
    }

    @Transactional
    private Document initializeProcessing(UUID documentId) {
        Document document = documentRepository.findById(documentId)
            .orElseThrow(() -> new RuntimeException("Document not found: " + documentId));
        chunkRepository.deleteByDocumentId(documentId);
        int updated = documentRepository.setProcessingStatus(documentId, java.time.Instant.now());
        if (updated == 0) {
            throw new RuntimeException("Could not update document status: " + documentId);
        }
        return document;
    }

    @Transactional
    private void saveChunksAndComplete(UUID documentId, List<DocumentChunk> chunks, int totalPages) {
        if (!chunks.isEmpty()) {
            ((DocumentChunkRepositoryCustom) chunkRepository).batchSaveChunksWithEmbeddings(chunks);
        }
        int updated = documentRepository.setCompletedStatus(
            documentId, totalPages, chunks.size(), java.time.Instant.now());
        if (updated == 0) {
            throw new RuntimeException("Document not found when completing: " + documentId);
        }
    }

    private InputStream waitForFileAndGet(UUID documentId, int maxRetries, long delayMs) throws Exception {
        for (int attempt = 1; attempt <= maxRetries; attempt++) {
            if (fileStorageService.fileExists(documentId)) {
                try {
                    return fileStorageService.getFile(documentId);
                } catch (Exception e) {
                    if (attempt == maxRetries) throw e;
                }
            }
            log.warn("File not found for document {} (attempt {}/{})", documentId, attempt, maxRetries);
            if (attempt < maxRetries) {
                Thread.sleep(delayMs * attempt);
            }
        }
        throw new RuntimeException("File not found after " + maxRetries + " attempts: " + documentId);
    }

    @Transactional
    private void markAsFailed(UUID documentId, String errorMessage) {
        String truncated = errorMessage != null && errorMessage.length() > 2000
            ? errorMessage.substring(0, 2000) : errorMessage;
        documentRepository.setFailedStatus(documentId, truncated);
    }

    private String computeHash(String content) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] hash = md.digest(content.getBytes());
            StringBuilder sb = new StringBuilder();
            for (byte b : hash) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return null;
        }
    }
}
