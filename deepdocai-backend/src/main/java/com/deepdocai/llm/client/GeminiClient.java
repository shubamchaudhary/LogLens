package com.deepdocai.llm.client;

import com.deepdocai.llm.model.BatchEmbeddingResponse;
import com.deepdocai.llm.model.EmbeddingResponse;
import com.deepdocai.llm.model.GenerationResponse;
import com.deepdocai.llm.worker.RateLimitException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Component
@RequiredArgsConstructor
@Slf4j
public class GeminiClient {

    private final GeminiConfig config;
    private final WebClient.Builder webClientBuilder;

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

        String keyToUse = resolveKey(apiKey);
        String url = String.format("%s/models/%s:batchEmbedContents?key=%s",
            config.getBaseUrl(), config.getEmbeddingModel(), keyToUse);

        List<Map<String, Object>> requests = texts.stream()
            .map(text -> Map.<String, Object>of(
                "model", "models/" + config.getEmbeddingModel(),
                "content", Map.of("parts", List.of(Map.of("text", text)))
            ))
            .collect(Collectors.toList());

        Map<String, Object> requestBody = Map.of("requests", requests);

        int maxRetries = config.getMaxRetries();
        Exception lastException = null;

        for (int attempt = 0; attempt < maxRetries; attempt++) {
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
                if (e.getStatusCode().value() == 429) {
                    throw new RateLimitException("Rate limit (429) on batchEmbedContents: " + e.getResponseBodyAsString(), e);
                }
                if (e.getStatusCode().value() == 403) {
                    String body = e.getResponseBodyAsString();
                    if (body != null && body.contains("leaked")) {
                        throw new RuntimeException("API key reported as leaked: " + body, e);
                    }
                    throw new RuntimeException("Auth failed (403): " + body, e);
                }
                if (e.getStatusCode().value() < 500) {
                    throw new RuntimeException("batchEmbedContents client error: " + e.getMessage(), e);
                }
                lastException = e;
            } catch (org.springframework.web.reactive.function.client.WebClientRequestException e) {
                lastException = e;
                if (attempt < maxRetries - 1) {
                    long delay = 1000L * (1L << attempt);
                    log.warn("batchEmbedContents connection error, attempt {}/{}, retry in {}ms", attempt + 1, maxRetries, delay);
                    sleepQuietly(delay);
                }
            } catch (RateLimitException e) {
                throw e;
            } catch (Exception e) {
                throw new RuntimeException("batchEmbedContents unexpected error: " + e.getMessage(), e);
            }
        }
        throw new RuntimeException("batchEmbedContents failed after " + maxRetries + " attempts", lastException);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Single Embedding  (used for question embedding at query time — single call)
    // ─────────────────────────────────────────────────────────────────────────

    public float[] generateEmbedding(String text, String apiKey) {
        String keyToUse = resolveKey(apiKey);
        String url = String.format("%s/models/%s:embedContent?key=%s",
            config.getBaseUrl(), config.getEmbeddingModel(), keyToUse);

        Map<String, Object> request = Map.of(
            "model", "models/" + config.getEmbeddingModel(),
            "content", Map.of("parts", List.of(Map.of("text", text)))
        );

        int maxRetries = config.getMaxRetries();
        Exception lastException = null;

        for (int attempt = 0; attempt < maxRetries; attempt++) {
            try {
                EmbeddingResponse response = webClientBuilder.build()
                    .post().uri(url).bodyValue(request)
                    .retrieve().bodyToMono(EmbeddingResponse.class).block();

                if (response == null || response.getEmbedding() == null) {
                    throw new RuntimeException("embedContent returned null");
                }
                return response.getEmbedding().getValues();

            } catch (WebClientResponseException e) {
                if (e.getStatusCode().value() == 429) {
                    throw new RateLimitException("Rate limit (429) on embedContent", e);
                }
                if (e.getStatusCode().value() == 403) {
                    String body = e.getResponseBodyAsString();
                    if (body != null && body.contains("leaked")) {
                        throw new RuntimeException("API key leaked: " + body, e);
                    }
                    throw new RuntimeException("Auth failed (403): " + body, e);
                }
                if (e.getStatusCode().value() < 500) {
                    throw new RuntimeException("embedContent error: " + e.getMessage(), e);
                }
                lastException = e;
            } catch (org.springframework.web.reactive.function.client.WebClientRequestException e) {
                lastException = e;
                if (attempt < maxRetries - 1) {
                    long delay = 1000L * (1L << attempt);
                    log.warn("embedContent connection error, retry in {}ms", delay);
                    sleepQuietly(delay);
                }
            }
        }
        throw new RuntimeException("embedContent failed after " + maxRetries + " attempts", lastException);
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
