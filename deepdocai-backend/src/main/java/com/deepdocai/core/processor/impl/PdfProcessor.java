package com.deepdocai.core.processor.impl;

import com.deepdocai.core.model.ExtractionResult;
import com.deepdocai.core.processor.DocumentProcessor;
import lombok.extern.slf4j.Slf4j;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.springframework.stereotype.Component;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

@Component
@Slf4j
public class PdfProcessor implements DocumentProcessor {
    
    @Override
    public boolean supports(String fileType) {
        return "pdf".equalsIgnoreCase(fileType);
    }
    
    @Override
    public ExtractionResult extract(InputStream inputStream, String fileType) throws Exception {
        try (PDDocument document = Loader.loadPDF(inputStream.readAllBytes())) {
            List<String> pageContents = new ArrayList<>();
            List<String> pageTitles = new ArrayList<>();
            
            PDFTextStripper stripper = new PDFTextStripper();
            int totalPages = document.getNumberOfPages();
            
            for (int page = 1; page <= totalPages; page++) {
                stripper.setStartPage(page);
                stripper.setEndPage(page);
                String pageText = stripper.getText(document);
                
                // Extract first line as potential title
                String title = null;
                if (pageText != null && !pageText.isBlank()) {
                    String[] lines = pageText.split("\n");
                    if (lines.length > 0 && lines[0].length() < 200) {
                        title = lines[0].trim();
                    }
                }
                
                pageContents.add(pageText != null ? pageText.trim() : "");
                pageTitles.add(title);
            }
            
            return ExtractionResult.builder()
                .pageContents(pageContents)
                .pageTitles(pageTitles)
                .totalPages(totalPages)
                .build();
        }
    }
}

