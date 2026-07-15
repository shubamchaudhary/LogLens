package com.deepdocai.ingest.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Small deterministic statistics helpers for Layer-1 latency aggregation. */
public final class Stats {

    private Stats() {
    }

    /**
     * 95th percentile (nearest-rank) of a millisecond sample list. Returns 0 for
     * an empty list; equals the max for very small samples.
     */
    public static double p95(List<Long> samplesMs) {
        if (samplesMs == null || samplesMs.isEmpty()) {
            return 0;
        }
        List<Long> sorted = new ArrayList<>(samplesMs);
        Collections.sort(sorted);
        int rank = (int) Math.ceil(0.95 * sorted.size());
        int idx = Math.min(sorted.size(), Math.max(1, rank)) - 1;
        return sorted.get(idx);
    }
}
