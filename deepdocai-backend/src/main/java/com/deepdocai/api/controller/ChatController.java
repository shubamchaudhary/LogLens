package com.deepdocai.api.controller;

import com.deepdocai.data.entity.Chat;
import com.deepdocai.data.entity.User;
import com.deepdocai.data.repository.ChatRepository;
import com.deepdocai.data.repository.DocumentRepository;
import com.deepdocai.data.repository.QueryHistoryRepository;
import com.deepdocai.data.repository.UserRepository;
import lombok.Builder;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/chats")
@RequiredArgsConstructor
public class ChatController {
    
    private final ChatRepository chatRepository;
    private final UserRepository userRepository;
    private final DocumentRepository documentRepository;
    private final QueryHistoryRepository queryHistoryRepository;
    private final com.deepdocai.data.repository.DocumentChunkRepository chunkRepository;
    
    @PostMapping
    public ResponseEntity<ChatResponse> createChat(
            @RequestBody CreateChatRequest request,
            Authentication authentication
    ) {
        UUID userId = UUID.fromString(authentication.getName());
        User user = userRepository.findById(userId)
            .orElseThrow(() -> new RuntimeException("User not found"));
        
        Chat chat = Chat.builder()
            .user(user)
            .title(request.getTitle() != null && !request.getTitle().isEmpty() 
                ? request.getTitle() 
                : "New Chat")
            .build();
        
        chat = chatRepository.save(chat);
        
        ChatResponse response = ChatResponse.builder()
            .id(chat.getId())
            .title(chat.getTitle())
            .createdAt(chat.getCreatedAt())
            .updatedAt(chat.getUpdatedAt())
            .build();
        
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }
    
    @GetMapping
    public ResponseEntity<Page<ChatResponse>> getChats(
            Pageable pageable,
            Authentication authentication
    ) {
        UUID userId = UUID.fromString(authentication.getName());
        
        Page<Chat> chats = chatRepository.findByUserIdOrderByUpdatedAtDesc(userId, pageable);
        
        Page<ChatResponse> response = chats.map(chat -> ChatResponse.builder()
            .id(chat.getId())
            .title(chat.getTitle())
            .createdAt(chat.getCreatedAt())
            .updatedAt(chat.getUpdatedAt())
            .build());
        
        return ResponseEntity.ok(response);
    }
    
    @GetMapping("/{chatId}")
    public ResponseEntity<ChatResponse> getChat(
            @PathVariable UUID chatId,
            Authentication authentication
    ) {
        UUID userId = UUID.fromString(authentication.getName());
        
        Chat chat = chatRepository.findById(chatId)
            .orElse(null);
        
        if (chat == null || !chat.getUser().getId().equals(userId)) {
            return ResponseEntity.notFound().build();
        }
        
        ChatResponse response = ChatResponse.builder()
            .id(chat.getId())
            .title(chat.getTitle())
            .createdAt(chat.getCreatedAt())
            .updatedAt(chat.getUpdatedAt())
            .build();
        
        return ResponseEntity.ok(response);
    }
    
    @PutMapping("/{chatId}")
    public ResponseEntity<ChatResponse> updateChat(
            @PathVariable UUID chatId,
            @RequestBody UpdateChatRequest request,
            Authentication authentication
    ) {
        UUID userId = UUID.fromString(authentication.getName());
        
        Chat chat = chatRepository.findById(chatId)
            .orElse(null);
        
        if (chat == null || !chat.getUser().getId().equals(userId)) {
            return ResponseEntity.notFound().build();
        }
        
        if (request.getTitle() != null && !request.getTitle().isEmpty()) {
            chat.setTitle(request.getTitle());
            chat = chatRepository.save(chat);
        }
        
        ChatResponse response = ChatResponse.builder()
            .id(chat.getId())
            .title(chat.getTitle())
            .createdAt(chat.getCreatedAt())
            .updatedAt(chat.getUpdatedAt())
            .build();
        
        return ResponseEntity.ok(response);
    }
    
    @DeleteMapping("/{chatId}")
    @Transactional
    public ResponseEntity<Void> deleteChat(
            @PathVariable UUID chatId,
            Authentication authentication
    ) {
        UUID userId = UUID.fromString(authentication.getName());
        
        Chat chat = chatRepository.findById(chatId)
            .orElse(null);
        
        if (chat == null || !chat.getUser().getId().equals(userId)) {
            return ResponseEntity.notFound().build();
        }
        
        // Delete chunks first (using native query to avoid vector loading)
        chunkRepository.deleteByChatId(chatId);
        
        // Delete all query history for this chat (using native query to avoid vector loading)
        queryHistoryRepository.deleteByChatId(chatId);
        
        // Delete all documents for this chat (using native query)
        documentRepository.deleteByChatId(chatId);
        
        // Delete the chat itself
        chatRepository.delete(chat);
        
        return ResponseEntity.noContent().build();
    }
    
    @Data
    @Builder
    public static class ChatResponse {
        private UUID id;
        private String title;
        private Instant createdAt;
        private Instant updatedAt;
    }
    
    @Data
    public static class CreateChatRequest {
        private String title;
    }
    
    @Data
    public static class UpdateChatRequest {
        private String title;
    }
}

