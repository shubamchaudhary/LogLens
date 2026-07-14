package com.deepdocai.common.util;

/**
 * Simple token counter for chunking.
 * Approximation: 1 token ≈ 4 characters for English text
 */
public final class TokenCounter {
    private static final double CHARS_PER_TOKEN = 4.0;
    
    private TokenCounter() {}
    
    public static int countTokens(String text) {
        if (text == null || text.isEmpty()) {
            return 0;
        }
        return (int) Math.ceil(text.length() / CHARS_PER_TOKEN);
    }
    
    public static int maxCharsForTokens(int tokenLimit) {
        return (int) (tokenLimit * CHARS_PER_TOKEN);
    }
}

