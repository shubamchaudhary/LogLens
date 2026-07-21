package com.loglens.llm.client;

import com.loglens.llm.model.BatchEmbeddingResponse;
import com.loglens.llm.model.EmbeddingResponse;
import com.loglens.llm.model.GenerationResponse;
import com.loglens.llm.key.EmbeddingKeyPool;
import com.loglens.llm.worker.RateLimitException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

@Component
@RequiredArgsConstructor
@Slf4j
public class GeminiClient {

    private final GeminiConfig config;
    private final WebClient.Builder webClientBuilder;
    // Proactive per-key RPM+TPM budget keeper for embedding calls: a key is
    // handed out only with budget to spare (no 429s by construction); on a 429
    // anyway, the key is benched (15s per-minute / ~1h daily) and we rotate.
    private final EmbeddingKeyPool embeddingKeyPool;

    /** ~4 chars/token for log text; tiny per-text overhead for request framing. */
    private static long estimateEmbedTokens(List<String> texts) {
        long chars = 0;
        for (String t : texts) {
            chars += t == null ? 0 : t.length();
        }
        return chars / 4 + texts.size() * 8L;
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

        // Per-text cap: a window dense with stack traces can exceed the model's
        // input limit on its own. The vector from the leading slice retrieves the
        // chunk just as well; the full text in Postgres is never touched.
        int maxChars = config.getEmbeddingMaxTextChars();
        List<String> bounded = new ArrayList<>(texts.size());
        for (String t : texts) {
            String s = t == null ? "" : t;
            bounded.add(s.length() > maxChars ? s.substring(0, maxChars) : s);
        }

        // Per-request token cap: a request whose tokens exceed the provider's
        // per-minute bucket can NEVER succeed — it 429s instantly on every key,
        // forever (observed in prod: count-based batches of 10 fat windows were
        // rejected once a minute for two days while a tiny probe succeeded).
        // Batch by tokens, not count, so every request fits a fresh bucket.
        long maxTokens = config.getEmbeddingMaxRequestTokens();
        List<List<String>> groups = new ArrayList<>();
        List<String> current = new ArrayList<>();
        long currentTokens = 0;
        for (String t : bounded) {
            long est = estimateEmbedTokens(List.of(t));
            if (!current.isEmpty() && currentTokens + est > maxTokens) {
                groups.add(current);
                current = new ArrayList<>();
                currentTokens = 0;
            }
            current.add(t);
            currentTokens += est;
        }
        if (!current.isEmpty()) groups.add(current);

        if (groups.size() > 1) {
            log.info("Embed batch of {} texts (~{} est tokens) split into {} requests under the {}-token cap",
                bounded.size(), estimateEmbedTokens(bounded), groups.size(), maxTokens);
        }

        List<float[]> out = new ArrayList<>(bounded.size());
        for (List<String> group : groups) {
            out.addAll(sendEmbedBatch(group, apiKey));
        }
        return out;
    }

    /** One batchEmbedContents request with key rotation and bounded in-call time. */
    private List<float[]> sendEmbedBatch(List<String> texts, String apiKey) {
        List<Map<String, Object>> requests = texts.stream()
            .map(text -> Map.<String, Object>of(
                "model", "models/" + config.getEmbeddingModel(),
                "content", Map.of("parts", List.of(Map.of("text", text))),
                "outputDimensionality", config.getEmbeddingDimensions()
            ))
            .collect(Collectors.toList());

        Map<String, Object> requestBody = Map.of("requests", requests);

        long estTokens = estimateEmbedTokens(texts);
        int keyCount = Math.max(1, embeddingKeyPool.keyCount());
        // With proactive budgeting, provider 429s are the exception, not the
        // pacing mechanism — a few rotations suffice. Pool acquire() itself
        // throws RateLimitException when everything is saturated ≥90s, which
        // propagates to the Kafka retry lane (work is never dropped).
        int maxAttempts = Math.max(config.getMaxRetries(), keyCount * 3);
        Exception lastException = null;
        boolean lastWasRateLimit = false;
        Set<String> dailyExhausted = new HashSet<>();

        // Fail-fast ceiling: pool waits + benches across many attempts can hold
        // a Kafka record longer than max.poll.interval, which gets the consumer
        // kicked from the group — the subsequent ack then FAILS and the record is
        // redelivered on top of its retry-lane copy, duplicating work. Deferring
        // to the retry lane before that point costs one 60s delay and keeps the
        // consumer group stable.
        long deadline = System.currentTimeMillis() + config.getEmbeddingMaxInCallMillis();

        for (int attempt = 0; attempt < maxAttempts; attempt++) {
            if (lastWasRateLimit && System.currentTimeMillis() > deadline) {
                log.warn("batchEmbedContents exceeded {}ms in-call budget after {} attempt(s) — deferring to retry lane",
                    config.getEmbeddingMaxInCallMillis(), attempt);
                break;
            }
            // Explicit key (embedding==chat provider path) bypasses the pool.
            String keyToUse = (apiKey != null && !apiKey.isEmpty())
                ? apiKey : embeddingKeyPool.acquire(estTokens);
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
                        embeddingKeyPool.reportDailyExhausted(keyToUse);
                        dailyExhausted.add(keyToUse);
                        if (dailyExhausted.size() >= keyCount) {
                            log.warn("batchEmbedContents: all {} key(s) daily-exhausted "
                                + "— deferring to retry lane", keyCount);
                            break;
                        }
                    } else {
                        // Shouldn't happen under proactive budgeting; bench the
                        // key 15s and let the next acquire() pick a healthy one.
                        // ALWAYS log the body — it names the violated quotaId,
                        // without which this failure mode is undebuggable.
                        embeddingKeyPool.reportRateLimited(keyToUse);
                        log.warn("batchEmbedContents unexpected 429 (attempt {}/{}) — key benched; body: {}",
                            attempt + 1, maxAttempts, e.getResponseBodyAsString());
                    }
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
        // Same per-text cap as the batch path (questions are short; this only
        // matters if a caller ever embeds raw log content directly).
        String s = text == null ? "" : text;
        int maxChars = config.getEmbeddingMaxTextChars();
        text = s.length() > maxChars ? s.substring(0, maxChars) : s;
        long estTokens = estimateEmbedTokens(List.of(text));
        int keyCount = Math.max(1, embeddingKeyPool.keyCount());
        int maxAttempts = Math.max(config.getMaxRetries(), keyCount * 3);

        Map<String, Object> request = Map.of(
            "model", "models/" + config.getEmbeddingModel(),
            "content", Map.of("parts", List.of(Map.of("text", text))),
            "outputDimensionality", config.getEmbeddingDimensions()
        );

        Exception lastException = null;
        boolean lastWasRateLimit = false;
        Set<String> dailyExhausted = new HashSet<>();

        for (int attempt = 0; attempt < maxAttempts; attempt++) {
            String keyToUse = (apiKey != null && !apiKey.isEmpty())
                ? apiKey : embeddingKeyPool.acquire(estTokens);
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
                        embeddingKeyPool.reportDailyExhausted(keyToUse);
                        dailyExhausted.add(keyToUse);
                        if (dailyExhausted.size() >= keyCount) {
                            log.warn("embedContent: all {} key(s) daily-exhausted — giving up", keyCount);
                            break;
                        }
                    } else {
                        embeddingKeyPool.reportRateLimited(keyToUse);
                        log.warn("embedContent unexpected 429 (attempt {}/{}) — key benched; body: {}",
                            attempt + 1, maxAttempts, e.getResponseBodyAsString());
                    }
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
