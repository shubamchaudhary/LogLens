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
    // Process-wide minimum gap between ANY two embedding calls (all Kafka lanes
    // share it). Embedding batches ride the CHAT provider's lanes, so without a
    // global gate 5 lane threads submit ~100+ calls/min against a sustainable
    // ~18/min (5 accounts × 30K TPM ÷ ~8K tokens/batch) and 429-storm.
    // 3500ms → ~17 calls/min → ~27K TPM/account worst case, just under the cap.
    private long embeddingMinIntervalMs = 3500;
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

