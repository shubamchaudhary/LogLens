package com.deepdocai.llm.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

@Data
public class EmbeddingResponse {
    @JsonProperty("embedding")
    private EmbeddingData embedding;
    
    @Data
    public static class EmbeddingData {
        @JsonProperty("values")
        private float[] values;
    }
}

