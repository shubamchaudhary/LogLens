package com.deepdocai.api.dto.response;

import com.deepdocai.common.constants.ProcessingStatus;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.util.UUID;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class DocumentResponse {
    private UUID id;
    private String fileName;
    private String fileType;
    private Long fileSizeBytes;
    private Integer totalPages;
    private Integer totalChunks;
    private ProcessingStatus processingStatus;
    private String errorMessage;
    private Instant createdAt;
    private Instant processingCompletedAt;
}

