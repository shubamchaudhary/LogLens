package com.deepdocai.core.processor;

import com.deepdocai.core.model.ExtractionResult;

import java.io.InputStream;

public interface DocumentProcessor {
    boolean supports(String fileType);
    ExtractionResult extract(InputStream inputStream, String fileType) throws Exception;
}

