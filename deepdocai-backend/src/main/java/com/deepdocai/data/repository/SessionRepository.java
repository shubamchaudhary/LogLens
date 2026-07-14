package com.deepdocai.data.repository;

import com.deepdocai.common.constants.AnalysisStatus;
import com.deepdocai.data.entity.Session;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface SessionRepository extends JpaRepository<Session, UUID> {

    List<Session> findByUserIdOrderByUpdatedAtDesc(UUID userId);

    Optional<Session> findByIdAndUserId(UUID id, UUID userId);

    @Modifying
    @Query("update Session s set s.analysisStatus = :status where s.id = :id")
    void setStatus(@Param("id") UUID id, @Param("status") AnalysisStatus status);

    @Modifying
    @Query("update Session s set s.enrichedWindows = s.enrichedWindows + 1 where s.id = :id")
    void incrementEnrichedWindows(@Param("id") UUID id);

    @Modifying
    @Query("update Session s set s.totalWindows = :total where s.id = :id")
    void setTotalWindows(@Param("id") UUID id, @Param("total") int total);
}
