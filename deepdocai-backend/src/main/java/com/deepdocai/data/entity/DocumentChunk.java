package com.deepdocai.data.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "document_chunks")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class DocumentChunk {
    
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;
    
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "document_id", nullable = false)
    private Document document;
    
    @Column(name = "user_id", nullable = false)
    private UUID userId;
    
    @Column(name = "chat_id", nullable = false)
    private UUID chatId;
    
    @Column(name = "chunk_index", nullable = false)
    private Integer chunkIndex;
    
    @Column(name = "content", nullable = false, columnDefinition = "TEXT")
    private String content;
    
    @Column(name = "content_hash")
    private String contentHash;
    
    @Column(name = "page_number")
    private Integer pageNumber;
    
    @Column(name = "slide_number")
    private Integer slideNumber;
    
    @Column(name = "section_title")
    private String sectionTitle;
    
    @Column(name = "embedding", columnDefinition = "vector(768)")
    private float[] embedding;
    
    @Column(name = "token_count")
    private Integer tokenCount;
    
    @CreationTimestamp
    @Column(name = "created_at")
    private Instant createdAt;
}

