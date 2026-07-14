package com.deepdocai.api.controller;

import com.deepdocai.data.entity.User;
import com.deepdocai.data.repository.DocumentChunkRepository;
import com.deepdocai.data.repository.DocumentRepository;
import com.deepdocai.data.repository.QueryHistoryRepository;
import com.deepdocai.data.repository.UserRepository;
import lombok.Builder;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/user")
@RequiredArgsConstructor
public class UserController {
    
    private final UserRepository userRepository;
    private final DocumentRepository documentRepository;
    private final DocumentChunkRepository chunkRepository;
    private final QueryHistoryRepository queryHistoryRepository;
    
    @GetMapping("/profile")
    public ResponseEntity<UserProfileResponse> getProfile(Authentication authentication) {
        UUID userId = UUID.fromString(authentication.getName());
        User user = userRepository.findById(userId)
            .orElseThrow(() -> new RuntimeException("User not found"));
        
        long totalDocuments = documentRepository.countByUserId(userId);
        long totalChunks = chunkRepository.countByUserId(userId);
        Long storageUsed = documentRepository.getTotalStorageByUserId(userId);
        if (storageUsed == null) storageUsed = 0L;
        
        // Count queries this month using native query
        Instant startOfMonth = Instant.now().minusSeconds(30 * 24 * 60 * 60);
        List<Object[]> recentQueries = queryHistoryRepository.findHistoryByUserIdNative(
            userId, 
            org.springframework.data.domain.PageRequest.of(0, 1000)
        );
        long queriesThisMonth = recentQueries.stream()
            .filter(row -> {
                if (row[11] == null) return false;
                java.time.Instant createdAt;
                if (row[11] instanceof java.time.Instant) {
                    createdAt = (java.time.Instant) row[11];
                } else if (row[11] instanceof java.sql.Timestamp) {
                    createdAt = ((java.sql.Timestamp) row[11]).toInstant();
                } else if (row[11] instanceof java.time.OffsetDateTime) {
                    createdAt = ((java.time.OffsetDateTime) row[11]).toInstant();
                } else {
                    return false;
                }
                return createdAt.isAfter(startOfMonth);
            })
            .count();
        
        UserProfileResponse response = UserProfileResponse.builder()
            .id(user.getId())
            .email(user.getEmail())
            .fullName(user.getFullName())
            .createdAt(user.getCreatedAt())
            .stats(UserStats.builder()
                .totalDocuments(totalDocuments)
                .totalChunks(totalChunks)
                .storageUsedBytes(storageUsed)
                .queriesThisMonth(queriesThisMonth)
                .build())
            .build();
        
        return ResponseEntity.ok(response);
    }
    
    @GetMapping("/storage")
    public ResponseEntity<StorageResponse> getStorage(Authentication authentication) {
        UUID userId = UUID.fromString(authentication.getName());
        
        long documentCount = documentRepository.countByUserId(userId);
        long chunkCount = chunkRepository.countByUserId(userId);
        Long used = documentRepository.getTotalStorageByUserId(userId);
        if (used == null) used = 0L;
        
        StorageResponse response = StorageResponse.builder()
            .used(used)
            .limit(null) // No limit for now
            .documentCount(documentCount)
            .chunkCount(chunkCount)
            .build();
        
        return ResponseEntity.ok(response);
    }
    
    @Data
    @Builder
    private static class UserProfileResponse {
        private UUID id;
        private String email;
        private String fullName;
        private Instant createdAt;
        private UserStats stats;
    }
    
    @Data
    @Builder
    private static class UserStats {
        private long totalDocuments;
        private long totalChunks;
        private long storageUsedBytes;
        private long queriesThisMonth;
    }
    
    @Data
    @Builder
    private static class StorageResponse {
        private long used;
        private Long limit;
        private long documentCount;
        private long chunkCount;
    }
}

