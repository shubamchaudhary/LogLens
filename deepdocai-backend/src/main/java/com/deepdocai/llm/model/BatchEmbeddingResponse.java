package com.deepdocai.llm.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import lombok.Data;

import java.util.List;

/**
 * Response from Gemini batchEmbedContents API.
 * Structure: { "embeddings": [ { "values": [float, ...] }, ... ] }
 */
@Data
@JsonIgnoreProperties(ignoreUnknown = true)
public class BatchEmbeddingResponse {

    private List<EmbeddingEntry> embeddings;

    @Data
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class EmbeddingEntry {
        private float[] values;
    }
}
