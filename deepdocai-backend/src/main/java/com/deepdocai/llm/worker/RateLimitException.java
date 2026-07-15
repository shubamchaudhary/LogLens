package com.deepdocai.llm.worker;

/** Thrown when a Gemini API call returns HTTP 429 Too Many Requests. */
public class RateLimitException extends RuntimeException {
    public RateLimitException(String message) {
        super(message);
    }
    public RateLimitException(String message, Throwable cause) {
        super(message, cause);
    }
}
