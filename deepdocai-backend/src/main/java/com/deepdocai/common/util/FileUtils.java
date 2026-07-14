package com.deepdocai.common.util;

import com.deepdocai.common.constants.FileTypes;

public final class FileUtils {
    
    private FileUtils() {}
    
    public static String getFileExtension(String filename) {
        if (filename == null || filename.isEmpty()) {
            return "";
        }
        int lastDot = filename.lastIndexOf('.');
        if (lastDot == -1 || lastDot == filename.length() - 1) {
            return "";
        }
        return filename.substring(lastDot + 1).toLowerCase();
    }
    
    /**
     * Validates file based on extension and size.
     * This is a framework-agnostic version that accepts basic parameters.
     */
    public static boolean isValidFile(String filename, long fileSizeBytes) {
        if (filename == null || filename.isEmpty()) {
            return false;
        }
        
        String extension = getFileExtension(filename);
        if (!FileTypes.isSupported(extension)) {
            return false;
        }
        
        if (fileSizeBytes > FileTypes.MAX_FILE_SIZE_BYTES) {
            return false;
        }
        
        return true;
    }
    
    public static String sanitizeFileName(String filename) {
        if (filename == null) {
            return "unnamed";
        }
        return filename.replaceAll("[^a-zA-Z0-9._-]", "_");
    }
}

