package com.deepdocai.llm.client;

import lombok.Getter;
import lombok.Setter;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

import java.util.ArrayList;
import java.util.List;

/**
 * Groq (OpenAI-compatible) settings. Chosen over Gemini for generation and
 * embeddings after Google's free tier dropped to 20 requests/day per project:
 * Groq's free tier allows 14,400 RPD on llama-3.1-8b-instant at 30 RPM.
 *
 * Embeddings: nomic-embed-text-v1_5 natively outputs 768 dimensions — a drop-in
 * for schema-v2's vector(768) columns. Note vectors from different embedding
 * models never mix: switching provider is a reindex event for existing sessions.
 */
@Configuration
@ConfigurationProperties(prefix = "groq")
@Getter
@Setter
public class GroqConfig {

    private String apiKey;                 // single key
    private String apiKeys;                // comma-separated; one Kafka lane each
    private String baseUrl = "https://api.groq.com/openai/v1";
    private String chatModel = "llama-3.1-8b-instant";
    private String embeddingModel = "nomic-embed-text-v1_5";
    private int maxOutputTokens = 4096;
    private int maxRetries = 3;
    private int rateLimitPerMin = 30;      // free tier: 30 RPM on 8b-instant
    private int tpmLimit = 6000;           // free tier: 6000 tokens/min on 8b-instant (the binding limit)

    /** Same fallback semantics as {@link GeminiConfig#getAllApiKeys()}. */
    public List<String> getAllApiKeys() {
        List<String> keys = new ArrayList<>();
        if (apiKeys != null && !apiKeys.trim().isEmpty()) {
            for (String key : apiKeys.split(",")) {
                String trimmed = key.trim();
                if (!trimmed.isEmpty()) {
                    keys.add(trimmed);
                }
            }
        }
        if (keys.isEmpty() && apiKey != null && !apiKey.trim().isEmpty()) {
            keys.add(apiKey.trim());
        }
        return keys;
    }
}
