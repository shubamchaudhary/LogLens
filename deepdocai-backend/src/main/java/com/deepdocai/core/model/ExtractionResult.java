package com.deepdocai.core.model;

import lombok.Builder;
import lombok.Data;

import java.util.List;

@Data
@Builder
public class ExtractionResult {
    private List<String> pageContents;
    private List<String> pageTitles;
    private Integer totalPages;
}

