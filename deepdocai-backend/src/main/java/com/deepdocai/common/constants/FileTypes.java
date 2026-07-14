package com.deepdocai.common.constants;

import java.util.Set;

public final class FileTypes {
    public static final Set<String> SUPPORTED_EXTENSIONS = Set.of(
        "ppt", "pptx", "pdf", "png", "jpg", "jpeg", "txt", "doc", "docx"
    );
    
    public static final Set<String> PRESENTATION_TYPES = Set.of("ppt", "pptx");
    public static final Set<String> PDF_TYPES = Set.of("pdf");
    public static final Set<String> IMAGE_TYPES = Set.of("png", "jpg", "jpeg", "gif", "bmp");
    public static final Set<String> TEXT_TYPES = Set.of("txt");
    
    public static final long MAX_FILE_SIZE_BYTES = 1024 * 1024 * 1024; // 1GB - ChatGPT/Claude-like capacity
    
    private FileTypes() {}
    
    public static boolean isSupported(String extension) {
        return SUPPORTED_EXTENSIONS.contains(extension.toLowerCase());
    }
    
    public static String getCategory(String extension) {
        String ext = extension.toLowerCase();
        if (PRESENTATION_TYPES.contains(ext)) return "PRESENTATION";
        if (PDF_TYPES.contains(ext)) return "PDF";
        if (IMAGE_TYPES.contains(ext)) return "IMAGE";
        if (TEXT_TYPES.contains(ext)) return "TEXT";
        return "UNKNOWN";
    }
}

