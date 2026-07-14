package com.deepdocai.llm.config;

import com.deepdocai.llm.client.GeminiConfig;
import com.deepdocai.llm.key.ApiKeyManager;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.List;

/**
 * Wires up the ApiKeyManager bean.
 *
 * Rate limit: configurable via deepdocai.gemini.rate-limit-per-min (default 10)
 * Utilization: configurable via deepdocai.gemini.rate-limit-utilization (default 0.80)
 *
 * minIntervalMs = 60_000 / (rateLimitPerMin * utilization)
 * Default: 60_000 / (10 * 0.80) = 7,500 ms between calls per key
 */
@Configuration
@RequiredArgsConstructor
@Slf4j
public class ApiKeyManagerConfig {

    private final GeminiConfig geminiConfig;

    @Value("${deepdocai.gemini.rate-limit-per-min:10}")
    private int rateLimitPerMin;

    @Value("${deepdocai.gemini.rate-limit-utilization:0.80}")
    private double rateLimitUtilization;

    @Bean
    public ApiKeyManager apiKeyManager() {
        List<String> apiKeys = geminiConfig.getAllApiKeys();
        if (apiKeys.isEmpty()) {
            throw new IllegalStateException(
                "No Gemini API keys configured. Set gemini.api-keys in application.properties " +
                "or GEMINI_API_KEYS environment variable.");
        }

        long minIntervalMs = (long) (60_000.0 / (rateLimitPerMin * rateLimitUtilization));
        log.info("ApiKeyManager: {} keys, rateLimitPerMin={}, utilization={}, minIntervalMs={}",
            apiKeys.size(), rateLimitPerMin, rateLimitUtilization, minIntervalMs);

        return new ApiKeyManager(apiKeys, minIntervalMs);
    }
}
