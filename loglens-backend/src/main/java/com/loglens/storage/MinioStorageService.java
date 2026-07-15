package com.loglens.storage;

import io.minio.BucketExistsArgs;
import io.minio.GetObjectArgs;
import io.minio.MakeBucketArgs;
import io.minio.MinioClient;
import io.minio.PutObjectArgs;
import io.minio.RemoveObjectArgs;
import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.InputStream;
import java.util.UUID;

/**
 * MinIO-backed {@link FileStorageService}. Objects are keyed
 * {@code {sessionId}/{documentId}} inside a single staging bucket that is
 * auto-created on startup. File URLs are {@code s3://{bucket}/{key}}.
 *
 * <p><b>NOTE for future readers/agents:</b> despite the class/client name,
 * this talks to any S3-compatible endpoint via the generic {@code io.minio}
 * Java SDK — it is not tied to the MinIO server product. Locally (docker-compose)
 * it points at a real MinIO container. In production (Render) it points at
 * Backblaze B2's S3-compatible API instead (MinIO has no free hosted/managed
 * offering, so B2 is used there — see {@code loglens.minio.*} / {@code MINIO_*}
 * env vars in application-production.properties). Do not assume "MinIO" in
 * logs/config/class names means the MinIO server is actually running in prod.
 */
@Service
@Slf4j
public class MinioStorageService implements FileStorageService {

    private final String endpoint;
    private final String accessKey;
    private final String secretKey;
    private final String bucket;

    private MinioClient client;

    public MinioStorageService(
        @Value("${loglens.minio.endpoint}") String endpoint,
        @Value("${loglens.minio.access-key}") String accessKey,
        @Value("${loglens.minio.secret-key}") String secretKey,
        @Value("${loglens.minio.bucket}") String bucket
    ) {
        this.endpoint = endpoint;
        this.accessKey = accessKey;
        this.secretKey = secretKey;
        this.bucket = bucket;
    }

    @PostConstruct
    void init() {
        this.client = MinioClient.builder()
            .endpoint(endpoint)
            .credentials(accessKey, secretKey)
            .build();
        try {
            boolean exists = client.bucketExists(BucketExistsArgs.builder().bucket(bucket).build());
            if (!exists) {
                client.makeBucket(MakeBucketArgs.builder().bucket(bucket).build());
                log.info("Created MinIO bucket '{}'", bucket);
            } else {
                log.info("MinIO bucket '{}' already present", bucket);
            }
        } catch (Exception e) {
            throw new IllegalStateException("Failed to initialise MinIO bucket '" + bucket + "'", e);
        }
    }

    @Override
    public String store(UUID sessionId, UUID documentId, InputStream data, long size, String contentType) {
        String objectKey = sessionId + "/" + documentId;
        try {
            client.putObject(PutObjectArgs.builder()
                .bucket(bucket)
                .object(objectKey)
                .stream(data, size, -1)
                .contentType(contentType != null && !contentType.isBlank()
                    ? contentType : "application/octet-stream")
                .build());
        } catch (Exception e) {
            throw new StorageException("Failed to store object " + objectKey, e);
        }
        return "s3://" + bucket + "/" + objectKey;
    }

    @Override
    public InputStream openStream(String fileUrl) {
        String objectKey = objectKeyFromUrl(fileUrl);
        try {
            return client.getObject(GetObjectArgs.builder()
                .bucket(bucket)
                .object(objectKey)
                .build());
        } catch (Exception e) {
            throw new StorageException("Failed to open object " + fileUrl, e);
        }
    }

    @Override
    public void delete(String fileUrl) {
        String objectKey = objectKeyFromUrl(fileUrl);
        try {
            client.removeObject(RemoveObjectArgs.builder()
                .bucket(bucket)
                .object(objectKey)
                .build());
        } catch (Exception e) {
            throw new StorageException("Failed to delete object " + fileUrl, e);
        }
    }

    private String objectKeyFromUrl(String fileUrl) {
        String prefix = "s3://" + bucket + "/";
        if (fileUrl == null || !fileUrl.startsWith(prefix)) {
            throw new IllegalArgumentException("Not a staging object URL: " + fileUrl);
        }
        return fileUrl.substring(prefix.length());
    }
}
