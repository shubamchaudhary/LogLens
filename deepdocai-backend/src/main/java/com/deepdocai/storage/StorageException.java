package com.deepdocai.storage;

/** Raised when a MinIO/object-storage operation fails. */
public class StorageException extends RuntimeException {

    public StorageException(String message, Throwable cause) {
        super(message, cause);
    }
}
