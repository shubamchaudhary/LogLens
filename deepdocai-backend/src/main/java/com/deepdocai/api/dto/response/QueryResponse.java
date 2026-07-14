package com.deepdocai.api.dto.response;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.util.List;
import java.util.UUID;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class QueryResponse {
    private String answer;
    private List<SourceInfo> sources;
    private Metadata metadata;
    
    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class SourceInfo {
        private UUID documentId;
        private String fileName;
        private Integer pageNumber;
        private Integer slideNumber;
        private String excerpt;
        private Double similarity;
    }
    
    @Data
    @Builder
    @NoArgsConstructor
    @AllArgsConstructor
    public static class Metadata {
        private Long retrievalTimeMs;
        private Long generationTimeMs;
        private Long totalTimeMs;
        private Integer chunksUsed;
        private Integer tokensUsed;
    }
}

