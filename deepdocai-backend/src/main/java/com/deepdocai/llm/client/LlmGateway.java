package com.deepdocai.llm.client;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Provider switches for the enrichment lanes:
 * <ul>
 *   <li>{@code chunkai.llm.provider} — chat/generation: groq (default —
 *       14,400 RPD free vs Gemini's 20) or gemini;</li>
 *   <li>{@code chunkai.llm.embedding-provider} — embeddings: gemini (default)
 *       or groq. Split from chat because <b>Groq currently serves no embedding
 *       models</b> (verified against console.groq.com/docs/models and org
 *       limits, 2026-07); Gemini's embedding quota was untouched by the
 *       text-out RPD crackdown.</li>
 * </ul>
 *
 * The lane machinery (partition-per-key, pacing, 429 → retry topic) is
 * provider-agnostic; only the transport differs. The lane API key handed in by
 * the consumer belongs to the CHAT provider (ApiKeyManager is built from that
 * pool) — when the embedding provider differs, the gateway passes {@code null}
 * so the embedding client resolves its own configured key.
 *
 * Embedding-model consistency warning: vectors from different models never mix
 * (cosine similarity across models is meaningless). The Python orchestrator's
 * drill-down query embedding must use the same embedding provider (EMBEDDING_PROVIDER).
 */
@Component
@Slf4j
public class LlmGateway {

    private final GeminiClient gemini;
    private final GroqClient groq;
    private final boolean chatGroq;
    private final boolean embedGroq;

    public LlmGateway(GeminiClient gemini,
                      GroqClient groq,
                      @Value("${chunkai.llm.provider:groq}") String chatProvider,
                      @Value("${chunkai.llm.embedding-provider:gemini}") String embeddingProvider) {
        this.gemini = gemini;
        this.groq = groq;
        this.chatGroq = "groq".equalsIgnoreCase(chatProvider.trim());
        this.embedGroq = "groq".equalsIgnoreCase(embeddingProvider.trim());
        log.info("LlmGateway chat={}, embeddings={}",
            chatGroq ? "groq" : "gemini", embedGroq ? "groq" : "gemini");
        if (embedGroq) {
            log.warn("chunkai.llm.embedding-provider=groq, but Groq serves no embedding "
                + "models as of 2026-07 — EMBED_BATCH work will fail unless that changed.");
        }
    }

    /** Single-turn generation. Throws RateLimitException on 429 (both providers). */
    public String generate(String userPrompt, String systemInstruction, String apiKey) {
        return chatGroq
            ? groq.generateContent(userPrompt, systemInstruction, apiKey)
            : gemini.generateContent(userPrompt, systemInstruction, false, apiKey);
    }

    /**
     * Batch embeddings, order-preserving. Throws RateLimitException on 429.
     * {@code laneApiKey} is used only when the embedding provider matches the
     * chat provider (the lane pool belongs to the chat provider); otherwise the
     * embedding client falls back to its own configured key.
     */
    public List<float[]> embedBatch(List<String> texts, String laneApiKey) {
        if (embedGroq) {
            return groq.batchEmbeddings(texts, chatGroq ? laneApiKey : null);
        }
        return gemini.batchGenerateEmbeddings(texts, chatGroq ? null : laneApiKey);
    }

    /** pgvector literal format: [f1,f2,...] — provider-neutral. */
    public String toVectorString(float[] embedding) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < embedding.length; i++) {
            sb.append(embedding[i]);
            if (i < embedding.length - 1) {
                sb.append(",");
            }
        }
        return sb.append("]").toString();
    }
}
