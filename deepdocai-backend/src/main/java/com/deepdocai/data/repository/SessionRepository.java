package com.deepdocai.data.repository;

import com.deepdocai.common.constants.AnalysisStatus;
import com.deepdocai.data.entity.Session;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface SessionRepository extends JpaRepository<Session, UUID> {

    List<Session> findByUserIdOrderByUpdatedAtDesc(UUID userId);

    Optional<Session> findByIdAndUserId(UUID id, UUID userId);

    @Modifying
    @Transactional
    @Query("update Session s set s.analysisStatus = :status where s.id = :id")
    void setStatus(@Param("id") UUID id, @Param("status") AnalysisStatus status);

    @Modifying
    @Transactional
    @Query("update Session s set s.enrichedWindows = s.enrichedWindows + 1 where s.id = :id")
    void incrementEnrichedWindows(@Param("id") UUID id);

    @Modifying
    @Transactional
    @Query("update Session s set s.totalWindows = :total where s.id = :id")
    void setTotalWindows(@Param("id") UUID id, @Param("total") int total);

    @Modifying
    @Transactional
    @Query("update Session s set s.analysisStatus = com.deepdocai.common.constants.AnalysisStatus.FAILED, "
        + "s.errorMessage = :message where s.id = :id")
    void setFailed(@Param("id") UUID id, @Param("message") String message);

    /**
     * Atomically advance a fully-enriched session from ENRICHING to CORRELATING.
     * Exactly one concurrent caller wins (returns 1) and is responsible for
     * triggering correlation; the rest see 0 and stand down.
     */
    @Modifying
    @Transactional
    @Query("update Session s set s.analysisStatus = com.deepdocai.common.constants.AnalysisStatus.CORRELATING "
        + "where s.id = :id and s.analysisStatus = com.deepdocai.common.constants.AnalysisStatus.ENRICHING")
    int flipEnrichingToCorrelating(@Param("id") UUID id);
}
