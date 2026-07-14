package com.deepdocai.llm.worker;

import java.util.concurrent.CompletableFuture;
import java.util.function.Function;

/**
 * A unit of work placed in the KeyedWorkerPool queue.
 * Carries the task payload, the future to complete, the processing function, and retry count.
 */
public class WorkItem<T, R> {

    public final T task;
    public final CompletableFuture<R> future;
    public final Function<String, R> processor; // receives apiKey, returns result
    public int retries;
    public static final int MAX_RETRIES = 3;

    public WorkItem(T task, CompletableFuture<R> future, Function<String, R> processor) {
        this.task = task;
        this.future = future;
        this.processor = processor;
        this.retries = 0;
    }

    public boolean canRetry() {
        return retries < MAX_RETRIES;
    }

    public void incrementRetry() {
        retries++;
    }
}
