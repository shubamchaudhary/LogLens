package com.deepdocai.api.dto.request;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

import java.util.List;
import java.util.UUID;

@Data
public class QueryRequest {
    
    @NotBlank(message = "Question is required")
    private String question;
    
    private Integer marks;
    
    private List<UUID> documentIds;
    
    private String formatInstructions;
    
    private UUID chatId; // Required for chat-scoped queries
    
    private Boolean useCrossChat = false; // Default: false (chat-scoped), true = search all user's chats
}

