package com.deepdocai.data.entity;

import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "query_history")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class QueryHistory {
    
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;
    
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", nullable = false)
    private User user;
    
    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "chat_id", nullable = false)
    private Chat chat;
    
    @Column(name = "query_text", nullable = false, columnDefinition = "TEXT")
    private String queryText;
    
    @Column(name = "query_embedding", columnDefinition = "vector(768)")
    private float[] queryEmbedding;
    
    @Column(name = "marks_requested")
    private Integer marksRequested;
    
    @Column(name = "answer_text", columnDefinition = "TEXT")
    private String answerText;
    
    @Column(name = "sources_used", columnDefinition = "jsonb")
    @org.hibernate.annotations.JdbcTypeCode(SqlTypes.JSON)
    private String sourcesUsed;
    
    @Column(name = "retrieval_time_ms")
    private Integer retrievalTimeMs;
    
    @Column(name = "generation_time_ms")
    private Integer generationTimeMs;
    
    @Column(name = "total_time_ms")
    private Integer totalTimeMs;
    
    @Column(name = "chunks_retrieved")
    private Integer chunksRetrieved;
    
    @CreationTimestamp
    @Column(name = "created_at")
    private Instant createdAt;
}

