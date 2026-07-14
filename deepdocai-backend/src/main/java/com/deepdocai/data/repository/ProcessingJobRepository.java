package com.deepdocai.data.repository;

import com.deepdocai.data.entity.ProcessingJob;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import jakarta.persistence.LockModeType;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface ProcessingJobRepository extends JpaRepository<ProcessingJob, UUID> {
    
    Optional<ProcessingJob> findByDocumentId(UUID documentId);
    
    List<ProcessingJob> findByStatus(String status);
    
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("""
        SELECT pj FROM ProcessingJob pj
        WHERE pj.status = 'QUEUED'
          AND (pj.lockedUntil IS NULL OR pj.lockedUntil < :now)
        ORDER BY pj.priority ASC, pj.createdAt ASC
        """)
    List<ProcessingJob> findNextQueuedJob(@Param("now") Instant now);
}

