package com.deepdocai.data.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "processing_jobs")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class ProcessingJob {
    
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;
    
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "document_id", nullable = false)
    private Document document;
    
    @Column(name = "status", nullable = false)
    @Builder.Default
    private String status = "QUEUED";
    
    @Column(name = "priority")
    @Builder.Default
    private Integer priority = 5;
    
    @Column(name = "attempts")
    @Builder.Default
    private Integer attempts = 0;
    
    @Column(name = "max_attempts")
    @Builder.Default
    private Integer maxAttempts = 3;
    
    @Column(name = "last_error", columnDefinition = "TEXT")
    private String lastError;
    
    @Column(name = "locked_by")
    private String lockedBy;
    
    @Column(name = "locked_until")
    private Instant lockedUntil;
    
    @CreationTimestamp
    @Column(name = "created_at")
    private Instant createdAt;
    
    @Column(name = "started_at")
    private Instant startedAt;
    
    @Column(name = "completed_at")
    private Instant completedAt;
}

