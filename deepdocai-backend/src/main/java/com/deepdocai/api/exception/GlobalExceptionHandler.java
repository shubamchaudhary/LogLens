package com.deepdocai.api.exception;

import com.deepdocai.api.dto.response.ErrorResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.multipart.support.MissingServletRequestPartException;

import java.time.Instant;

@RestControllerAdvice
@Slf4j
public class GlobalExceptionHandler {
    
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorResponse> handleValidationExceptions(
            MethodArgumentNotValidException ex,
            WebRequest request
    ) {
        StringBuilder errors = new StringBuilder();
        ex.getBindingResult().getAllErrors().forEach((error) -> {
            String fieldName = ((FieldError) error).getField();
            String errorMessage = error.getDefaultMessage();
            errors.append(fieldName).append(": ").append(errorMessage).append("; ");
        });
        
        ErrorResponse errorResponse = ErrorResponse.builder()
            .message("Validation failed")
            .error(errors.toString())
            .timestamp(Instant.now())
            .path(request.getDescription(false).replace("uri=", ""))
            .build();
        
        return ResponseEntity.badRequest().body(errorResponse);
    }
    
    @ExceptionHandler(MissingServletRequestPartException.class)
    public ResponseEntity<ErrorResponse> handleMissingPartException(
            MissingServletRequestPartException ex,
            WebRequest request
    ) {
        log.error("Missing request part: {}", ex.getRequestPartName());
        log.error("Request Content-Type: {}", request.getHeader("Content-Type"));
        
        String helpfulMessage = String.format(
            "Required part '%s' is not present. " +
            "Please ensure you're using 'form-data' body type in Postman with key name '%s' and type 'File'. " +
            "Content-Type should be 'multipart/form-data'.",
            ex.getRequestPartName(),
            ex.getRequestPartName()
        );
        
        ErrorResponse errorResponse = ErrorResponse.builder()
            .message("File upload error")
            .error(helpfulMessage)
            .timestamp(Instant.now())
            .path(request.getDescription(false).replace("uri=", ""))
            .build();
        
        return ResponseEntity.badRequest().body(errorResponse);
    }
    
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleGenericException(
            Exception ex,
            WebRequest request
    ) {
        log.error("Unexpected error", ex);
        
        ErrorResponse errorResponse = ErrorResponse.builder()
            .message("An unexpected error occurred")
            .error(ex.getMessage())
            .timestamp(Instant.now())
            .path(request.getDescription(false).replace("uri=", ""))
            .build();
        
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(errorResponse);
    }
}

