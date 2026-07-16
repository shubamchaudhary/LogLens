package com.loglens.api.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;

/**
 * Keep-Alive Service for Render.com Free Tier.
 *
 * <p>Render's free web services spin down after ~15 minutes with no <b>inbound</b>
 * HTTP traffic; the next request then pays a ~50s cold-start, which surfaces to
 * the user as a failed {@code /sessions} call and an empty UI. This service
 * periodically pings the public health endpoint to keep the instance warm.
 *
 * <p><b>Critical:</b> {@code keepalive.url} MUST be the service's <i>public</i>
 * URL (e.g. {@code https://loglens-api-5w5t.onrender.com/api/v1/health/ping}).
 * A {@code localhost} ping stays inside the container and does NOT reset
 * Render's inbound-traffic idle timer, so it would not prevent spin-down. The
 * localhost fallback below only makes sense for non-Render hosts.
 *
 * <p>Configuration:
 * <ul>
 *   <li>{@code keepalive.enabled} — enable/disable (default false; true in prod)</li>
 *   <li>{@code keepalive.url} — public URL to ping (default: localhost health ping)</li>
 *   <li>{@code keepalive.interval-ms} — ping interval (default 840000 = 14 min)</li>
 * </ul>
 *
 * Only instantiated when {@code keepalive.enabled=true}.
 */
@Service
@ConditionalOnProperty(name = "keepalive.enabled", havingValue = "true")
@Slf4j
public class KeepAliveService {

    private final HttpClient httpClient;
    private final String healthUrl;
    private final long intervalMs;

    private volatile Instant lastPingTime;
    private volatile int successCount = 0;
    private volatile int failureCount = 0;

    public KeepAliveService(
            @Value("${keepalive.url:}") String configuredUrl,
            @Value("${server.port:8080}") int serverPort,
            @Value("${keepalive.interval-ms:840000}") long intervalMs) {

        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();

        if (configuredUrl != null && !configuredUrl.isEmpty()) {
            this.healthUrl = configuredUrl;
        } else {
            this.healthUrl = "http://localhost:" + serverPort + "/api/v1/health/ping";
            log.warn("keepalive.url is not set — falling back to {}. On Render this "
                    + "will NOT prevent spin-down; set KEEPALIVE_URL to the public health "
                    + "ping URL.", this.healthUrl);
        }

        this.intervalMs = intervalMs;

        log.info("KeepAliveService initialized - URL: {}, Interval: {}ms ({}min)",
                healthUrl, intervalMs, intervalMs / 60000);
    }

    /**
     * Periodic health ping to prevent Render.com free-tier spin-down.
     * Runs every 14 minutes by default (configurable via keepalive.interval-ms),
     * after a 60s initial delay so it never fires before the app is ready.
     */
    @Scheduled(fixedDelayString = "${keepalive.interval-ms:840000}", initialDelay = 60000)
    public void pingHealth() {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(healthUrl))
                    .timeout(Duration.ofSeconds(30))
                    .GET()
                    .build();

            long startTime = System.currentTimeMillis();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            long responseTime = System.currentTimeMillis() - startTime;

            lastPingTime = Instant.now();

            if (response.statusCode() == 200) {
                successCount++;
                log.debug("Keep-alive ping successful - Status: {}, Response time: {}ms, Total success: {}",
                        response.statusCode(), responseTime, successCount);
            } else {
                failureCount++;
                log.warn("Keep-alive ping returned non-200 status: {} - Body: {}",
                        response.statusCode(), response.body());
            }
        } catch (Exception e) {
            failureCount++;
            log.error("Keep-alive ping failed: {} - Total failures: {}", e.getMessage(), failureCount);
        }
    }

    public KeepAliveStats getStats() {
        return new KeepAliveStats(healthUrl, intervalMs, lastPingTime, successCount, failureCount);
    }

    public record KeepAliveStats(
            String healthUrl,
            long intervalMs,
            Instant lastPingTime,
            int successCount,
            int failureCount
    ) {}
}
