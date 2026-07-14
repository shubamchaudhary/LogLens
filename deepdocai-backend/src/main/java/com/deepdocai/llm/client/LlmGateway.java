package com.deepdocai.llm.client;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Provider switch for the enrichment lanes: {@code chunkai.llm.provider}
 * selects Groq (default — 14,400 RPD free vs Gemini's 20) or Gemini.
 *
 * The lane machinery (partition-per-key, pacing, 429 → retry topic) is
 * provider-agnostic; only the transport differs. The API keys handed in by the
 * consumer come from {@link com.deepdocai.llm.key.ApiKeyManager}, which is
 * built from the SAME provider's key list (see ApiKeyManagerConfig) — keys and
 * client always match.
 *
 * Embedding-model consistency warning: vectors from different providers never
 * mix (cosine similarity across models is meaningless). Sessions embedded
 * under one provider must be re-ingested if the provider changes.
 */
@Component
@Slf4j
public class LlmGateway {

    private final GeminiClient gemini;
    private final GroqClient groq;
    private final boolean useGroq;

    public LlmGateway(GeminiClient gemini,
                      GroqClient groq,
                      @Value("${chunkai.llm.provider:groq}") String provider) {
        this.gemini = gemini;
        this.groq = groq;
        this.useGroq = "groq".equalsIgnoreCase(provider.trim());
        log.info("LlmGateway provider: {}", this.useGroq ? "groq" : "gemini");
    }

    /** Single-turn generation. Throws RateLimitException on 429 (both providers). */
    public String generate(String userPrompt, String systemInstruction, String apiKey) {
        return useGroq
            ? groq.generateContent(userPrompt, systemInstruction, apiKey)
            : gemini.generateContent(userPrompt, systemInstruction, false, apiKey);
    }

    /** Batch embeddings, order-preserving. Throws RateLimitException on 429. */
    public List<float[]> embedBatch(List<String> texts, String apiKey) {
        return useGroq
            ? groq.batchEmbeddings(texts, apiKey)
            : gemini.batchGenerateEmbeddings(texts, apiKey);
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
