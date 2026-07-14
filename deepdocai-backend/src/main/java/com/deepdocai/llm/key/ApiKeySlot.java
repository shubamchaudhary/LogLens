package com.deepdocai.llm.key;

import lombok.Getter;
import lombok.extern.slf4j.Slf4j;

import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Represents a single Gemini API key with its own rate-limit state.
 * One slot is permanently bound to one worker thread — no sharing between threads.
 *
 * Rate strategy: 80% of 10 calls/min = 8 calls/min = 1 call every 7,500 ms.
 * On 429: the owning thread sleeps 60s then retries (handled in the worker, not here).
 */
@Slf4j
public class ApiKeySlot {

    @Getter
    private final String apiKey;

    @Getter
    private final int index;

    private final AtomicLong lastCallTimeMs = new AtomicLong(0);
    private final AtomicReference<KeyState> state = new AtomicReference<>(KeyState.AVAILABLE);

    // 80% of 10 calls/min = 8 calls/min → 7500 ms minimum between calls
    private static final long DEFAULT_MIN_INTERVAL_MS = 7_500L;
    private final long minIntervalMs;

    public ApiKeySlot(String apiKey, int index) {
        this(apiKey, index, DEFAULT_MIN_INTERVAL_MS);
    }

    public ApiKeySlot(String apiKey, int index, long minIntervalMs) {
        this.apiKey = apiKey;
        this.index = index;
        this.minIntervalMs = minIntervalMs;
    }

    /**
     * Blocks the calling thread until the rate limit window allows the next call.
     * Safe to call from a single owner thread only — no lock needed.
     */
    public void enforceRateLimit() {
        long now = System.currentTimeMillis();
        long last = lastCallTimeMs.get();
        long waitMs = minIntervalMs - (now - last);
        if (waitMs > 0) {
            log.debug("Key[{}] rate-limit wait: {}ms", index, waitMs);
            try {
                Thread.sleep(waitMs);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new RuntimeException("Interrupted during rate-limit wait on key " + index, e);
            }
        }
    }

    /**
     * Record that a call was just made. Call immediately after the API call returns.
     */
    public void markCallMade() {
        lastCallTimeMs.set(System.currentTimeMillis());
    }

    /**
     * Called when a 429 is received. Puts the slot in RATE_LIMITED state.
     * The owning thread is responsible for sleeping 60s before calling markRecovered().
     */
    public void markRateLimited() {
        state.set(KeyState.RATE_LIMITED);
        log.warn("Key[{}] marked RATE_LIMITED", index);
    }

    /**
     * Called after the 60s backoff to signal the slot is usable again.
     */
    public void markRecovered() {
        state.compareAndSet(KeyState.RATE_LIMITED, KeyState.AVAILABLE);
        // Reset lastCallTime so rate limiter doesn't add unnecessary delay on top of 60s sleep
        lastCallTimeMs.set(System.currentTimeMillis() - minIntervalMs);
        log.info("Key[{}] recovered from RATE_LIMITED", index);
    }

    public void markInUse() {
        state.set(KeyState.IN_USE);
    }

    public void markAvailable() {
        state.compareAndSet(KeyState.IN_USE, KeyState.AVAILABLE);
    }

    public KeyState getState() {
        return state.get();
    }

    public boolean isRateLimited() {
        return state.get() == KeyState.RATE_LIMITED;
    }

    @Override
    public String toString() {
        return "ApiKeySlot[index=" + index + ", state=" + state.get() + "]";
    }
}
