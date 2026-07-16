package com.loglens.llm.client;

import com.loglens.llm.model.BatchEmbeddingResponse;
import com.loglens.llm.model.EmbeddingResponse;
import com.loglens.llm.model.GenerationResponse;
import com.loglens.llm.worker.RateLimitException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;

import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;

@Component
@RequiredArgsConstructor
@Slf4j
public class GeminiClient {

    private final GeminiConfig config;
    private final WebClient.Builder webClientBuilder;

    // Round-robin cursor + cached key list for embedding calls. Embeddings run on
    // the chat provider's Kafka lanes, so without this every batch resolved to the
    // SAME Gemini key (resolveKey → first key) and exhausted its quota while the
    // other configured keys sat idle. Spreading calls across all N keys multiplies
    // the effective embedding quota by N.
    private final AtomicInteger embedKeyCursor = new AtomicInteger();
    private volatile List<String> cachedEmbedKeys;

    // Global embedding pace gate. Embedding batches ride the CHAT provider's
    // Kafka lanes, so N lane threads submit concurrently with no coordination
    // against the EMBEDDING provider's per-minute budgets — bursts bunch onto
    // one account (shared cursor) and 429-storm. Serializing all embedding
    // calls at embeddingMinIntervalMs also makes the round-robin spread
    // perfectly even: each account sees one call every (interval × keyCount).
    private final Object embedPaceGate = new Object();
    private long lastEmbedCallMs = 0;

    /** Blocks until at least embeddingMinIntervalMs since the previous
     *  embedding call, process-wide (all lanes, both embed methods). */
    private void paceEmbeddingCall() {
        synchronized (embedPaceGate) {
            long wait = lastEmbedCallMs + config.getEmbeddingMinIntervalMs()
                - System.currentTimeMillis();
            if (wait > 0) {
                sleepQuietly(wait);
            }
            lastEmbedCallMs = System.currentTimeMillis();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Batch Embedding  (primary embedding method — up to 80 texts per API call)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Sends up to 80 texts in a single batchEmbedContents API call.
     * Returns embeddings in the same order as the input list.
     *
     * @throws RateLimitException on HTTP 429 — caller (worker thread) handles the 60s backoff
     */
    public List<float[]> batchGenerateEmbeddings(List<String> texts, String apiKey) {
        if (texts == null || texts.isEmpty()) return List.of();

        List<Map<String, Object>> requests = texts.stream()
            .map(text -> Map.<String, Object>of(
                "model", "models/" + config.getEmbeddingModel(),
                "content", Map.of("parts", List.of(Map.of("text", text))),
                "outputDimensionality", config.getEmbeddingDimensions()
            ))
            .collect(Collectors.toList());

        Map<String, Object> requestBody = Map.of("requests", requests);

        int keyCount = Math.max(1, embeddingKeys().size());
        // On a 429 we rotate keys and wait, cycling through every key several
        // times before giving up to the Kafka retry lane — a 429 must not fail
        // the batch. Daily-quota 429s (no retryDelay) are tracked per key so we
        // fail fast once EVERY key is daily-exhausted instead of burning ~45s.
        int maxAttempts = Math.max(config.getMaxRetries(), keyCount * 5);
        String keyToUse = resolveEmbeddingKey(apiKey);
        Exception lastException = null;
        boolean lastWasRateLimit = false;
        Set<String> dailyExhausted = new HashSet<>();

        for (int attempt = 0; attempt < maxAttempts; attempt++) {
            paceEmbeddingCall();
            String url = String.format("%s/models/%s:batchEmbedContents?key=%s",
                config.getBaseUrl(), config.getEmbeddingModel(), keyToUse);
            try {
                BatchEmbeddingResponse response = webClientBuilder.build()
                    .post().uri(url).bodyValue(requestBody)
                    .retrieve().bodyToMono(BatchEmbeddingResponse.class).block();

                if (response == null || response.getEmbeddings() == null) {
                    throw new RuntimeException("batchEmbedContents returned null response");
                }

                return response.getEmbeddings().stream()
                    .map(BatchEmbeddingResponse.EmbeddingEntry::getValues)
                    .collect(Collectors.toList());

            } catch (WebClientResponseException e) {
                int status = e.getStatusCode().value();
                if (status == 429) {
                    lastException = e;
                    lastWasRateLimit = true;
                    if (isDailyExhaustion(e)) {
                        dailyExhausted.add(keyToUse);
                        if (dailyExhausted.size() >= keyCount) {
                            log.warn("batchEmbedContents: all {} key(s) daily-exhausted "
                                + "(no retryDelay) — failing fast to retry lane", keyCount);
                            break;
                        }
                        keyToUse = resolveEmbeddingKey(apiKey);  // try another key, no sleep
                        log.warn("batchEmbedContents 429 daily-exhausted ({}/{} keys) — "
                            + "rotating immediately", dailyExhausted.size(), keyCount);
                        continue;
                    }
                    // Per-minute (RPM/TPM) 429: rotate AND pace. Sleeping only on
                    // same-key wraps let a 5-key cycle finish in ~a second, burning
                    // all attempts inside the same saturated TPM minute; a short
                    // sleep every rotation makes 25 attempts span ~50s, guaranteeing
                    // the retry crosses into a fresh minute window.
                    keyToUse = resolveEmbeddingKey(apiKey);
                    log.warn("batchEmbedContents 429 (attempt {}/{}) — rotating key, waiting {}ms",
                        attempt + 1, maxAttempts, config.getRateLimitRetryDelayMs());
                    sleepQuietly(config.getRateLimitRetryDelayMs());
                    continue;
                }
                if (status == 403) {
                    String body = e.getResponseBodyAsString();
                    if (body != null && body.contains("leaked")) {
                        throw new RuntimeException("API key reported as leaked: " + body, e);
                    }
                    throw new RuntimeException("Auth failed (403): " + body, e);
                }
                if (status < 500) {
                    throw new RuntimeException("batchEmbedContents client error: " + e.getMessage(), e);
                }
                lastException = e;
                lastWasRateLimit = false;
                sleepQuietly(1000L * (1L << Math.min(attempt, 4)));
            } catch (org.springframework.web.reactive.function.client.WebClientRequestException e) {
                lastException = e;
                lastWasRateLimit = false;
                log.warn("batchEmbedContents connection error, attempt {}/{}", attempt + 1, maxAttempts);
                sleepQuietly(1000L * (1L << Math.min(attempt, 4)));
            } catch (RateLimitException e) {
                throw e;
            } catch (Exception e) {
                throw new RuntimeException("batchEmbedContents unexpected error: " + e.getMessage(), e);
            }
        }
        // Exhausted in-call retries. If rate limiting was the blocker, surface a
        // RateLimitException so the Kafka retry lane gives it another delayed run.
        if (lastWasRateLimit) {
            throw new RateLimitException("batchEmbedContents still rate-limited after "
                + maxAttempts + " attempt(s) across " + keyCount + " key(s): "
                + (lastException instanceof WebClientResponseException wcre ? wcre.getResponseBodyAsString() : ""),
                lastException);
        }
        throw new RuntimeException("batchEmbedContents failed after " + maxAttempts + " attempts", lastException);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Single Embedding  (used for question embedding at query time — single call)
    // ─────────────────────────────────────────────────────────────────────────

    public float[] generateEmbedding(String text, String apiKey) {
        int keyCount = Math.max(1, embeddingKeys().size());
        int maxAttempts = Math.max(config.getMaxRetries(), keyCount * 5);
        String keyToUse = resolveEmbeddingKey(apiKey);

        Map<String, Object> request = Map.of(
            "model", "models/" + config.getEmbeddingModel(),
            "content", Map.of("parts", List.of(Map.of("text", text))),
            "outputDimensionality", config.getEmbeddingDimensions()
        );

        Exception lastException = null;
        boolean lastWasRateLimit = false;
        Set<String> dailyExhausted = new HashSet<>();

        for (int attempt = 0; attempt < maxAttempts; attempt++) {
            paceEmbeddingCall();
            String url = String.format("%s/models/%s:embedContent?key=%s",
                config.getBaseUrl(), config.getEmbeddingModel(), keyToUse);
            try {
                EmbeddingResponse response = webClientBuilder.build()
                    .post().uri(url).bodyValue(request)
                    .retrieve().bodyToMono(EmbeddingResponse.class).block();

                if (response == null || response.getEmbedding() == null) {
                    throw new RuntimeException("embedContent returned null");
                }
                return response.getEmbedding().getValues();

            } catch (WebClientResponseException e) {
                int status = e.getStatusCode().value();
                if (status == 429) {
                    lastException = e;
                    lastWasRateLimit = true;
                    if (isDailyExhaustion(e)) {
                        dailyExhausted.add(keyToUse);
                        if (dailyExhausted.size() >= keyCount) {
                            log.warn("embedContent: all {} key(s) daily-exhausted "
                                + "(no retryDelay) — failing fast", keyCount);
                            break;
                        }
                        keyToUse = resolveEmbeddingKey(apiKey);  // try another key, no sleep
                        log.warn("embedContent 429 daily-exhausted ({}/{} keys) — rotating immediately",
                            dailyExhausted.size(), keyCount);
                        continue;
                    }
                    // Per-minute 429: rotate AND pace (see batchGenerateEmbeddings).
                    keyToUse = resolveEmbeddingKey(apiKey);
                    log.warn("embedContent 429 (attempt {}/{}) — rotating key, waiting {}ms",
                        attempt + 1, maxAttempts, config.getRateLimitRetryDelayMs());
                    sleepQuietly(config.getRateLimitRetryDelayMs());
                    continue;
                }
                if (status == 403) {
                    String body = e.getResponseBodyAsString();
                    if (body != null && body.contains("leaked")) {
                        throw new RuntimeException("API key leaked: " + body, e);
                    }
                    throw new RuntimeException("Auth failed (403): " + body, e);
                }
                if (status < 500) {
                    throw new RuntimeException("embedContent error: " + e.getMessage(), e);
                }
                lastException = e;
                lastWasRateLimit = false;
                sleepQuietly(1000L * (1L << Math.min(attempt, 4)));
            } catch (org.springframework.web.reactive.function.client.WebClientRequestException e) {
                lastException = e;
                lastWasRateLimit = false;
                log.warn("embedContent connection error, attempt {}/{}", attempt + 1, maxAttempts);
                sleepQuietly(1000L * (1L << Math.min(attempt, 4)));
            }
        }
        if (lastWasRateLimit) {
            throw new RateLimitException("embedContent still rate-limited after "
                + maxAttempts + " attempt(s) across " + keyCount + " key(s)", lastException);
        }
        throw new RuntimeException("embedContent failed after " + maxAttempts + " attempts", lastException);
    }

    public float[] generateEmbedding(String text) {
        return generateEmbedding(text, null);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Text Generation
    // ─────────────────────────────────────────────────────────────────────────

    public String generateContent(String prompt, String systemInstruction) {
        return generateContent(prompt, systemInstruction, false, null, null);
    }

    public String generateContent(String prompt, String systemInstruction, boolean useGoogleSearch, String apiKey) {
        return generateContent(prompt, systemInstruction, useGoogleSearch, apiKey, null);
    }

    /**
     * @throws RateLimitException on HTTP 429
     */
    public String generateContent(String prompt, String systemInstruction,
                                   boolean useGoogleSearch, String apiKey, Integer maxOutputTokens) {
        String keyToUse = resolveKey(apiKey);
        String url = String.format("%s/models/%s:generateContent?key=%s",
            config.getBaseUrl(), config.getGenerationModel(), keyToUse);

        Map<String, Object> requestMap = new HashMap<>();
        requestMap.put("contents", List.of(Map.of("parts", List.of(Map.of("text", prompt)))));
        requestMap.put("systemInstruction", Map.of("parts", List.of(Map.of("text", systemInstruction))));
        int outputTokens = maxOutputTokens != null ? maxOutputTokens : config.getMaxOutputTokens();
        requestMap.put("generationConfig", Map.of(
            "temperature", 0.7, "topP", 0.95, "maxOutputTokens", outputTokens
        ));
        if (useGoogleSearch) {
            requestMap.put("tools", List.of(Map.of("googleSearch", Map.of())));
        }

        try {
            GenerationResponse response = webClientBuilder.build()
                .post().uri(url).bodyValue(Map.copyOf(requestMap))
                .retrieve().bodyToMono(GenerationResponse.class).block();

            if (response == null || response.getCandidates() == null || response.getCandidates().isEmpty()) {
                throw new RuntimeException("generateContent returned null/empty response");
            }

            GenerationResponse.Candidate candidate = response.getCandidates().get(0);
            String finishReason = candidate.getFinishReason();

            if ("SAFETY".equals(finishReason)) {
                throw new RuntimeException("Content blocked by safety filters");
            }
            if ("RECITATION".equals(finishReason)) {
                throw new RuntimeException("Content blocked due to recitation");
            }
            if (candidate.getContent() == null
                || candidate.getContent().getParts() == null
                || candidate.getContent().getParts().isEmpty()) {
                throw new RuntimeException("No parts in response. FinishReason=" + finishReason);
            }

            String text = candidate.getContent().getParts().get(0).getText();
            if (text == null || text.isBlank()) {
                throw new RuntimeException("Empty text in response. FinishReason=" + finishReason);
            }
            if ("MAX_TOKENS".equals(finishReason)) {
                log.warn("generateContent truncated at MAX_TOKENS (length={})", text.length());
            }
            return text;

        } catch (WebClientResponseException e) {
            if (e.getStatusCode().value() == 429) {
                throw new RateLimitException("Rate limit (429) on generateContent", e);
            }
            log.error("generateContent API error: status={}, body={}", e.getStatusCode(), e.getResponseBodyAsString());
            throw new RuntimeException("generateContent failed: " + e.getMessage(), e);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    public String toVectorString(float[] embedding) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < embedding.length; i++) {
            sb.append(embedding[i]);
            if (i < embedding.length - 1) sb.append(",");
        }
        return sb.append("]").toString();
    }

    /**
     * Cached, parsed embedding key pool. Cached so we don't re-parse (and
     * re-log) {@link GeminiConfig#getAllApiKeys()} on every embedding call.
     */
    private List<String> embeddingKeys() {
        List<String> k = cachedEmbedKeys;
        if (k == null) {
            k = config.getAllApiKeys();
            cachedEmbedKeys = k;
            log.info("Gemini embedding key pool: {} key(s), round-robin", k.size());
        }
        return k;
    }

    /**
     * Resolves the Gemini key for an embedding call. An explicit key (used only
     * when embedding provider == chat provider) is honoured as-is; otherwise the
     * next key in the pool is chosen round-robin so load and quota spread across
     * all N configured keys. Each call advances the cursor, so re-calling it on a
     * 429 hands back a different key.
     */
    private String resolveEmbeddingKey(String apiKey) {
        if (apiKey != null && !apiKey.isEmpty()) return apiKey;
        List<String> keys = embeddingKeys();
        if (keys.isEmpty()) {
            throw new RuntimeException("No Gemini API key configured. Set GEMINI_API_KEYS env var.");
        }
        return keys.get(Math.floorMod(embedKeyCursor.getAndIncrement(), keys.size()));
    }

    /**
     * Distinguishes a daily-quota 429 from a per-minute (RPM/TPM) rate-limit 429.
     * Gemini quota-violation bodies name the violated quota id, and per-day quotas
     * contain "PerDay" (e.g. {@code ...RequestsPerDayPerProjectPerModel}); RPM/TPM
     * violations do not. Only a positively identified per-day violation may mark a
     * key exhausted — anything ambiguous (empty body, missing quota id) is treated
     * as per-minute and retried after a wait.
     *
     * <p>History: this used to be {@code !body.contains("retryDelay")}, which
     * misclassified TPM 429s (whose bodies can lack retryDelay) as daily — all
     * keys got marked exhausted within seconds and batches failed fast even
     * though the TPM window would clear in under a minute (observed in prod:
     * RPD 14/1000 with TPM pinned at 28.46K/30K and near-zero successes).
     */
    private static boolean isDailyExhaustion(WebClientResponseException e) {
        String body = e.getResponseBodyAsString();
        if (body == null || body.isEmpty()) {
            return false;
        }
        return body.contains("PerDay") || body.contains("per_day");
    }

    private String resolveKey(String apiKey) {
        if (apiKey != null && !apiKey.isEmpty()) return apiKey;
        if (config.getApiKey() != null && !config.getApiKey().isEmpty()) return config.getApiKey();
        if (!config.getAllApiKeys().isEmpty()) return config.getAllApiKeys().get(0);
        throw new RuntimeException("No Gemini API key configured. Set GEMINI_API_KEYS env var.");
    }

    private void sleepQuietly(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
