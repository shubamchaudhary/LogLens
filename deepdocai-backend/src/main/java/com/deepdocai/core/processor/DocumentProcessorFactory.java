package com.deepdocai.core.processor;

import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;

@Component
@RequiredArgsConstructor
public class DocumentProcessorFactory {
    
    private final List<DocumentProcessor> processors;
    
    public DocumentProcessor getProcessor(String fileType) {
        return processors.stream()
            .filter(p -> p.supports(fileType))
            .findFirst()
            .orElseThrow(() -> new IllegalArgumentException("Unsupported file type: " + fileType));
    }
}

