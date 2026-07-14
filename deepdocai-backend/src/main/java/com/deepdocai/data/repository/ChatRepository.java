package com.deepdocai.data.repository;

import com.deepdocai.data.entity.Chat;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

@Repository
public interface ChatRepository extends JpaRepository<Chat, UUID> {
    
    Page<Chat> findByUserIdOrderByUpdatedAtDesc(UUID userId, Pageable pageable);
    
    List<Chat> findByUserIdOrderByUpdatedAtDesc(UUID userId);
    
    long countByUserId(UUID userId);
    
    boolean existsByIdAndUserId(UUID id, UUID userId);
    
    java.util.Optional<Chat> findByIdAndUserId(UUID id, UUID userId);
}

