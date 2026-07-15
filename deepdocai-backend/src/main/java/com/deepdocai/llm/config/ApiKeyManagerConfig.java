package com.deepdocai.llm.config;

import com.deepdocai.llm.client.GeminiConfig;
import com.deepdocai.llm.client.GroqConfig;
import com.deepdocai.llm.key.ApiKeyManager;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.List;

/**
 * Wires the ApiKeyManager from the ACTIVE provider's key list
 * ({@code chunkai.llm.provider}), so Kafka lane count, pacing interval, and the
 * keys handed to {@link com.deepdocai.llm.client.LlmGateway} always agree:
 *
 *   gemini: rate-limit-per-min 10 × 0.80 → 7,500 ms/key
 *   groq:   rate-limit-per-min 30 × 0.80 → 2,500 ms/key
 *
 * NOTE: Kafka partitions can be raised but never lowered. If you switch to a
 * provider with FEWER keys against an existing broker volume, the enrich topic
 * keeps its old width; EnrichConsumer maps partitions onto lanes with
 * {@code partition % slotCount}, so extra partitions share lane 0's pacing
 * rather than crashing. Recreate the topic (or wipe the kafka volume) for a
 * clean 1:1 mapping.
 */
@Configuration
@RequiredArgsConstructor
@Slf4j
public class ApiKeyManagerConfig {

    private final GeminiConfig geminiConfig;
    private final GroqConfig groqConfig;

    @Value("${chunkai.llm.provider:groq}")
    private String provider;

    @Value("${deepdocai.gemini.rate-limit-per-min:10}")
    private int geminiRateLimitPerMin;

    @Value("${chunkai.llm.rate-limit-utilization:0.80}")
    private double rateLimitUtilization;

    @Bean
    public ApiKeyManager apiKeyManager() {
        boolean groq = "groq".equalsIgnoreCase(provider.trim());
        List<String> apiKeys = groq ? groqConfig.getAllApiKeys() : geminiConfig.getAllApiKeys();
        int rateLimitPerMin = groq ? groqConfig.getRateLimitPerMin() : geminiRateLimitPerMin;

        if (apiKeys.isEmpty()) {
            throw new IllegalStateException("No " + (groq ? "Groq" : "Gemini")
                + " API keys configured. Set " + (groq ? "GROQ_API_KEY" : "GEMINI_API_KEYS")
                + " (chunkai.llm.provider=" + provider + ").");
        }

        long minIntervalMs = (long) (60_000.0 / (rateLimitPerMin * rateLimitUtilization));
        // TPM budget applies only to the Groq generation lane (its token/min ceiling
        // is the binding limit). Gemini lanes leave it disabled (0) — embeddings hit
        // Gemini's own quota, not this pool's.
        long tpmBudget = groq ? (long) (groqConfig.getTpmLimit() * rateLimitUtilization) : 0L;
        log.info("ApiKeyManager[{}]: {} key lane(s), rateLimitPerMin={}, utilization={}, minIntervalMs={}, tpmBudget={}",
            groq ? "groq" : "gemini", apiKeys.size(), rateLimitPerMin, rateLimitUtilization, minIntervalMs, tpmBudget);

        return new ApiKeyManager(apiKeys, minIntervalMs, tpmBudget);
    }
}
