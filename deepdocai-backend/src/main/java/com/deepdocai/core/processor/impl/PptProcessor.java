package com.deepdocai.core.processor.impl;

import com.deepdocai.core.model.ExtractionResult;
import com.deepdocai.core.processor.DocumentProcessor;
import lombok.extern.slf4j.Slf4j;
import org.apache.poi.hslf.usermodel.HSLFSlide;
import org.apache.poi.hslf.usermodel.HSLFSlideShow;
import org.apache.poi.hslf.usermodel.HSLFTextParagraph;
import org.apache.poi.hslf.usermodel.HSLFTextRun;
import org.apache.poi.xslf.usermodel.XMLSlideShow;
import org.apache.poi.xslf.usermodel.XSLFShape;
import org.apache.poi.xslf.usermodel.XSLFSlide;
import org.apache.poi.xslf.usermodel.XSLFTextShape;
import org.springframework.stereotype.Component;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

@Component
@Slf4j
public class PptProcessor implements DocumentProcessor {
    
    @Override
    public boolean supports(String fileType) {
        return "ppt".equalsIgnoreCase(fileType) || "pptx".equalsIgnoreCase(fileType);
    }
    
    @Override
    public ExtractionResult extract(InputStream inputStream, String fileType) throws Exception {
        if ("pptx".equalsIgnoreCase(fileType)) {
            return extractFromPptx(inputStream);
        } else {
            return extractFromPpt(inputStream);
        }
    }
    
    private ExtractionResult extractFromPptx(InputStream inputStream) throws Exception {
        try (XMLSlideShow pptx = new XMLSlideShow(inputStream)) {
            List<String> slideContents = new ArrayList<>();
            List<String> slideTitles = new ArrayList<>();
            
            for (XSLFSlide slide : pptx.getSlides()) {
                StringBuilder slideText = new StringBuilder();
                String slideTitle = null;
                
                for (XSLFShape shape : slide.getShapes()) {
                    if (shape instanceof XSLFTextShape) {
                        XSLFTextShape textShape = (XSLFTextShape) shape;
                        String text = textShape.getText();
                        
                        if (text != null && !text.isBlank()) {
                            if (slideTitle == null && text.length() < 200) {
                                slideTitle = text.trim();
                            }
                            slideText.append(text).append("\n");
                        }
                    }
                }
                
                slideContents.add(slideText.toString().trim());
                slideTitles.add(slideTitle);
            }
            
            return ExtractionResult.builder()
                .pageContents(slideContents)
                .pageTitles(slideTitles)
                .totalPages(slideContents.size())
                .build();
        }
    }
    
    private ExtractionResult extractFromPpt(InputStream inputStream) throws Exception {
        try (HSLFSlideShow ppt = new HSLFSlideShow(inputStream)) {
            List<String> slideContents = new ArrayList<>();
            List<String> slideTitles = new ArrayList<>();
            
            for (HSLFSlide slide : ppt.getSlides()) {
                StringBuilder slideText = new StringBuilder();
                String slideTitle = null;
                
                for (List<HSLFTextParagraph> paragraphs : slide.getTextParagraphs()) {
                    for (HSLFTextParagraph paragraph : paragraphs) {
                        StringBuilder paraText = new StringBuilder();
                        for (HSLFTextRun run : paragraph.getTextRuns()) {
                            paraText.append(run.getRawText());
                        }
                        String text = paraText.toString();
                        
                        if (!text.isBlank()) {
                            if (slideTitle == null && text.length() < 200) {
                                slideTitle = text.trim();
                            }
                            slideText.append(text).append("\n");
                        }
                    }
                }
                
                slideContents.add(slideText.toString().trim());
                slideTitles.add(slideTitle);
            }
            
            return ExtractionResult.builder()
                .pageContents(slideContents)
                .pageTitles(slideTitles)
                .totalPages(slideContents.size())
                .build();
        }
    }
}

