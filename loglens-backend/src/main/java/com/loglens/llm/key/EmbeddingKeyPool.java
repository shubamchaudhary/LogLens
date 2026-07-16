package com.loglens.llm.key;

import com.loglens.llm.client.GeminiConfig;
import com.loglens.llm.worker.RateLimitException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;

/**
 * Proactive, thread-safe budget keeper for the Gemini embedding keys.
 *
 * Guarantee: a key is handed out ONLY when dispatching one more call keeps it
 * inside BOTH its requests-per-minute and tokens-per-minute budgets — so under
 * normal operation no call is ever fired outside a key's rate limit and 429s
 * simply don't happen. When the provider still 429s (shared-project quota,
 * clock skew, limit changes), the key is benched for a cooldown
 * ({@code gemini.cooldown-429-ms}, default 15s; ~1h for daily exhaustion) and
 * callers rotate to the next key.
 *
 * Unlike {@link ApiKeySlot} (single-owner-thread by design), this pool is
 * shared by ALL Kafka lane threads: state is guarded by the pool monitor and
 * waiting uses {@code wait/notifyAll}, so a sleeping acquirer never blocks
 * other threads from taking a different key's budget.
 *
 * All limits are per-minute sliding windows (deques of timestamped entries),
 * sized from config with the safety margin already baked into the configured
 * numbers (e.g. 75 of the real 100 RPM, 24K of the real 30K TPM).
 */
@Component
@Slf4j
public class EmbeddingKeyPool {

    private static final long WINDOW_MS = 60_000L;
    /** acquire() gives up after this long and throws RateLimitException so the
     *  Kafka retry lane parks the work instead of stalling a consumer thread
     *  past its poll interval. */
    private static final long MAX_ACQUIRE_WAIT_MS = 90_000L;

    private final List<String> keys;
    private final long rpmLimit;
    private final long tpmLimit;
    private final long cooldown429Ms;
    private final long dailyCooldownMs;

    // Per-key state, all guarded by the pool monitor.
    private final Deque<Long>[] callWindow;     // call timestamps within 60s
    private final Deque<long[]>[] tokenWindow;  // {timestamp, tokens} within 60s
    private final long[] tokenWindowSum;
    private final long[] cooldownUntil;
    private int cursor;

    @SuppressWarnings("unchecked")
    public EmbeddingKeyPool(GeminiConfig config) {
        this.keys = List.copyOf(config.getAllApiKeys());
        this.rpmLimit = Math.max(1, config.getEmbeddingRpmLimit());
        this.tpmLimit = Math.max(1, config.getEmbeddingTpmLimit());
        this.cooldown429Ms = config.getCooldown429Ms();
        this.dailyCooldownMs = config.getDailyCooldownMinutes() * 60_000L;
        int n = Math.max(1, keys.size());
        this.callWindow = new Deque[n];
        this.tokenWindow = new Deque[n];
        this.tokenWindowSum = new long[n];
        this.cooldownUntil = new long[n];
        for (int i = 0; i < n; i++) {
            callWindow[i] = new ArrayDeque<>();
            tokenWindow[i] = new ArrayDeque<>();
        }
        log.info("EmbeddingKeyPool: {} key(s), {} RPM / {} TPM per key, 429 cooldown {}ms",
            keys.size(), rpmLimit, tpmLimit, cooldown429Ms);
    }

    public int keyCount() {
        return keys.size();
    }

    /**
     * Blocks until some key can absorb one call of {@code estimatedTokens}
     * within its RPM+TPM budgets, reserves the budget, and returns that key.
     *
     * @throws RateLimitException if no key frees up within {@link #MAX_ACQUIRE_WAIT_MS}
     *         (all keys cooling down / budget-saturated) — callers surface this to
     *         the Kafka retry lane rather than blocking a consumer thread forever.
     */
    public synchronized String acquire(long estimatedTokens) {
        if (keys.isEmpty()) {
            throw new IllegalStateException("No Gemini API key configured. Set GEMINI_API_KEYS env var.");
        }
        long est = Math.min(Math.max(0L, estimatedTokens), tpmLimit);
        long deadline = System.currentTimeMillis() + MAX_ACQUIRE_WAIT_MS;

        while (true) {
            long now = System.currentTimeMillis();
            for (int i = 0; i < keys.size(); i++) {
                int k = (cursor + i) % keys.size();
                if (now < cooldownUntil[k]) {
                    continue;
                }
                purge(k, now);
                if (callWindow[k].size() < rpmLimit && tokenWindowSum[k] + est <= tpmLimit) {
                    callWindow[k].addLast(now);
                    tokenWindow[k].addLast(new long[]{now, est});
                    tokenWindowSum[k] += est;
                    cursor = k + 1;
                    return keys.get(k);
                }
            }
            long waitMs = Math.min(nextFreeMs(now), deadline - now);
            if (now >= deadline || waitMs <= 0 && now >= deadline) {
                throw new RateLimitException("All " + keys.size()
                    + " embedding key(s) budget-saturated or cooling down for "
                    + MAX_ACQUIRE_WAIT_MS + "ms — deferring to retry lane", null);
            }
            try {
                // wait() releases the monitor: other threads can still acquire
                // or report 429s (which notifyAll()s us) while we sleep.
                wait(Math.max(50L, Math.min(waitMs, 1_000L)));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new RuntimeException("Interrupted waiting for embedding key budget", e);
            }
        }
    }

    /** Bench a key after a per-minute 429 (cooldown, then it self-heals). */
    public synchronized void reportRateLimited(String key) {
        bench(key, cooldown429Ms, "per-minute 429");
    }

    /** Bench a key whose project hit a per-DAY quota — long cooldown, re-probed hourly. */
    public synchronized void reportDailyExhausted(String key) {
        bench(key, dailyCooldownMs, "daily quota exhausted");
    }

    private void bench(String key, long ms, String reason) {
        int k = keys.indexOf(key);
        if (k >= 0) {
            cooldownUntil[k] = System.currentTimeMillis() + ms;
            log.warn("Embedding key[{}] benched {}ms ({})", k, ms, reason);
        }
        notifyAll();
    }

    private void purge(int k, long now) {
        long cutoff = now - WINDOW_MS;
        Deque<Long> calls = callWindow[k];
        while (!calls.isEmpty() && calls.peekFirst() < cutoff) {
            calls.pollFirst();
        }
        Deque<long[]> tokens = tokenWindow[k];
        long[] head;
        while ((head = tokens.peekFirst()) != null && head[0] < cutoff) {
            tokens.pollFirst();
            tokenWindowSum[k] -= head[1];
        }
    }

    /** Earliest moment any key might free budget (window entry expiry or cooldown end). */
    private long nextFreeMs(long now) {
        long min = WINDOW_MS;
        for (int k = 0; k < keys.size(); k++) {
            long candidate;
            if (now < cooldownUntil[k]) {
                candidate = cooldownUntil[k] - now;
            } else {
                long oldestCall = callWindow[k].isEmpty() ? Long.MAX_VALUE : callWindow[k].peekFirst() + WINDOW_MS - now;
                long[] oldestTok = tokenWindow[k].peekFirst();
                long oldestToken = oldestTok == null ? Long.MAX_VALUE : oldestTok[0] + WINDOW_MS - now;
                candidate = Math.min(oldestCall, oldestToken);
                if (candidate == Long.MAX_VALUE) {
                    candidate = 50L; // windows empty yet not admitted: est > budget edge; retry soon
                }
            }
            min = Math.min(min, Math.max(candidate, 0L));
        }
        return min;
    }
}
