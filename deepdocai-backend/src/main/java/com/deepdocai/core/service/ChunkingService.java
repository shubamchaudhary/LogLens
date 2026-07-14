package com.deepdocai.core.service;

import com.deepdocai.common.util.TokenCounter;
import com.deepdocai.core.model.ChunkingResult;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

@Service
@Slf4j
public class ChunkingService {
    
    private static final int MAX_CHUNK_TOKENS = 512;
    private static final int OVERLAP_TOKENS = 50;
    
    /**
     * Chunk content by slides/pages (semantic boundaries)
     */
    public List<ChunkingResult> chunkByPages(List<String> pageContents, List<String> pageTitles) {
        List<ChunkingResult> chunks = new ArrayList<>();
        
        for (int i = 0; i < pageContents.size(); i++) {
            String content = pageContents.get(i);
            String title = i < pageTitles.size() ? pageTitles.get(i) : null;
            int pageNumber = i + 1;
            
            // Check if page content exceeds max tokens
            int tokenCount = TokenCounter.countTokens(content);
            
            if (tokenCount <= MAX_CHUNK_TOKENS) {
                // Single chunk for this page
                chunks.add(ChunkingResult.builder()
                    .content(content)
                    .pageNumber(pageNumber)
                    .sectionTitle(title)
                    .tokenCount(tokenCount)
                    .chunkIndex(chunks.size())
                    .build());
            } else {
                // Split page into multiple chunks
                List<ChunkingResult> pageChunks = splitLargeContent(content, pageNumber, title, chunks.size());
                chunks.addAll(pageChunks);
            }
        }
        
        log.info("Created {} chunks from {} pages", chunks.size(), pageContents.size());
        return chunks;
    }
    
    /**
     * Split large content into overlapping chunks
     */
    private List<ChunkingResult> splitLargeContent(String content, int pageNumber, String title, int startIndex) {
        List<ChunkingResult> chunks = new ArrayList<>();
        
        int maxChars = TokenCounter.maxCharsForTokens(MAX_CHUNK_TOKENS);
        int overlapChars = TokenCounter.maxCharsForTokens(OVERLAP_TOKENS);
        
        String[] sentences = content.split("(?<=[.!?])\\s+");
        StringBuilder currentChunk = new StringBuilder();
        int currentIndex = startIndex;
        
        for (String sentence : sentences) {
            if (currentChunk.length() + sentence.length() > maxChars && currentChunk.length() > 0) {
                // Save current chunk
                String chunkContent = currentChunk.toString().trim();
                chunks.add(ChunkingResult.builder()
                    .content(chunkContent)
                    .pageNumber(pageNumber)
                    .sectionTitle(title)
                    .tokenCount(TokenCounter.countTokens(chunkContent))
                    .chunkIndex(currentIndex++)
                    .build());
                
                // Start new chunk with overlap
                String overlap = getLastNChars(currentChunk.toString(), overlapChars);
                currentChunk = new StringBuilder(overlap);
            }
            currentChunk.append(sentence).append(" ");
        }
        
        // Save last chunk
        if (currentChunk.length() > 0) {
            String chunkContent = currentChunk.toString().trim();
            chunks.add(ChunkingResult.builder()
                .content(chunkContent)
                .pageNumber(pageNumber)
                .sectionTitle(title)
                .tokenCount(TokenCounter.countTokens(chunkContent))
                .chunkIndex(currentIndex)
                .build());
        }
        
        return chunks;
    }
    
    private String getLastNChars(String text, int n) {
        if (text.length() <= n) {
            return text;
        }
        return text.substring(text.length() - n);
    }
}

