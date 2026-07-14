package com.deepdocai.common.constants;

/**
 * Session-level analysis lifecycle. Persisted as text in
 * {@code sessions.analysis_status} and mirrored by the SSE progress stream.
 * Order reflects the pipeline: chunk → parse → enrich → correlate → report.
 */
public enum AnalysisStatus {
    CREATED,
    CHUNKING,
    PARSING,
    ENRICHING,
    CORRELATING,
    REPORTING,
    DONE,
    FAILED
}
