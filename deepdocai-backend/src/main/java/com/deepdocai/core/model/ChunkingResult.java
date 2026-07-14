package com.deepdocai.core.model;

import lombok.Builder;
import lombok.Data;

@Data
@Builder
public class ChunkingResult {
    private String content;
    private Integer pageNumber;
    private Integer slideNumber;
    private String sectionTitle;
    private Integer tokenCount;
    private Integer chunkIndex;
}

