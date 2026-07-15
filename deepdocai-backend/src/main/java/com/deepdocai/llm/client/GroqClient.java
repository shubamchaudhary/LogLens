package com.deepdocai.llm.client;

import com.deepdocai.llm.worker.RateLimitException;
import com.fasterxml.jackson.databind.JsonNode;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientRequestException;
import org.springframework.web.reactive.function.client.WebClientResponseException;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Groq client (OpenAI-compatible chat + embeddings).
 *
 * Same error contract as {@link GeminiClient}: HTTP 429 surfaces as
 * {@link RateLimitException} so the Kafka retry lane handles backoff; transient
 * 5xx/connection errors retry in-place with exponential backoff; other 4xx fail
 * fast (non-retryable → the consumer dead-letters).
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class GroqClient {

    private final GroqConfig config;
    private final WebClient.Builder webClientBuilder;

    /**
     * Single-turn chat completion, returns the raw assistant text.
     *
     * @throws RateLimitException on HTTP 429
     */
    public String generateContent(String userPrompt, String systemInstruction, String apiKey) {
        Map<String, Object> body = Map.of(
            "model", config.getChatModel(),
            "messages", List.of(
                Map.of("role", "system", "content", systemInstruction),
                Map.of("role", "user", "content", userPrompt)),
            "temperature", 0.3,
            "max_tokens", config.getMaxOutputTokens());

        JsonNode response = post("/chat/completions", apiKey, body);
        JsonNode choices = response.path("choices");
        if (!choices.isArray() || choices.isEmpty()) {
            throw new RuntimeException("Groq chat/completions returned no choices");
        }
        String text = choices.get(0).path("message").path("content").asText("");
        if (text.isBlank()) {
            throw new RuntimeException("Groq chat/completions returned empty content. finish_reason="
                + choices.get(0).path("finish_reason").asText("?"));
        }
        if ("length".equals(choices.get(0).path("finish_reason").asText())) {
            log.warn("Groq completion truncated at max_tokens (length={})", text.length());
        }
        return text;
    }

    /**
     * Embeds all texts in one /embeddings call. Order is restored from the
     * response's index field. nomic-embed-text-v1_5 → 768-dim vectors.
     *
     * @throws RateLimitException on HTTP 429
     */
    public List<float[]> batchEmbeddings(List<String> texts, String apiKey) {
        if (texts == null || texts.isEmpty()) {
            return List.of();
        }
        Map<String, Object> body = Map.of(
            "model", config.getEmbeddingModel(),
            "input", texts);

        JsonNode response = post("/embeddings", apiKey, body);
        JsonNode data = response.path("data");
        if (!data.isArray() || data.isEmpty()) {
            throw new RuntimeException("Groq /embeddings returned no data");
        }

        float[][] ordered = new float[texts.size()][];
        for (JsonNode entry : data) {
            int index = entry.path("index").asInt(-1);
            JsonNode vector = entry.path("embedding");
            if (index < 0 || index >= ordered.length || !vector.isArray()) {
                throw new RuntimeException("Groq /embeddings returned malformed entry (index=" + index + ")");
            }
            float[] values = new float[vector.size()];
            for (int i = 0; i < vector.size(); i++) {
                values[i] = (float) vector.get(i).asDouble();
            }
            ordered[index] = values;
        }
        List<float[]> result = new ArrayList<>(ordered.length);
        for (float[] v : ordered) {
            if (v == null) {
                throw new RuntimeException("Groq /embeddings response missing an index — refusing partial batch");
            }
            result.add(v);
        }
        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────

    private JsonNode post(String path, String apiKey, Map<String, Object> body) {
        String key = resolveKey(apiKey);
        int maxRetries = config.getMaxRetries();
        Exception lastException = null;

        for (int attempt = 0; attempt < maxRetries; attempt++) {
            try {
                JsonNode response = webClientBuilder.build()
                    .post()
                    .uri(config.getBaseUrl() + path)
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + key)
                    .bodyValue(body)
                    .retrieve()
                    .bodyToMono(JsonNode.class)
                    .block();
                if (response == null) {
                    throw new RuntimeException("Groq " + path + " returned null response");
                }
                return response;

            } catch (WebClientResponseException e) {
                int status = e.getStatusCode().value();
                if (status == 429) {
                    throw new RateLimitException("Rate limit (429) on Groq " + path + ": "
                        + e.getResponseBodyAsString(), e);
                }
                if (status == 401 || status == 403) {
                    throw new RuntimeException("Groq auth failed (" + status + "): " + e.getResponseBodyAsString(), e);
                }
                if (status < 500) {
                    throw new RuntimeException("Groq " + path + " client error (" + status + "): "
                        + e.getResponseBodyAsString(), e);
                }
                lastException = e;
            } catch (WebClientRequestException e) {
                lastException = e;
            }
            if (attempt < maxRetries - 1) {
                long delay = 1000L * (1L << attempt);
                log.warn("Groq {} transient error, attempt {}/{}, retry in {}ms",
                    path, attempt + 1, maxRetries, delay);
                sleepQuietly(delay);
            }
        }
        throw new RuntimeException("Groq " + path + " failed after " + maxRetries + " attempts", lastException);
    }

    private String resolveKey(String apiKey) {
        if (apiKey != null && !apiKey.isEmpty()) {
            return apiKey;
        }
        List<String> keys = config.getAllApiKeys();
        if (!keys.isEmpty()) {
            return keys.get(0);
        }
        throw new RuntimeException("No Groq API key configured. Set GROQ_API_KEY env var.");
    }

    private void sleepQuietly(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
