package com.deepdocai.enrich;

import com.deepdocai.common.constants.KafkaTopics;
import com.deepdocai.common.messages.EnrichRequest;
import com.deepdocai.data.repository.SessionRepository;
import com.deepdocai.ingest.MetricsWriter;
import com.deepdocai.llm.client.LlmGateway;
import com.deepdocai.llm.key.ApiKeyManager;
import com.deepdocai.llm.worker.RateLimitException;
import com.deepdocai.storage.SessionChunkRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.kafka.support.KafkaHeaders;
import org.springframework.messaging.handler.annotation.Header;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * The LLM enrichment lane. Each partition of {@code llm.enrich.requests} maps to
 * one API key of the active provider ({@code concurrency == slot count}), so the
 * consumer thread for partition <em>p</em> always uses lane <em>p mod slots</em>
 * and paces itself lock-free via that lane's
 * {@link com.deepdocai.llm.key.ApiKeySlot} (interval set per provider — Groq
 * 2.5s, Gemini 7.5s). Transport goes through {@link LlmGateway}
 * ({@code chunkai.llm.provider}).
 *
 * <p>Dispatch by {@link EnrichRequest#kind()}:
 * <ul>
 *   <li>{@code ENRICH_WINDOW} → prompt the LLM for JSON insight(s), upsert
 *       {@code log_findings} deduped on {@code (session_id, fingerprint)};</li>
 *   <li>{@code EMBED_BATCH} → batch-embed the chunks and write the vectors.</li>
 * </ul>
 *
 * <p>Error policy (global decision: at-least-once, idempotent): a 429 re-releases
 * the item to {@code llm.enrich.retry.60s} with {@code attempt+1} (the thread
 * never sleeps 60s); once {@code attempt >= MAX_ATTEMPTS} — or on any
 * non-retryable error — the item is dead-lettered. <em>Every</em> terminal
 * outcome (success or DLQ) bumps {@code enriched_windows} so a single failed item
 * can never wedge session completion. Offsets are committed manually only after
 * that bookkeeping.
 */
@Component
@Slf4j
public class EnrichConsumer {

    /** attempt >= this → give up and dead-letter (spec: 3). */
    private static final int MAX_ATTEMPTS = 3;
    private static final Set<String> VALID_SEVERITY = Set.of("INFO", "WARN", "ERROR", "CRITICAL");
    private static final long RETRY_DELAY_MS = 60_000L;

    private final ApiKeyManager apiKeyManager;
    private final LlmGateway llmGateway;
    private final SessionChunkRepository chunkRepository;
    private final MetricsWriter metricsWriter;
    private final FindingsWriter findingsWriter;
    private final SessionRepository sessionRepository;
    private final EnrichCompletion completion;
    private final KafkaTemplate<String, Object> kafkaTemplate;
    private final ObjectMapper objectMapper;
    private final long windowSeconds;

    public EnrichConsumer(
        ApiKeyManager apiKeyManager,
        LlmGateway llmGateway,
        SessionChunkRepository chunkRepository,
        MetricsWriter metricsWriter,
        FindingsWriter findingsWriter,
        SessionRepository sessionRepository,
        EnrichCompletion completion,
        KafkaTemplate<String, Object> kafkaTemplate,
        ObjectMapper objectMapper,
        @Value("${chunkai.window-seconds:60}") long windowSeconds
    ) {
        this.apiKeyManager = apiKeyManager;
        this.llmGateway = llmGateway;
        this.chunkRepository = chunkRepository;
        this.metricsWriter = metricsWriter;
        this.findingsWriter = findingsWriter;
        this.sessionRepository = sessionRepository;
        this.completion = completion;
        this.kafkaTemplate = kafkaTemplate;
        this.objectMapper = objectMapper;
        this.windowSeconds = windowSeconds;
    }

    @KafkaListener(
        topics = "#{T(com.deepdocai.common.constants.KafkaTopics).LLM_ENRICH_REQUESTS}",
        groupId = "llm-workers",
        concurrency = "#{@apiKeyManager.getSlotCount()}")
    public void onEnrich(EnrichRequest request,
                         @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
                         Acknowledgment ack) {
        try {
            process(request, partition);
            markEnriched(request.sessionId());
        } catch (RateLimitException e) {
            if (request.attempt() >= MAX_ATTEMPTS) {
                log.warn("Work {} ({}) still rate-limited at attempt {} → DLQ",
                    request.workId(), request.kind(), request.attempt());
                deadLetter(request);
                markEnriched(request.sessionId());
            } else {
                long notBefore = System.currentTimeMillis() + RETRY_DELAY_MS;
                kafkaTemplate.send(KafkaTopics.LLM_ENRICH_RETRY_60S,
                    request.sessionId().toString(), request.retry(notBefore));
                log.info("Work {} ({}) rate-limited → retry lane (attempt {} → {})",
                    request.workId(), request.kind(), request.attempt(), request.attempt() + 1);
            }
        } catch (Exception e) {
            log.error("Work {} ({}) failed non-retryably → DLQ: {}",
                request.workId(), request.kind(), e.toString());
            deadLetter(request);
            markEnriched(request.sessionId());
        } finally {
            ack.acknowledge();
        }
    }

    private void process(EnrichRequest request, int partition) {
        // Modulo guards against a topic wider than the active provider's key
        // count (Kafka partitions can never be lowered on an existing volume).
        int lane = partition % apiKeyManager.getSlotCount();
        String apiKey = apiKeyManager.getApiKey(lane);
        switch (request.kind()) {
            case EnrichRequest.ENRICH_WINDOW -> enrichWindow(request, lane, apiKey);
            case EnrichRequest.EMBED_BATCH -> embedBatch(request, lane, apiKey);
            default -> log.warn("Unknown enrich kind '{}' for work {} — skipping",
                request.kind(), request.workId());
        }
    }

    private void enrichWindow(EnrichRequest request, int partition, String apiKey) {
        List<SessionChunkRepository.ChunkContent> chunks =
            chunkRepository.readChunks(request.sessionId(), request.chunkIds());
        if (chunks.isEmpty()) {
            log.warn("ENRICH_WINDOW work {} has no resolvable chunks — skipping", request.workId());
            return;
        }

        StringBuilder content = new StringBuilder();
        List<Instant> buckets = new ArrayList<>();
        Instant minBucket = null;
        Instant maxBucket = null;
        for (SessionChunkRepository.ChunkContent c : chunks) {
            if (content.length() > 0) {
                content.append("\n\n");
            }
            content.append(c.content());
            buckets.add(c.timeBucket());
            if (minBucket == null || c.timeBucket().isBefore(minBucket)) {
                minBucket = c.timeBucket();
            }
            if (maxBucket == null || c.timeBucket().isAfter(maxBucket)) {
                maxBucket = c.timeBucket();
            }
        }

        List<String> metricContext = metricsWriter.metricContext(request.sessionId(), buckets);
        String user = EnrichPrompts.user(content.toString(), metricContext);

        apiKeyManager.getSlot(partition).enforceRateLimit();
        String json;
        try {
            json = llmGateway.generate(user, EnrichPrompts.SYSTEM, apiKey);
        } finally {
            apiKeyManager.getSlot(partition).markCallMade();
        }

        Instant rangeStart = minBucket;
        Instant rangeEnd = maxBucket == null ? null : maxBucket.plusSeconds(windowSeconds);
        int written = 0;
        for (JsonNode node : parseFindings(json)) {
            String title = text(node, "title");
            String explanation = text(node, "explanation");
            if (title.isBlank() || explanation.isBlank()) {
                continue;
            }
            String category = clampCategory(text(node, "category"));
            String severity = clampSeverity(text(node, "severity"));
            Double confidence = confidence(node);
            String fingerprint = EnrichPrompts.fingerprint(category, title);
            findingsWriter.upsert(new FindingsWriter.Finding(
                request.sessionId(), category, severity, title, explanation,
                request.chunkIds(), rangeStart, rangeEnd, fingerprint, confidence));
            written++;
        }
        log.info("ENRICH_WINDOW work {} → {} finding(s) upserted", request.workId(), written);
    }

    private void embedBatch(EnrichRequest request, int partition, String apiKey) {
        List<SessionChunkRepository.ChunkContent> chunks =
            chunkRepository.readChunks(request.sessionId(), request.chunkIds());
        if (chunks.isEmpty()) {
            log.warn("EMBED_BATCH work {} has no resolvable chunks — skipping", request.workId());
            return;
        }

        List<String> texts = new ArrayList<>(chunks.size());
        for (SessionChunkRepository.ChunkContent c : chunks) {
            texts.add(c.content());
        }

        apiKeyManager.getSlot(partition).enforceRateLimit();
        List<float[]> vectors;
        try {
            vectors = llmGateway.embedBatch(texts, apiKey);
        } finally {
            apiKeyManager.getSlot(partition).markCallMade();
        }

        int n = Math.min(vectors.size(), chunks.size());
        if (vectors.size() != chunks.size()) {
            log.warn("EMBED_BATCH work {}: expected {} vectors, got {} — writing {}",
                request.workId(), chunks.size(), vectors.size(), n);
        }
        List<SessionChunkRepository.ChunkEmbedding> updates = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            updates.add(new SessionChunkRepository.ChunkEmbedding(
                chunks.get(i).chunkId(), llmGateway.toVectorString(vectors.get(i))));
        }
        int updated = chunkRepository.updateEmbeddings(request.sessionId(), updates);
        log.info("EMBED_BATCH work {} → {} embeddings written", request.workId(), updated);
    }

    private void markEnriched(UUID sessionId) {
        sessionRepository.incrementEnrichedWindows(sessionId);
        completion.checkAndTrigger(sessionId);
    }

    private void deadLetter(EnrichRequest request) {
        kafkaTemplate.send(KafkaTopics.LLM_ENRICH_DLQ, request.sessionId().toString(), request);
    }

    // ── JSON helpers ─────────────────────────────────────────────────────────

    private List<JsonNode> parseFindings(String raw) {
        List<JsonNode> out = new ArrayList<>();
        if (raw == null || raw.isBlank()) {
            return out;
        }
        String json = stripFences(raw);
        try {
            JsonNode root = objectMapper.readTree(json);
            if (root.isArray()) {
                root.forEach(out::add);
            } else if (root.isObject()) {
                out.add(root);
            }
        } catch (Exception e) {
            log.warn("Could not parse enrichment JSON ({}). First 200 chars: {}",
                e.getMessage(), json.substring(0, Math.min(200, json.length())));
        }
        return out;
    }

    private static String stripFences(String raw) {
        String s = raw.trim();
        if (s.startsWith("```")) {
            int firstNl = s.indexOf('\n');
            if (firstNl >= 0) {
                s = s.substring(firstNl + 1);
            }
            if (s.endsWith("```")) {
                s = s.substring(0, s.length() - 3);
            }
        }
        return s.trim();
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return v == null || v.isNull() ? "" : v.asText().trim();
    }

    private static Double confidence(JsonNode node) {
        JsonNode v = node.get("confidence");
        if (v == null || v.isNull()) {
            return null;
        }
        double d = v.asDouble(Double.NaN);
        if (Double.isNaN(d)) {
            return null;
        }
        return Math.max(0.0, Math.min(1.0, d));
    }

    private static String clampSeverity(String raw) {
        String s = raw.toUpperCase();
        return VALID_SEVERITY.contains(s) ? s : "WARN";
    }

    private static String clampCategory(String raw) {
        String s = raw.trim().toUpperCase();
        if (s.isEmpty()) {
            return "GENERAL";
        }
        return s.length() > 30 ? s.substring(0, 30) : s;
    }
}
