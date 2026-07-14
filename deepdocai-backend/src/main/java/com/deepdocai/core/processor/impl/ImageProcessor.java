package com.deepdocai.core.processor.impl;

import com.deepdocai.core.model.ExtractionResult;
import com.deepdocai.core.processor.DocumentProcessor;
import lombok.extern.slf4j.Slf4j;
import net.sourceforge.tess4j.Tesseract;
import net.sourceforge.tess4j.TesseractException;
import org.springframework.stereotype.Component;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

@Component
@Slf4j
public class ImageProcessor implements DocumentProcessor {
    
    private final Tesseract tesseract;
    
    public ImageProcessor() {
        this.tesseract = new Tesseract();
        this.tesseract.setDatapath(System.getenv("TESSDATA_PREFIX"));
        this.tesseract.setLanguage("eng");
    }
    
    @Override
    public boolean supports(String fileType) {
        return "png".equalsIgnoreCase(fileType) || 
               "jpg".equalsIgnoreCase(fileType) || 
               "jpeg".equalsIgnoreCase(fileType);
    }
    
    @Override
    public ExtractionResult extract(InputStream inputStream, String fileType) throws Exception {
        try {
            BufferedImage image = ImageIO.read(inputStream);
            if (image == null) {
                throw new IllegalArgumentException("Could not read image file");
            }
            
            String text = null;
            try {
                text = tesseract.doOCR(image);
            } catch (Exception ocrError) {
                // OCR failed - log warning but continue with empty text
                log.warn("OCR processing failed for image (Tesseract error). Continuing with empty text. Error: {}", ocrError.getMessage());
                // Check if it's a missing language file error
                if (ocrError.getMessage() != null && 
                    (ocrError.getMessage().contains("traineddata") || 
                     ocrError.getMessage().contains("TESSDATA_PREFIX") ||
                     ocrError.getMessage().contains("Invalid memory access"))) {
                    log.warn("Tesseract language files not found or invalid. Please install Tesseract OCR and language data files.");
                }
                text = ""; // Use empty text instead of failing
            }
            
            List<String> pageContents = new ArrayList<>();
            List<String> pageTitles = new ArrayList<>();
            
            pageContents.add(text != null ? text.trim() : "");
            pageTitles.add("Image"); // Use non-null title
            
            return ExtractionResult.builder()
                .pageContents(pageContents)
                .pageTitles(pageTitles)
                .totalPages(1)
                .build();
        } catch (Exception e) {
            log.error("Image processing failed", e);
            // Return empty result instead of throwing - allows document to be saved
            List<String> pageContents = new ArrayList<>();
            List<String> pageTitles = new ArrayList<>();
            pageContents.add(""); // Empty content
            pageTitles.add("Image");
            return ExtractionResult.builder()
                .pageContents(pageContents)
                .pageTitles(pageTitles)
                .totalPages(1)
                .build();
        }
    }
}

