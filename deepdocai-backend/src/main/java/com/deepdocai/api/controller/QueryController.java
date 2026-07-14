package com.deepdocai.api.controller;

import com.deepdocai.api.dto.request.QueryRequest;
import com.deepdocai.api.dto.response.QueryResponse;
import com.deepdocai.common.constants.ProcessingStatus;
import lombok.extern.slf4j.Slf4j;
import com.deepdocai.data.entity.Chat;
import com.deepdocai.data.entity.Document;
import com.deepdocai.data.entity.QueryHistory;
import com.deepdocai.data.entity.User;
import com.deepdocai.data.repository.ChatRepository;
import com.deepdocai.data.repository.DocumentRepository;
import com.deepdocai.data.repository.QueryHistoryRepository;
import com.deepdocai.data.repository.UserRepository;
import com.deepdocai.llm.embedding.BatchEmbeddingService;
import com.deepdocai.llm.service.RagService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Autowired;
import jakarta.validation.Valid;
import lombok.Builder;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/v1/query")
@RequiredArgsConstructor
@Slf4j
public class QueryController {
    
    private final RagService ragService;
    private final QueryHistoryRepository queryHistoryRepository;
    private final UserRepository userRepository;
    private final ChatRepository chatRepository;
    private final DocumentRepository documentRepository;
    private final BatchEmbeddingService embeddingService;
    private final com.deepdocai.llm.client.GeminiConfig geminiConfig;
    
    @Autowired
    private ObjectMapper objectMapper;
    
    @PostMapping
    public ResponseEntity<QueryResponse> query(
            @Valid @RequestBody QueryRequest request,
            Authentication authentication
    ) {
        UUID userId = UUID.fromString(authentication.getName());
        User user = userRepository.findById(userId)
            .orElseThrow(() -> new RuntimeException("User not found"));
        
        if (request.getChatId() == null) {
            return ResponseEntity.badRequest().build();
        }
        
        Chat chat = chatRepository.findById(request.getChatId())
            .orElseThrow(() -> new RuntimeException("Chat not found"));
        
        // Verify chat belongs to user
        if (!chat.getUser().getId().equals(userId)) {
            return ResponseEntity.status(403).build();
        }
        
        UUID chatId = request.getChatId();
        // Default to false if not explicitly set to true
        boolean useCrossChat = Boolean.TRUE.equals(request.getUseCrossChat());
        
        String question = request.getQuestion();
        log.info("Query request - chatId: {}, useCrossChat: {}, question: {}", 
            chatId, useCrossChat, question != null ? question.substring(0, Math.min(50, question.length())) : "null");
        
        // Check if there are any documents in this chat that are still processing
        List<Document> processingDocs = documentRepository.findByChatId(chatId).stream()
            .filter(doc -> doc.getProcessingStatus() == ProcessingStatus.PENDING 
                || doc.getProcessingStatus() == ProcessingStatus.PROCESSING)
            .toList();
        
        if (!processingDocs.isEmpty()) {
            return ResponseEntity.status(400).body(
                QueryResponse.builder()
                    .answer("Please wait for all documents to finish processing before asking questions. " +
                        processingDocs.size() + " document(s) are still being processed.")
                    .sources(List.of())
                    .metadata(QueryResponse.Metadata.builder()
                        .retrievalTimeMs(0L)
                        .generationTimeMs(0L)
                        .totalTimeMs(0L)
                        .chunksUsed(0)
                        .build())
                    .build()
            );
        }
        
        // Allow queries even without documents - system can use internet search
        // Only check for processing documents, not for completed documents
        // This allows users to ask questions without uploading files
        
        long startTime = System.currentTimeMillis();
        
        // Get conversation history for context (configurable max Q&A pairs for larger context window)
        List<String> conversationHistory = new ArrayList<>();
        try {
            // Get max conversation history from config
            int maxHistoryPairs = geminiConfig.getMaxConversationHistory();
            List<Object[]> recentHistory = queryHistoryRepository.findHistoryByUserIdAndChatIdNative(
                userId, chatId, 
                org.springframework.data.domain.PageRequest.of(0, maxHistoryPairs)
            );
            // Reverse to get chronological order (oldest first) - this helps LLM understand the flow
            for (int i = recentHistory.size() - 1; i >= 0; i--) {
                Object[] row = recentHistory.get(i);
                String q = (String) row[3]; // query_text
                String a = (String) row[5]; // answer_text
                if (q != null && a != null && !a.trim().isEmpty()) {
                    conversationHistory.add(q);
                    // Don't truncate answers - preserve full context for follow-up questions
                    // This ensures author names, book titles, and other details aren't cut off
                    conversationHistory.add(a);
                }
            }
            log.info("Loaded {} Q&A pairs for conversation context. History size: {} items", 
                conversationHistory.size() / 2, conversationHistory.size());
        } catch (Exception e) {
            log.warn("Failed to load conversation history", e);
        }
        
        // Generate query embedding for history
        float[] queryEmbedding = embeddingService.generateSingleEmbedding(request.getQuestion());
        
        // Log the actual values being used
        log.info("Calling RAG service with - chatId: {}, useCrossChat: {}, question length: {}", 
            chatId, useCrossChat, request.getQuestion().length());
        
        RagService.RagResult result = ragService.query(
            userId,
            request.getQuestion(),
            request.getDocumentIds(),
            chatId,
            useCrossChat,
            conversationHistory
        );
        
        long totalTime = System.currentTimeMillis() - startTime;
        
        // Save to query history
        try {
            String sourcesJson = objectMapper.writeValueAsString(result.getSources());
            
            QueryHistory history = QueryHistory.builder()
                .user(user)
                .chat(chat)
                .queryText(request.getQuestion())
                .queryEmbedding(queryEmbedding)
                .marksRequested(request.getMarks())
                .answerText(result.getAnswer())
                .sourcesUsed(sourcesJson)
                .retrievalTimeMs(result.getRetrievalTimeMs().intValue())
                .generationTimeMs(result.getGenerationTimeMs().intValue())
                .totalTimeMs((int) totalTime)
                .chunksRetrieved(result.getChunksUsed())
                .build();
            
            queryHistoryRepository.save(history);
        } catch (Exception e) {
            // Log but don't fail the request
            e.printStackTrace();
        }
        
        QueryResponse response = QueryResponse.builder()
            .answer(result.getAnswer())
            .sources(result.getSources().stream()
                .map(source -> QueryResponse.SourceInfo.builder()
                    .documentId(source.getDocumentId())
                    .fileName(source.getFileName())
                    .pageNumber(source.getPageNumber())
                    .slideNumber(source.getSlideNumber())
                    .excerpt(source.getExcerpt())
                    .build())
                .collect(Collectors.toList()))
            .metadata(QueryResponse.Metadata.builder()
                .retrievalTimeMs(result.getRetrievalTimeMs())
                .generationTimeMs(result.getGenerationTimeMs())
                .totalTimeMs(result.getRetrievalTimeMs() + result.getGenerationTimeMs())
                .chunksUsed(result.getChunksUsed())
                .build())
            .build();
        
        return ResponseEntity.ok(response);
    }
    
    @GetMapping("/history")
    public ResponseEntity<Page<QueryHistoryResponse>> getQueryHistory(
            @RequestParam(required = false) UUID chatId,
            Pageable pageable,
            Authentication authentication
    ) {
        UUID userId = UUID.fromString(authentication.getName());
        
        List<Object[]> results;
        if (chatId != null) {
            results = queryHistoryRepository.findHistoryByUserIdAndChatIdNative(userId, chatId, pageable);
        } else {
            results = queryHistoryRepository.findHistoryByUserIdNative(userId, pageable);
        }
        
        List<QueryHistoryResponse> historyList = results.stream().map(row -> {
            UUID id = (UUID) row[0];
            String queryText = (String) row[3];
            String answerText = (String) row[5];
            Integer marksRequested = row[4] != null ? (Integer) row[4] : null;
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
            
            return QueryHistoryResponse.builder()
                .id(id)
                .question(queryText)
                .answer(answerText) // Return full answer without truncation
                .marksRequested(marksRequested)
                .createdAt(createdAt)
                .build();
        }).toList();
        
        // Convert to Page (simplified - in production, handle pagination properly)
        org.springframework.data.domain.PageImpl<QueryHistoryResponse> response = 
            new org.springframework.data.domain.PageImpl<>(historyList, pageable, historyList.size());
        
        return ResponseEntity.ok(response);
    }
    
    @Data
    @Builder
    private static class QueryHistoryResponse {
        private UUID id;
        private String question;
        private String answer;
        private Integer marksRequested;
        private java.time.Instant createdAt;
    }
}

