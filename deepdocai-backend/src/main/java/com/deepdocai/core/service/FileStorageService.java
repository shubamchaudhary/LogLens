package com.deepdocai.core.service;

import org.springframework.web.multipart.MultipartFile;

import java.io.InputStream;
import java.util.UUID;

/**
 * Service for storing and retrieving uploaded files.
 * Supports local filesystem storage (can be extended to S3, etc.)
 */
public interface FileStorageService {
    
    /**
     * Save a file and return its storage identifier
     */
    UUID saveFile(MultipartFile file, UUID documentId) throws Exception;
    
    /**
     * Retrieve file input stream by document ID
     */
    InputStream getFile(UUID documentId) throws Exception;
    
    /**
     * Delete file by document ID
     */
    void deleteFile(UUID documentId) throws Exception;
    
    /**
     * Check if file exists
     */
    boolean fileExists(UUID documentId);
}

