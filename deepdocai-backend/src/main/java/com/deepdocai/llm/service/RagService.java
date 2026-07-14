package com.deepdocai.llm.service;

import com.deepdocai.data.entity.DocumentChunk;
import com.deepdocai.data.repository.DocumentChunkRepository;
import com.deepdocai.llm.client.GeminiClient;
import com.deepdocai.llm.embedding.BatchEmbeddingService;
import com.deepdocai.llm.key.ApiKeyManager;
import com.deepdocai.llm.prompt.DocumentAnalysisPrompts;
import com.deepdocai.llm.rag.RecursiveSummarizationService;
import lombok.Builder;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * RAG pipeline with recursive hierarchical summarization.
 *
 * Stage 1: Embed question → vector similarity search → top N chunks
 * Stage 2: RecursiveSummarizationService compresses N chunks into a single context
 * Stage 3: Final answer = compacted context + question + system prompt → LLM
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class RagService {

    private final BatchEmbeddingService embeddingService;
    private final GeminiClient geminiClient;
    private final DocumentChunkRepository chunkRepository;
    private final ApiKeyManager apiKeyManager;
    private final RecursiveSummarizationService summarizationService;

    @Value("${deepdocai.rag.max-retrieved-chunks:500}")
    private int maxRetrievedChunks;

    /**
     * Full RAG pipeline: retrieve → recursive summarize → final answer.
     */
    public RagResult query(
            UUID userId,
            String question,
            List<UUID> documentIds,
            UUID chatId,
            boolean useCrossChat,
            List<String> conversationHistory
    ) {
        long startTime = System.currentTimeMillis();

        // ── Stage 1: Embed question + vector retrieval ────────────────────────
        log.info("=== RAG Stage 1: Embedding + Retrieval ===");
        float[] queryEmbedding = embeddingService.generateSingleEmbedding(question);
        String vectorString = geminiClient.toVectorString(queryEmbedding);
        long embeddingMs = System.currentTimeMillis() - startTime;

        UUID[] docIdArray = (documentIds != null && !documentIds.isEmpty())
            ? documentIds.toArray(new UUID[0]) : null;

        List<DocumentChunk> chunks = chunkRepository.findSimilarChunksCustom(
            userId, vectorString, docIdArray, chatId, useCrossChat, maxRetrievedChunks);
        long retrievalMs = System.currentTimeMillis() - startTime - embeddingMs;

        log.info("Retrieved {} chunks (max {})", chunks.size(), maxRetrievedChunks);

        // ── Stage 2: Recursive summarization ─────────────────────────────────
        String finalContext;
        if (chunks.isEmpty()) {
            log.info("No chunks found. Using fallback (internet search or model knowledge).");
            finalContext = "";
        } else {
            log.info("=== RAG Stage 2: Recursive Summarization ({} chunks) ===", chunks.size());
            List<String> chunkTexts = chunks.stream()
                .map(c -> String.format("[Source: %s, Page/Slide: %s]\n%s",
                    c.getDocument().getFileName(),
                    c.getSlideNumber() != null ? c.getSlideNumber() : c.getPageNumber(),
                    c.getContent()))
                .collect(Collectors.toList());

            finalContext = summarizationService.summarize(chunkTexts, question, 0);
        }
        long summarizationMs = System.currentTimeMillis() - startTime - embeddingMs - retrievalMs;

        // ── Stage 3: Final answer ─────────────────────────────────────────────
        log.info("=== RAG Stage 3: Final Answer Generation ===");
        boolean useInternet = chunks.isEmpty()
            && (conversationHistory == null || conversationHistory.isEmpty());

        String finalPrompt = buildFinalPrompt(question, finalContext, conversationHistory);
        String systemPrompt = chunks.isEmpty()
            ? DocumentAnalysisPrompts.NO_CONTEXT_SYSTEM_PROMPT
            : DocumentAnalysisPrompts.SYSTEM_PROMPT;

        // Use any available key for the final call
        String apiKey = apiKeyManager.getApiKey(0);
        String answer = geminiClient.generateContent(finalPrompt, systemPrompt, useInternet, apiKey);

        long totalMs = System.currentTimeMillis() - startTime;
        log.info("RAG complete: embed={}ms, retrieval={}ms, summarize={}ms, total={}ms",
            embeddingMs, retrievalMs, summarizationMs, totalMs);

        // Build source list (from original retrieved chunks)
        List<SourceInfo> sources = chunks.stream()
            .map(c -> SourceInfo.builder()
                .documentId(c.getDocument().getId())
                .fileName(c.getDocument().getFileName())
                .pageNumber(c.getPageNumber())
                .slideNumber(c.getSlideNumber())
                .excerpt(truncate(c.getContent(), 200))
                .build())
            .collect(Collectors.toList());

        return RagResult.builder()
            .answer(answer)
            .sources(sources)
            .retrievalTimeMs(retrievalMs)
            .generationTimeMs(summarizationMs + (System.currentTimeMillis() - startTime - embeddingMs - retrievalMs - summarizationMs))
            .chunksUsed(chunks.size())
            .build();
    }

    private String buildFinalPrompt(String question, String context, List<String> conversationHistory) {
        StringBuilder sb = new StringBuilder();

        if (conversationHistory != null && !conversationHistory.isEmpty()) {
            sb.append("=== CONVERSATION HISTORY ===\n");
            int maxHistory = Math.min(conversationHistory.size(), 20); // last 10 Q&A pairs
            int start = Math.max(0, conversationHistory.size() - maxHistory);
            for (int i = start; i < conversationHistory.size() - 1; i += 2) {
                if (i + 1 < conversationHistory.size()) {
                    sb.append("User: ").append(conversationHistory.get(i)).append("\n");
                    sb.append("Assistant: ").append(conversationHistory.get(i + 1)).append("\n\n");
                }
            }
            sb.append("=== END CONVERSATION HISTORY ===\n\n");
        }

        if (!context.isEmpty()) {
            sb.append("=== DOCUMENT/LOG CONTEXT ===\n");
            sb.append(context).append("\n");
            sb.append("=== END CONTEXT ===\n\n");
        }

        sb.append("=== USER QUESTION ===\n");
        sb.append(question).append("\n\n");
        sb.append("Provide a comprehensive, well-structured answer based on the context above. ");
        sb.append("Cite specific sources, line numbers, and timestamps where relevant.");

        return sb.toString();
    }

    private String truncate(String text, int max) {
        return text != null && text.length() > max ? text.substring(0, max) + "..." : text;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Result types
    // ─────────────────────────────────────────────────────────────────────────

    @Data @Builder
    public static class RagResult {
        private String answer;
        private List<SourceInfo> sources;
        private Long retrievalTimeMs;
        private Long generationTimeMs;
        private Integer chunksUsed;
    }

    @Data @Builder
    public static class SourceInfo {
        private UUID documentId;
        private String fileName;
        private Integer pageNumber;
        private Integer slideNumber;
        private String excerpt;
    }
}
