package com.deepdocai.llm.model;

import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

import java.util.List;

@Data
public class GenerationResponse {
    @JsonProperty("candidates")
    private List<Candidate> candidates;
    
    @Data
    public static class Candidate {
        @JsonProperty("content")
        private Content content;
        
        @JsonProperty("finishReason")
        private String finishReason;
        
        @JsonProperty("finishMessage")
        private String finishMessage;
    }
    
    @Data
    public static class Content {
        @JsonProperty("parts")
        private List<Part> parts;
    }
    
    @Data
    public static class Part {
        @JsonProperty("text")
        private String text;
    }
}

