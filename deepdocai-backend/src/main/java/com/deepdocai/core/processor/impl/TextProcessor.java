package com.deepdocai.core.processor.impl;

import com.deepdocai.core.model.ExtractionResult;
import com.deepdocai.core.processor.DocumentProcessor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.InputStream;
import java.util.List;
import java.util.Scanner;

@Component
@Slf4j
public class TextProcessor implements DocumentProcessor {
    
    @Override
    public boolean supports(String fileType) {
        return "txt".equalsIgnoreCase(fileType);
    }
    
    @Override
    public ExtractionResult extract(InputStream inputStream, String fileType) throws Exception {
        try (Scanner scanner = new Scanner(inputStream)) {
            StringBuilder content = new StringBuilder();
            String title = null;
            
            boolean firstLine = true;
            while (scanner.hasNextLine()) {
                String line = scanner.nextLine();
                if (firstLine && line.length() < 200) {
                    title = line.trim();
                    firstLine = false;
                }
                content.append(line).append("\n");
            }
            
            String finalTitle = title != null ? title : "Untitled";
            return ExtractionResult.builder()
                .pageContents(List.of(content.toString().trim()))
                .pageTitles(List.of(finalTitle))
                .totalPages(1)
                .build();
        }
    }
}

