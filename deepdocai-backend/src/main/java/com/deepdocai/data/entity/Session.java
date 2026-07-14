package com.deepdocai.data.entity;

import com.deepdocai.common.constants.AnalysisStatus;
import jakarta.persistence.*;
import lombok.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;
import java.util.UUID;

/**
 * One workspace = one log corpus (replaces the v1 {@code Chat}). Owns the
 * per-session chunk table {@code log_chunks_s_<uuid>} and drives the analysis
 * progress stream via {@link AnalysisStatus}.
 *
 * <p>The user link is a plain {@code user_id} column (no JPA relationship) so
 * the pipeline can reference sessions by id without dragging object graphs.
 */
@Entity
@Table(name = "sessions")
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class Session {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(nullable = false)
    @Builder.Default
    private String title = "New Session";

    @Enumerated(EnumType.STRING)
    @Column(name = "analysis_status", nullable = false, length = 20)
    @Builder.Default
    private AnalysisStatus analysisStatus = AnalysisStatus.CREATED;

    @Column(name = "total_windows")
    @Builder.Default
    private Integer totalWindows = 0;

    @Column(name = "enriched_windows")
    @Builder.Default
    private Integer enrichedWindows = 0;

    @Column(name = "error_message")
    private String errorMessage;

    @CreationTimestamp
    @Column(name = "created_at", updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at")
    private Instant updatedAt;
}
