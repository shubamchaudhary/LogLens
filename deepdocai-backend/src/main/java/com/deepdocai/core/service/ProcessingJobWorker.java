package com.deepdocai.core.service;

import com.deepdocai.data.entity.ProcessingJob;
import com.deepdocai.data.repository.DocumentRepository;
import com.deepdocai.data.repository.ProcessingJobRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.stream.Collectors;

/**
 * Background worker that processes queued document processing jobs in parallel batches
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class ProcessingJobWorker {
    
    private final ProcessingJobRepository jobRepository;
    private final DocumentRepository documentRepository;
    private final DocumentProcessingService documentProcessingService;
    
    private static final String WORKER_ID = "worker-" + UUID.randomUUID().toString().substring(0, 8);
    private static final int LOCK_DURATION_SECONDS = 300; // 5 minutes
    private static final int BATCH_SIZE = 5; // Process 5 jobs in parallel (balanced for speed vs rate limits)
    private static final ExecutorService executorService = Executors.newFixedThreadPool(BATCH_SIZE);
    
    @Scheduled(fixedDelay = 3000) // Run every 3 seconds
    @Transactional // Required for repository queries with @Lock
    public void processQueuedJobs() {
        try {
            List<ProcessingJob> queuedJobs = jobRepository.findNextQueuedJob(Instant.now());
            
            if (queuedJobs.isEmpty()) {
                return;
            }
            
            // Process up to BATCH_SIZE jobs in parallel
            List<ProcessingJob> jobsToProcess = queuedJobs.stream()
                .limit(BATCH_SIZE)
                .collect(Collectors.toList());
            
            log.info("Processing {} jobs in parallel (batch size: {})", jobsToProcess.size(), BATCH_SIZE);
            
            // Extract job IDs to avoid lazy loading issues
            List<UUID> jobIds = jobsToProcess.stream()
                .map(ProcessingJob::getId)
                .collect(Collectors.toList());
            
            // Process jobs in parallel without stagger (rate limiting handles API limits)
            List<CompletableFuture<Void>> futures = jobIds.stream()
                .map(jobId -> CompletableFuture.runAsync(() -> processJobById(jobId), executorService))
                .collect(Collectors.toList());
            
            // Wait for all to complete (but don't block the scheduler)
            CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]))
                .exceptionally(ex -> {
                    log.error("Error in batch processing", ex);
                    return null;
                });
            
        } catch (Exception e) {
            log.error("Error in processing job worker", e);
        }
    }
    
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    private void processJobById(UUID jobId) {
        // Load job within new transaction to avoid lazy loading issues
        ProcessingJob job = jobRepository.findById(jobId)
            .orElseThrow(() -> new RuntimeException("Job not found: " + jobId));
        processJob(job);
    }
    
    /**
     * Process job - split transaction boundaries to avoid connection leaks
     * API calls are outside transactions
     */
    private void processJob(ProcessingJob job) {
        UUID jobId = job.getId();
        UUID documentId = null;
        try {
            // Lock job in transaction
            documentId = lockJob(jobId);
            final UUID finalDocumentId = documentId;
            
            log.info("Processing job {} for document {}", jobId, finalDocumentId);
            
            // Process the document OUTSIDE transaction (contains long-running API calls)
            documentProcessingService.processDocument(finalDocumentId);
            
            // Mark job as completed in transaction
            markJobCompleted(jobId);
            
            log.info("Completed processing job {} for document {}", jobId, finalDocumentId);
            
        } catch (Exception e) {
            log.error("Error processing job {}: {}", jobId, e.getMessage(), e);
            // Always handle failure in a separate transaction to avoid rollback issues
            handleJobFailure(jobId, documentId, e);
        } finally {
            // Ensure we always release the lock, even if error handling fails
            try {
                releaseJobLockIfStale(jobId);
            } catch (Exception ex) {
                log.warn("Failed to release lock for job {} in finally block", jobId, ex);
            }
        }
    }
    
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    private UUID lockJob(UUID jobId) {
        ProcessingJob managedJob = jobRepository.findById(jobId)
            .orElseThrow(() -> new RuntimeException("Job not found: " + jobId));
        
        UUID documentId = managedJob.getDocument().getId();
        
        managedJob.setStatus("PROCESSING");
        managedJob.setLockedBy(WORKER_ID);
        managedJob.setLockedUntil(Instant.now().plusSeconds(LOCK_DURATION_SECONDS));
        managedJob.setStartedAt(Instant.now());
        managedJob.setAttempts(managedJob.getAttempts() + 1);
        // Use saveAndFlush to ensure job is immediately visible to other transactions (like error handler)
        // This prevents "Job not found" errors when handleJobFailure runs in a separate transaction
        jobRepository.saveAndFlush(managedJob);
        
        log.debug("Job {} locked and flushed to database (document {} will be updated in separate transaction)", jobId, documentId);
        return documentId;
    }
    
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    private void markJobCompleted(UUID jobId) {
        ProcessingJob completedJob = jobRepository.findById(jobId)
            .orElseThrow(() -> new RuntimeException("Job not found: " + jobId));
        
        completedJob.setStatus("COMPLETED");
        completedJob.setCompletedAt(Instant.now());
        completedJob.setLockedUntil(null);
        completedJob.setLockedBy(null);
        jobRepository.save(completedJob);
    }
    
    /**
     * Handle job failure in a completely separate transaction.
     * This ensures the failure status is saved even if the main transaction is rolled back.
     * Uses REQUIRES_NEW to create a fresh transaction, isolated from any rollback.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW, rollbackFor = Exception.class)
    private void handleJobFailure(UUID jobId, UUID documentId, Exception e) {
        try {
            log.info("Handling failure for job {} in separate transaction", jobId);
            
            // Reload job in new transaction context
            ProcessingJob failedJob = jobRepository.findById(jobId)
                .orElseThrow(() -> new RuntimeException("Job not found: " + jobId));
            
            String errorMessage = e.getMessage();
            if (errorMessage == null || errorMessage.isEmpty()) {
                errorMessage = e.getClass().getSimpleName() + ": " + (e.getCause() != null ? e.getCause().getMessage() : "Unknown error");
            }
            
            if (failedJob.getAttempts() >= failedJob.getMaxAttempts()) {
                // Final failure - mark as FAILED
                failedJob.setStatus("FAILED");
                failedJob.setLastError(errorMessage);
                failedJob.setCompletedAt(Instant.now());
                failedJob.setLockedUntil(null);
                failedJob.setLockedBy(null);
                jobRepository.save(failedJob);
                
                // Update document status using native SQL to avoid loading entity with chunks
                if (documentId != null) {
                    try {
                        String docErrorMessage = "Processing failed after " + failedJob.getAttempts() + " attempts: " + errorMessage;
                        int updated = documentRepository.setFailedStatus(documentId, docErrorMessage);
                        if (updated > 0) {
                            log.info("Marked document {} as FAILED due to job failure", documentId);
                        } else {
                            log.warn("Document {} not found when trying to mark as FAILED", documentId);
                        }
                    } catch (Exception docEx) {
                        log.error("Failed to update document {} status, but job {} marked as FAILED", documentId, jobId, docEx);
                        // Don't rethrow - job status is more important
                    }
                }
                
                log.warn("Job {} and document {} marked as FAILED (attempts: {}/{})", 
                    jobId, documentId, failedJob.getAttempts(), failedJob.getMaxAttempts());
            } else {
                // Retry - requeue the job
                failedJob.setStatus("QUEUED");
                failedJob.setLastError(errorMessage);
                failedJob.setLockedUntil(null);
                failedJob.setLockedBy(null);
                jobRepository.save(failedJob);
                
                log.info("Job {} requeued for retry (attempt {}/{})", 
                    jobId, failedJob.getAttempts(), failedJob.getMaxAttempts());
            }
        } catch (Exception ex) {
            // Even error handling failed - log but don't throw
            log.error("CRITICAL: Failed to update job {} status after failure. Job may appear stuck in PROCESSING.", 
                jobId, ex);
            // Try one more time with minimal operation
            try {
                ProcessingJob job = jobRepository.findById(jobId).orElse(null);
                if (job != null && "PROCESSING".equals(job.getStatus())) {
                    job.setStatus("QUEUED"); // Fallback to QUEUED so it can be retried
                    job.setLockedUntil(null);
                    job.setLockedBy(null);
                    jobRepository.save(job);
                    log.warn("Fallback: Reset job {} to QUEUED status", jobId);
                }
            } catch (Exception fallbackEx) {
                log.error("CRITICAL: Even fallback failed for job {}. Manual intervention required.", jobId, fallbackEx);
            }
        }
    }
    
    /**
     * Release stale job locks to prevent jobs from appearing stuck.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    private void releaseJobLockIfStale(UUID jobId) {
        try {
            ProcessingJob job = jobRepository.findById(jobId).orElse(null);
            if (job != null && "PROCESSING".equals(job.getStatus())) {
                if (job.getLockedUntil() != null && job.getLockedUntil().isBefore(Instant.now())) {
                    log.warn("Releasing stale lock for job {} (lock expired at {})", jobId, job.getLockedUntil());
                    job.setLockedUntil(null);
                    job.setLockedBy(null);
                    jobRepository.save(job);
                }
            }
        } catch (Exception e) {
            log.debug("Could not release lock for job {}: {}", jobId, e.getMessage());
        }
    }
}
