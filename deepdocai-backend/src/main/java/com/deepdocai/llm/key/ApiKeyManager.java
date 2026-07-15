package com.deepdocai.llm.key;

import lombok.extern.slf4j.Slf4j;

import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

/**
 * Manages a fixed set of ApiKeySlots — one per Gemini API key.
 *
 * Design: each slot is permanently bound to a single worker thread.
 * No round-robin, no sharing. Thread-0 always uses slot[0], Thread-1 uses slot[1], etc.
 * This makes rate limiting purely local (no contention, no locks between threads).
 *
 * Rate limit per slot: 80% of 10 calls/min = 8 calls/min = 7,500 ms between calls.
 *
 * Bean registration: via {@link com.deepdocai.llm.config.ApiKeyManagerConfig#apiKeyManager()}.
 */
@Slf4j
public class ApiKeyManager {

    private final List<ApiKeySlot> slots;

    public ApiKeyManager(List<String> apiKeys, long minIntervalMs) {
        this(apiKeys, minIntervalMs, 0L);
    }

    public ApiKeyManager(List<String> apiKeys, long minIntervalMs, long tpmBudget) {
        if (apiKeys == null || apiKeys.isEmpty()) {
            throw new IllegalArgumentException("At least one API key is required");
        }
        this.slots = IntStream.range(0, apiKeys.size())
            .mapToObj(i -> new ApiKeySlot(apiKeys.get(i), i, minIntervalMs, tpmBudget))
            .collect(Collectors.toList());

        log.info("ApiKeyManager initialized with {} slots, minIntervalMs={}, tpmBudget={}",
            slots.size(), minIntervalMs, tpmBudget);
    }

    /** Returns the slot permanently assigned to the given thread index. */
    public ApiKeySlot getSlot(int index) {
        if (index < 0 || index >= slots.size()) {
            throw new IllegalArgumentException("Invalid slot index: " + index);
        }
        return slots.get(index);
    }

    public int getSlotCount() {
        return slots.size();
    }

    public List<ApiKeySlot> getAllSlots() {
        return List.copyOf(slots);
    }

    /** Convenience: returns just the API key string for the given index. */
    public String getApiKey(int index) {
        return getSlot(index).getApiKey();
    }

    /** Legacy: returns any API key (uses slot 0). For single-key callers. */
    public String getAnyApiKey() {
        return slots.get(0).getApiKey();
    }
}
