package com.loglens.enrich;

import com.loglens.common.constants.KafkaTopics;
import com.loglens.common.messages.EnrichRequest;
import com.loglens.data.repository.SessionRepository;
import com.loglens.ingest.MetricsWriter;
import com.loglens.llm.client.LlmGateway;
import com.loglens.llm.key.ApiKeyManager;
import com.loglens.llm.worker.RateLimitException;
import com.loglens.storage.SessionChunkRepository;
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
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

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
 * {@link com.loglens.llm.key.ApiKeySlot} (interval set per provider — Groq
 * 2.5s, Gemini 7.5s). Transport goes through {@link LlmGateway}
 * ({@code loglens.llm.provider}).
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
 * never sleeps 60s); once {@code attempt >= MAX_RATE_LIMIT_ATTEMPTS} (~24h of
 * hourly-probed retrying — rate-limited work is effectively never dropped) — or on any
 * non-retryable error — the item is dead-lettered. <em>Every</em> terminal
 * outcome (success or DLQ) bumps {@code enriched_windows} so a single failed item
 * can never wedge session completion. Offsets are committed manually only after
 * that bookkeeping.
 *
 * <p><b>Exactly-once effect.</b> Kafka redelivers after a crash between the DB
 * write and the offset commit, and a replay re-sends everything. The slow part
 * (LLM / embedding calls) runs outside any transaction and only COLLECTS results;
 * then ONE transaction inserts the {@code enrich_work_done} marker for the
 * {@code workId}, writes findings/embeddings and bumps {@code enriched_windows}.
 * A redelivered item loses the marker insert and writes nothing, and a work id
 * already in the ledger is skipped before any LLM call is made.
 */
@Component
@Slf4j
public class EnrichConsumer {

    /** Rate-limited work is NEVER dropped (owner: completeness over speed) — it
     *  cycles the 60s retry lane until quota returns, even across a daily-quota
     *  reset. 1440 attempts ≈ 24h of retrying; only after that does it DLQ.
     *  Non-retryable errors still dead-letter immediately (separate catch). */
    private static final int MAX_RATE_LIMIT_ATTEMPTS = 1440;
    // Fixed token allowance for the findings-JSON completion, added to the
    // prompt estimate when pacing against the key's tokens-per-minute budget.
    private static final int OUTPUT_TOKEN_ESTIMATE = 512;
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
    private final int maxContentChars;
    private final EnrichWorkLedger ledger;
    private final TransactionTemplate txTemplate;

    /** What one work item produced, collected outside the transaction. */
    record Outcome(List<FindingsWriter.Finding> findings, List<SessionChunkRepository.ChunkEmbedding> embeddings,
                   boolean sessionGone) {
        static final Outcome EMPTY = new Outcome(List.of(), List.of(), false);
        static final Outcome SESSION_GONE = new Outcome(List.of(), List.of(), true);
    }

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
        @Value("${loglens.window-seconds:60}") long windowSeconds,
        @Value("${loglens.enrich.max-content-chars:5000}") int maxContentChars,
        EnrichWorkLedger ledger,
        PlatformTransactionManager txManager
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
        this.maxContentChars = maxContentChars;
        this.ledger = ledger;
        this.txTemplate = new TransactionTemplate(txManager);
    }

    @KafkaListener(
        topics = "#{T(com.loglens.common.constants.KafkaTopics).LLM_ENRICH_REQUESTS}",
        groupId = "llm-workers",
        concurrency = "#{@apiKeyManager.getSlotCount()}")
    public void onEnrich(EnrichRequest request,
                         @Header(KafkaHeaders.RECEIVED_PARTITION) int partition,
                         Acknowledgment ack) {
        try {
            if (ledger.isDone(request.workId())) {
                log.info("Work {} ({}) already committed — skipping redelivery, no LLM call",
                    request.workId(), request.kind());
                return;
            }
            commit(request, process(request, partition));
        } catch (RateLimitException e) {
            int maxAttempts = MAX_RATE_LIMIT_ATTEMPTS;
            if (request.attempt() >= maxAttempts) {
                log.warn("Work {} ({}) still rate-limited at attempt {} → DLQ: {}",
                    request.workId(), request.kind(), request.attempt(), e.getMessage());
                deadLetter(request);
                commit(request, Outcome.EMPTY);
            } else {
                long notBefore = System.currentTimeMillis() + RETRY_DELAY_MS;
                kafkaTemplate.send(KafkaTopics.LLM_ENRICH_RETRY_60S,
                    request.sessionId().toString(), request.retry(notBefore));
                log.info("Work {} ({}) rate-limited → retry lane (attempt {} → {}): {}",
                    request.workId(), request.kind(), request.attempt(), request.attempt() + 1, e.getMessage());
            }
        } catch (Exception e) {
            log.error("Work {} ({}) failed non-retryably → DLQ: {}",
                request.workId(), request.kind(), e.toString());
            deadLetter(request);
            commit(request, Outcome.EMPTY);
        } finally {
            ack.acknowledge();
        }
    }

    private Outcome process(EnrichRequest request, int partition) {
        // A session deleted after its work was enqueued leaves a Kafka backlog
        // whose per-session chunk table is already dropped; skip it quietly
        // instead of dead-lettering every item with a bad-SQL-grammar error.
        if (!sessionRepository.existsById(request.sessionId())) {
            log.warn("Session {} no longer exists — skipping {} work {}",
                request.sessionId(), request.kind(), request.workId());
            return Outcome.SESSION_GONE;
        }
        // Modulo guards against a topic wider than the active provider's key
        // count (Kafka partitions can never be lowered on an existing volume).
        int lane = partition % apiKeyManager.getSlotCount();
        String apiKey = apiKeyManager.getApiKey(lane);
        return switch (request.kind()) {
            case EnrichRequest.ENRICH_WINDOW -> enrichWindow(request, lane, apiKey);
            case EnrichRequest.EMBED_BATCH -> embedBatch(request, lane, apiKey);
            default -> {
                log.warn("Unknown enrich kind '{}' for work {} — skipping", request.kind(), request.workId());
                yield Outcome.EMPTY;
            }
        };
    }

    /**
     * The only write path: marker + results + completion counter in ONE short
     * transaction, so a redelivery can never double-count or double-write.
     */
    private void commit(EnrichRequest request, Outcome outcome) {
        if (outcome.sessionGone()) {
            return;
        }
        Boolean won = txTemplate.execute(status -> {
            if (!ledger.claim(request.workId(), request.sessionId())) {
                return Boolean.FALSE;
            }
            for (FindingsWriter.Finding f : outcome.findings()) {
                findingsWriter.upsert(f);
            }
            if (!outcome.embeddings().isEmpty()) {
                chunkRepository.updateEmbeddings(request.sessionId(), outcome.embeddings());
            }
            sessionRepository.incrementEnrichedWindows(request.sessionId());
            return Boolean.TRUE;
        });
        if (Boolean.TRUE.equals(won)) {
            log.info("{} work {} committed → {} finding(s), {} embedding(s)",
                request.kind(), request.workId(), outcome.findings().size(), outcome.embeddings().size());
        } else {
            log.info("{} work {} already committed by another delivery — skipped", request.kind(), request.workId());
        }
        completion.checkAndTrigger(request.sessionId());
    }

    private Outcome enrichWindow(EnrichRequest request, int partition, String apiKey) {
        List<SessionChunkRepository.ChunkContent> chunks =
            chunkRepository.readChunks(request.sessionId(), request.chunkIds());
        if (chunks.isEmpty()) {
            log.warn("ENRICH_WINDOW work {} has no resolvable chunks — skipping", request.workId());
            return Outcome.EMPTY;
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
        List<String> segments = RecordAwareSplitter.split(content.toString(), maxContentChars);

        Instant rangeStart = minBucket;
        Instant rangeEnd = maxBucket == null ? null : maxBucket.plusSeconds(windowSeconds);
        List<FindingsWriter.Finding> findings = new ArrayList<>();
        for (String segment : segments) {
            String user = EnrichPrompts.user(segment, metricContext);

            apiKeyManager.getSlot(partition).enforceTokenBudget(estimateTokens(EnrichPrompts.SYSTEM, user));
            apiKeyManager.getSlot(partition).enforceRateLimit();
            String json;
            try {
                json = llmGateway.generate(user, EnrichPrompts.SYSTEM, apiKey);
            } finally {
                apiKeyManager.getSlot(partition).markCallMade();
            }

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
                findings.add(new FindingsWriter.Finding(
                    request.sessionId(), category, severity, title, explanation,
                    request.chunkIds(), rangeStart, rangeEnd, fingerprint, confidence));
            }
        }
        log.info("ENRICH_WINDOW work {} → {} finding(s) from {} LLM call(s), committing",
            request.workId(), findings.size(), segments.size());
        return new Outcome(findings, List.of(), false);
    }

    private Outcome embedBatch(EnrichRequest request, int partition, String apiKey) {
        List<SessionChunkRepository.ChunkContent> chunks =
            chunkRepository.readChunks(request.sessionId(), request.chunkIds());
        if (chunks.isEmpty()) {
            log.warn("EMBED_BATCH work {} has no resolvable chunks — skipping", request.workId());
            return Outcome.EMPTY;
        }

        List<String> texts = new ArrayList<>(chunks.size());
        for (SessionChunkRepository.ChunkContent c : chunks) {
            texts.add(c.content());
        }

        // No lane pacing here: the lane slot budgets the CHAT provider (Groq),
        // but this call spends the EMBEDDING provider's quota — EmbeddingKeyPool
        // inside the client does the per-Gemini-key RPM+TPM budgeting.
        List<float[]> vectors = llmGateway.embedBatch(texts, apiKey);

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
        return new Outcome(List.of(), updates, false);
    }

    /**
     * Rough token estimate for a Groq generation call, used to pace against the
     * key's tokens-per-minute budget. English text is ~4 chars/token; we add a
     * fixed allowance for the JSON completion (findings are small). Groq's TPM
     * throttle counts prompt + actual completion, so a slight over-estimate just
     * buys safety margin against a 429.
     */
    private static long estimateTokens(String system, String user) {
        return (system.length() + user.length()) / 4L + OUTPUT_TOKEN_ESTIMATE;
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
