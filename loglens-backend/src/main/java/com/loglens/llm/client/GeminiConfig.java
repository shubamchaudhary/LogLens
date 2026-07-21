package com.loglens.llm.client;

import lombok.Getter;
import lombok.Setter;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;

import java.util.ArrayList;
import java.util.List;

@Configuration
@ConfigurationProperties(prefix = "gemini")
@Getter
@Setter
@Slf4j
public class GeminiConfig {
    private String apiKey; // Single key (for backward compatibility)
    private String apiKeys; // Comma-separated multiple keys for round-robin
    private String embeddingModel = "gemini-embedding-001";
    private int embeddingDimensions = 768; // schema-v2 chunk vectors are vector(768); gemini-embedding-001 truncates via outputDimensionality
    private String generationModel = "gemini-2.5-flash";
    private String baseUrl = "https://generativelanguage.googleapis.com/v1beta";
    private int maxRetries = 3;
    private int timeoutSeconds = 60;
    // On a 429 the embedding call rotates to the next key and waits this long
    // before retrying, cycling across all keys instead of failing the batch.
    private long rateLimitRetryDelayMs = 5000;
    // Per-key embedding budgets enforced PROACTIVELY by EmbeddingKeyPool — a call
    // is dispatched only when the chosen key stays inside both windows, so 429s
    // don't happen by construction. Safety margin is baked into these numbers
    // (real free-tier limits: 100 RPM / 30K TPM per project).
    private long embeddingRpmLimit = 75;
    private long embeddingTpmLimit = 24000;
    // Reactive backstop: bench a key this long after a per-minute 429...
    private long cooldown429Ms = 15000;
    // ...and this long (minutes) after a per-day quota 429 (re-probed hourly).
    private long dailyCooldownMinutes = 60;
    // A single request whose token count exceeds the provider's per-minute
    // bucket (30K TPM) can NEVER succeed — it 429s instantly on every key,
    // forever. Batches are therefore split by estimated tokens, capped well
    // under the bucket, and each text is capped so one stack-trace-dense
    // window can't sink a whole request. Only the text sent for embedding is
    // truncated; the stored chunk is untouched.
    private long embeddingMaxRequestTokens = 10000;
    private int embeddingMaxTextChars = 8000;
    // Fail-fast ceiling for one embed call: past this, defer to the Kafka
    // retry lane instead of blocking toward max.poll.interval (being kicked
    // from the group fails the ack and duplicates in-flight work).
    private long embeddingMaxInCallMillis = 240000;
    private int maxOutputTokens = 8192; // Max for Gemini 2.5 Flash
    private int maxContextChunks = 150; // Increased to 150 for enhanced RAG
    private int maxConversationHistory = 50; // Max Q&A pairs in conversation history
    
    /**
     * Get all API keys, falling back to single apiKey if apiKeys is not set.
     */
    public List<String> getAllApiKeys() {
        List<String> keys = new ArrayList<>();
        
        // First, try to parse comma-separated apiKeys
        if (apiKeys != null && !apiKeys.trim().isEmpty()) {
            String[] keyArray = apiKeys.split(",");
            for (String key : keyArray) {
                String trimmed = key.trim();
                if (!trimmed.isEmpty()) {
                    keys.add(trimmed);
                }
            }
            log.info("Parsed {} API keys from apiKeys property", keys.size());
        }
        
        // If no keys from apiKeys, fall back to single apiKey
        if (keys.isEmpty() && apiKey != null && !apiKey.trim().isEmpty()) {
            keys.add(apiKey.trim());
            log.info("Using single apiKey property");
        }
        
        log.info("Total API keys available: {}", keys.size());
        return keys;
    }
}

