package com.loglens;

import com.loglens.common.messages.EnrichRequest;
import com.loglens.common.messages.IngestPartRequest;
import com.loglens.enrich.EnrichConsumer;
import com.loglens.enrich.OrchestratorClient;
import com.loglens.ingest.AnomalyDetector;
import com.loglens.ingest.PartConsumer;
import com.loglens.ingest.RobustAnomalyRules;
import com.loglens.ingest.TimeWindowChunker;
import com.loglens.ingest.model.LogWindow;
import com.loglens.ingest.parser.LogWindowParser;
import com.loglens.llm.client.LlmGateway;
import com.loglens.storage.FileStorageService;
import com.loglens.storage.SessionChunkTableManager;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.Acknowledgment;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import org.testcontainers.utility.MountableFile;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Proves "at-least-once delivery, exactly-once effect" against a real Postgres +
 * pgvector: every Kafka message is delivered TWICE (what a crash between the DB
 * commit and the offset commit, a rebalance, or a replay does) and the database
 * must end up identical to single delivery. Kafka itself is mocked out; the
 * black-box version with real Kafka and kill -9 is bench/chaos.py.
 */
@SpringBootTest(classes = com.loglens.api.LogLensApplication.class, properties = {
    "spring.kafka.listener.auto-startup=false",
    "spring.kafka.admin.auto-create=false",
    "groq.api-keys=test-key",
    "gemini.api-keys=test-key",
    "loglens.anomaly.mode=robust"
})
@Testcontainers
@Tag("integration")
class ExactlyOnceIT {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> pg = new PostgreSQLContainer<>(
        DockerImageName.parse("pgvector/pgvector:0.8.0-pg16").asCompatibleSubstituteFor("postgres"))
        .withCopyFileToContainer(MountableFile.forHostPath("../schema-v2.sql"),
            "/docker-entrypoint-initdb.d/schema.sql");

    @MockBean FileStorageService storage;
    @MockBean LlmGateway llm;
    @MockBean KafkaTemplate<String, Object> kafka;
    @MockBean OrchestratorClient orchestrator;

    @Autowired PartConsumer partConsumer;
    @Autowired EnrichConsumer enrichConsumer;
    @Autowired SessionChunkTableManager tables;
    @Autowired JdbcTemplate jdbc;
    @Autowired AnomalyDetector detector;
    @Autowired List<LogWindowParser> parsers;

    private final Acknowledgment ack = mock(Acknowledgment.class);
    private byte[] file;

    /** 3 hours of steady traffic with background errors, one error burst, one slow minute, one rare error. */
    private static byte[] corpus() {
        StringBuilder sb = new StringBuilder();
        for (int m = 0; m < 180; m++) {
            for (int s = 0; s < 60; s += 2) {
                String ts = String.format("2026-07-15 %02d:%02d:%02d", 9 + m / 60, m % 60, s);
                int lat = m == 100 ? 4000 + s : 40 + (s % 9);
                sb.append(ts).append(" INFO [api] - GET /api/orders status=200 latency=").append(lat).append("ms\n");
                if (s % 20 == 0) {
                    sb.append(ts).append(" ERROR [mail] - Failed to send email to u").append(m).append(": SMTP 421 (will retry)\n");
                }
                if (m == 60 && s < 40) {
                    sb.append(ts).append(" ERROR [db] - Query timeout: statement cancelled after 30000ms status=503\n");
                }
            }
            if (m == 150) {
                sb.append(String.format("2026-07-15 %02d:%02d:59", 9 + m / 60, m % 60))
                    .append(" ERROR [cert] - SSLHandshakeException: certificate expired for host partner\n");
            }
        }
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    @BeforeEach
    void setUp() {
        file = corpus();
        when(storage.openStream(anyString(), anyLong(), anyLong())).thenAnswer(i -> {
            long off = i.getArgument(1);
            long len = i.getArgument(2);
            return new ByteArrayInputStream(file, (int) off, (int) len);
        });
        when(llm.generate(anyString(), anyString(), any())).thenReturn(
            "[{\"category\":\"DATABASE\",\"severity\":\"ERROR\",\"title\":\"Query timeouts\","
                + "\"explanation\":\"Statements cancelled after 30000ms.\",\"confidence\":0.9}]");
        when(llm.embedBatch(anyList(), any())).thenAnswer(i -> {
            List<String> texts = i.getArgument(0);
            List<float[]> out = new ArrayList<>();
            for (int k = 0; k < texts.size(); k++) {
                float[] v = new float[768];
                v[k % 768] = 1f;
                out.add(v);
            }
            return out;
        });
        when(llm.toVectorString(any())).thenAnswer(i -> {
            float[] v = i.getArgument(0);
            StringBuilder sb = new StringBuilder("[");
            for (int k = 0; k < v.length; k++) {
                sb.append(k == 0 ? "" : ",").append(v[k]);
            }
            return sb.append(']').toString();
        });
    }

    /** Create user, session, per-session table and a PROCESSING document split into window-aligned parts. */
    private record Setup(UUID sid, UUID did, List<IngestPartRequest> parts) {
    }

    private Setup newSession() {
        UUID uid = UUID.randomUUID();
        UUID sid = UUID.randomUUID();
        UUID did = UUID.randomUUID();
        jdbc.update("INSERT INTO users (id, email, password_hash) VALUES (?, ?, 'x')", uid, uid + "@t.io");
        jdbc.update("INSERT INTO sessions (id, user_id, analysis_status) VALUES (?, ?, 'PARSING')", sid, uid);
        tables.createFor(sid);
        // cut into 3 parts at minute boundaries (what IngestSplitter does)
        String text = new String(file, StandardCharsets.UTF_8);
        List<IngestPartRequest> parts = new ArrayList<>();
        int[] cuts = {0, text.indexOf("2026-07-15 10:00:00"), text.indexOf("2026-07-15 11:00:00"), text.length()};
        long line = 1;
        for (int p = 0; p < 3; p++) {
            long start = text.substring(0, cuts[p]).getBytes(StandardCharsets.UTF_8).length;
            long end = text.substring(0, cuts[p + 1]).getBytes(StandardCharsets.UTF_8).length;
            parts.add(new IngestPartRequest(sid, uid, did, "s3://staging/t", p, 3, start, end, line));
            line += text.substring(cuts[p], cuts[p + 1]).chars().filter(c -> c == '\n').count();
        }
        jdbc.update("INSERT INTO documents (id, user_id, session_id, original_file_name, file_url, file_size_bytes, "
            + "processing_status, total_parts) VALUES (?, ?, ?, 'f.log', 's3://staging/t', ?, 'PROCESSING', 3)",
            did, uid, sid, file.length);
        return new Setup(sid, did, parts);
    }

    private Map<String, Object> state(UUID sid) {
        String t = tables.tableName(sid);
        Map<String, Object> m = new HashMap<>();
        m.put("chunks", jdbc.queryForObject("SELECT count(*) FROM " + t, Long.class));
        m.put("lineSpan", jdbc.queryForObject("SELECT sum(line_end - line_start + 1) FROM " + t, Long.class));
        m.put("dupStarts", jdbc.queryForObject(
            "SELECT count(*) FROM (SELECT line_start FROM " + t + " GROUP BY 1 HAVING count(*) > 1) d", Long.class));
        m.put("anomalous", jdbc.queryForObject("SELECT count(*) FROM " + t + " WHERE is_anomalous", Long.class));
        m.put("metricRows", jdbc.queryForObject("SELECT count(*) FROM log_metrics WHERE session_id = ?", Long.class, sid));
        m.put("metricSum", jdbc.queryForObject("SELECT sum(count) FROM log_metrics WHERE session_id = ?", Long.class, sid));
        m.put("totalWindows", jdbc.queryForObject("SELECT total_windows FROM sessions WHERE id = ?", Integer.class, sid));
        return m;
    }

    @Test
    void everyPartDeliveredTwiceLeavesTheSameDatabaseAsOnce() {
        Setup once = newSession();
        for (IngestPartRequest p : once.parts()) {
            partConsumer.onPart(p, ack);
        }
        Setup twice = newSession();
        List<IngestPartRequest> order = List.of(twice.parts().get(0), twice.parts().get(0), twice.parts().get(1),
            twice.parts().get(2), twice.parts().get(1), twice.parts().get(2));
        for (IngestPartRequest p : order) {
            partConsumer.onPart(p, ack);
        }
        Map<String, Object> a = state(once.sid());
        Map<String, Object> b = state(twice.sid());
        assertEquals(a, b, "redelivered parts must not change anything");
        assertEquals(0L, b.get("dupStarts"));
        assertEquals(file.length > 0 ? new String(file, StandardCharsets.UTF_8).lines().count() : 0L, b.get("lineSpan"));
        assertEquals("COMPLETED", jdbc.queryForObject(
            "SELECT processing_status FROM documents WHERE id = ?", String.class, twice.did()));
    }

    @Test
    void enrichItemDeliveredTwiceCallsTheLlmOnceAndCountsOnce() {
        Setup s = newSession();
        for (IngestPartRequest p : s.parts()) {
            partConsumer.onPart(p, ack);
        }
        UUID chunk = jdbc.queryForObject("SELECT chunk_id FROM " + tables.tableName(s.sid())
            + " WHERE is_anomalous ORDER BY line_start LIMIT 1", UUID.class);
        List<UUID> all = jdbc.queryForList("SELECT chunk_id FROM " + tables.tableName(s.sid()), UUID.class);
        jdbc.update("UPDATE sessions SET analysis_status = 'ENRICHING', total_windows = 2, enriched_windows = 0 WHERE id = ?",
            s.sid());
        clearInvocations(llm);
        EnrichRequest window = new EnrichRequest(UUID.randomUUID(), s.sid(), EnrichRequest.ENRICH_WINDOW, List.of(chunk), 0, 0L);
        EnrichRequest embed = new EnrichRequest(UUID.randomUUID(), s.sid(), EnrichRequest.EMBED_BATCH, all.subList(0, 5), 0, 0L);

        enrichConsumer.onEnrich(window, 0, ack);
        long occurrences = jdbc.queryForObject(
            "SELECT coalesce(sum(occurrence_count), 0) FROM log_findings WHERE session_id = ?", Long.class, s.sid());
        enrichConsumer.onEnrich(window, 0, ack);   // redelivery
        enrichConsumer.onEnrich(embed, 0, ack);
        enrichConsumer.onEnrich(embed, 0, ack);    // redelivery

        verify(llm, times(1)).generate(anyString(), anyString(), any());
        verify(llm, times(1)).embedBatch(anyList(), any());
        assertEquals(occurrences, jdbc.queryForObject(
            "SELECT coalesce(sum(occurrence_count), 0) FROM log_findings WHERE session_id = ?", Long.class, s.sid()));
        assertEquals(2, jdbc.queryForObject("SELECT enriched_windows FROM sessions WHERE id = ?", Integer.class, s.sid()));
        assertEquals(5, jdbc.queryForObject("SELECT count(*) FROM " + tables.tableName(s.sid())
            + " WHERE embedding IS NOT NULL", Integer.class));
        assertEquals("CORRELATING", jdbc.queryForObject(
            "SELECT analysis_status FROM sessions WHERE id = ?", String.class, s.sid()));
        verify(orchestrator, times(1)).analyze(eq(s.sid()));
    }

    @Test
    void productionSqlRulesAgreeWithTheJavaReferenceUsedByTheEvals() {
        Setup s = newSession();
        for (IngestPartRequest p : s.parts()) {
            partConsumer.onPart(p, ack);   // last part triggers the finalizer -> flagRobustOutliers (SQL)
        }
        Set<Instant> sqlFlagged = new HashSet<>(jdbc.query("SELECT DISTINCT time_bucket FROM "
            + tables.tableName(s.sid()) + " WHERE is_anomalous", (rs, i) -> rs.getTimestamp(1).toInstant()));

        // Java reference over the SAME rows the SQL saw
        List<Instant> buckets = new ArrayList<>(new LinkedHashSet<>(jdbc.query("SELECT time_bucket FROM "
            + tables.tableName(s.sid()) + " ORDER BY 1", (rs, i) -> rs.getTimestamp(1).toInstant())));
        Map<Instant, Map<String, RobustAnomalyRules.Agg>> metrics = new HashMap<>();
        jdbc.query("SELECT time_bucket, category, metric, count, p95_ms FROM log_metrics WHERE session_id = ?", rs -> {
            java.math.BigDecimal p95 = rs.getBigDecimal("p95_ms");
            metrics.computeIfAbsent(rs.getTimestamp(1).toInstant(), k -> new HashMap<>())
                .put(rs.getString(2) + "|" + rs.getString(3),
                    new RobustAnomalyRules.Agg(rs.getLong(4), p95 == null ? null : p95.doubleValue()));
        }, s.sid());
        Set<Instant> javaFlagged = new HashSet<>(RobustAnomalyRules.flaggedBuckets(buckets, metrics));
        TimeWindowChunker chunker = new TimeWindowChunker(60);
        List<LogWindow> windows = chunker.chunk(new String(file, StandardCharsets.UTF_8).lines().toList(), 0);
        for (LogWindow w : windows) {
            for (LogWindowParser p : parsers) {
                if (p.isHardAnomaly(w)) {
                    javaFlagged.add(w.timeBucket());
                }
            }
        }
        assertEquals(javaFlagged, sqlFlagged);
        assertTrue(sqlFlagged.contains(Instant.parse("2026-07-15T10:00:00Z")), "error burst minute");
        assertTrue(sqlFlagged.contains(Instant.parse("2026-07-15T10:40:00Z")), "slow minute");
        assertTrue(sqlFlagged.contains(Instant.parse("2026-07-15T11:30:00Z")), "rare SSL error minute");
        assertTrue(sqlFlagged.size() < 10, "steady background errors must not flag: " + sqlFlagged.size());
    }
}
