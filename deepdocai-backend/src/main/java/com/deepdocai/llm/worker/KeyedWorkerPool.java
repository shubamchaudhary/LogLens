package com.deepdocai.llm.worker;

import com.deepdocai.llm.key.ApiKeyManager;
import com.deepdocai.llm.key.ApiKeySlot;
import lombok.extern.slf4j.Slf4j;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

/**
 * Generic worker pool where each thread is permanently bound to one API key slot.
 *
 * Threading model:
 *   Thread-0 → Slot[0] (Key-0)
 *   Thread-1 → Slot[1] (Key-1)
 *   ...
 *   Thread-N → Slot[N] (Key-N)
 *
 * All threads compete on a single shared LinkedBlockingQueue<WorkItem>.
 * This ensures:
 *   - No two threads process the same work item (queue poll is atomic)
 *   - Dynamic load balancing: faster threads do more work
 *   - Rate limiting is local to each thread (no shared lock needed)
 *
 * On 429 (RateLimitException):
 *   - Re-enqueue the work item
 *   - Sleep 60 seconds (rate limit window resets)
 *   - Resume
 *
 * On other failures:
 *   - Retry up to MAX_RETRIES times
 *   - If exhausted: complete the future exceptionally (caller decides how to handle)
 */
@Slf4j
public class KeyedWorkerPool<T, R> {

    private static final long RATE_LIMIT_BACKOFF_MS = 60_000L;
    private static final long POLL_TIMEOUT_MS = 1_000L;

    private final LinkedBlockingQueue<WorkItem<T, R>> queue = new LinkedBlockingQueue<>();
    private final List<Thread> workerThreads = new ArrayList<>();
    private final ApiKeyManager keyManager;
    private final String poolName;
    private volatile boolean running = false;

    public KeyedWorkerPool(ApiKeyManager keyManager, String poolName) {
        this.keyManager = keyManager;
        this.poolName = poolName;
    }

    /** Start all worker threads. Call once at application startup (or on first use). */
    public synchronized void start() {
        if (running) return;
        running = true;
        int slotCount = keyManager.getSlotCount();
        for (int i = 0; i < slotCount; i++) {
            final int slotIndex = i;
            Thread t = new Thread(() -> runWorker(slotIndex), poolName + "-worker-" + i);
            t.setDaemon(true);
            t.setUncaughtExceptionHandler((thread, ex) ->
                log.error("[{}] Worker thread {} crashed unexpectedly", poolName, thread.getName(), ex));
            workerThreads.add(t);
            t.start();
        }
        log.info("[{}] Started {} worker threads", poolName, slotCount);
    }

    /** Stop all worker threads gracefully. */
    public synchronized void stop() {
        running = false;
        workerThreads.forEach(Thread::interrupt);
        workerThreads.clear();
        log.info("[{}] Stopped", poolName);
    }

    /**
     * Submit a task. The processor lambda receives the API key string and returns a result.
     * Returns a CompletableFuture that completes when any worker processes this task.
     */
    public CompletableFuture<R> submit(T task, Function<String, R> processor) {
        CompletableFuture<R> future = new CompletableFuture<>();
        queue.offer(new WorkItem<>(task, future, processor));
        return future;
    }

    /** Current queue depth — useful for monitoring. */
    public int queueSize() {
        return queue.size();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Worker logic
    // ─────────────────────────────────────────────────────────────────────────

    private void runWorker(int slotIndex) {
        ApiKeySlot slot = keyManager.getSlot(slotIndex);
        log.info("[{}] Worker-{} started, bound to key index {}", poolName, slotIndex, slotIndex);

        while (running) {
            WorkItem<T, R> item = null;
            try {
                item = queue.poll(POLL_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                if (item == null) continue; // no work, keep alive

                processItem(item, slot, slotIndex);

            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                log.info("[{}] Worker-{} interrupted, shutting down", poolName, slotIndex);
                break;
            } catch (Exception e) {
                // Safety net — should not normally reach here since processItem handles its own errors
                if (item != null && !item.future.isDone()) {
                    item.future.completeExceptionally(e);
                }
                log.error("[{}] Worker-{} unexpected error", poolName, slotIndex, e);
            }
        }

        log.info("[{}] Worker-{} exited", poolName, slotIndex);
    }

    private void processItem(WorkItem<T, R> item, ApiKeySlot slot, int slotIndex) throws InterruptedException {
        try {
            // Enforce per-key rate limit (7,500 ms between calls)
            slot.enforceRateLimit();

            // Execute the actual LLM call
            R result = item.processor.apply(slot.getApiKey());

            // Record the call time for next rate-limit calculation
            slot.markCallMade();

            item.future.complete(result);
            log.debug("[{}] Worker-{} completed task (queue remaining: {})", poolName, slotIndex, queue.size());

        } catch (RateLimitException e) {
            // 429 received: re-enqueue the item, sleep 60s
            log.warn("[{}] Worker-{} hit rate limit (429). Re-enqueueing task. Sleeping {}ms",
                poolName, slotIndex, RATE_LIMIT_BACKOFF_MS);
            slot.markRateLimited();
            queue.offer(item); // give it to another thread or retry after backoff
            Thread.sleep(RATE_LIMIT_BACKOFF_MS);
            slot.markRecovered();

        } catch (Exception e) {
            if (item.canRetry()) {
                item.incrementRetry();
                queue.offer(item);
                log.warn("[{}] Worker-{} task failed (attempt {}/{}), re-enqueueing. Error: {}",
                    poolName, slotIndex, item.retries, WorkItem.MAX_RETRIES, e.getMessage());
            } else {
                item.future.completeExceptionally(e);
                log.error("[{}] Worker-{} task failed after {} retries. Giving up.",
                    poolName, slotIndex, WorkItem.MAX_RETRIES, e);
            }
        }
    }
}
