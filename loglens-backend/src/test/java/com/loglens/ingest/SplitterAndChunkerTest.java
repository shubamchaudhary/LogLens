package com.loglens.ingest;

import com.loglens.common.messages.IngestPartRequest;
import com.loglens.common.messages.IngestRequest;
import com.loglens.data.entity.Document;
import com.loglens.data.repository.DocumentRepository;
import com.loglens.data.repository.SessionRepository;
import com.loglens.enrich.EnrichCompletion;
import com.loglens.enrich.RecordAwareSplitter;
import com.loglens.ingest.model.LogWindow;
import com.loglens.storage.FileStorageService;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class SplitterAndChunkerTest {

    /** 30 minutes of logs, 10 lines per second, with a stack trace every ~7 minutes. */
    private static byte[] sampleLog() {
        StringBuilder sb = new StringBuilder();
        for (int s = 0; s < 1800; s++) {
            for (int k = 0; k < 10; k++) {
                sb.append(String.format("2026-07-15 09:%02d:%02d.%03d INFO [svc] - request %d handled latency=%dms%n",
                    s / 60, s % 60, k * 100, s * 10 + k, 20 + k));
            }
            if (s % 400 == 399) {
                sb.append(String.format("2026-07-15 09:%02d:%02d.999 ERROR [svc] - java.lang.IllegalStateException: boom%n",
                    s / 60, s % 60));
                for (int f = 0; f < 5; f++) {
                    sb.append("\tat com.example.Service.call(Service.java:").append(f).append(")\n");
                }
            }
        }
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void splitterEmitsContiguousWindowAlignedPartsThatCoverTheFile() {
        byte[] file = sampleLog();
        FileStorageService storage = mock(FileStorageService.class);
        when(storage.openStream(anyString())).thenAnswer(i -> new ByteArrayInputStream(file));
        SessionRepository sessions = mock(SessionRepository.class);
        DocumentRepository documents = mock(DocumentRepository.class);
        UUID sid = UUID.randomUUID();
        UUID did = UUID.randomUUID();
        when(sessions.existsById(sid)).thenReturn(true);
        when(documents.findById(did)).thenReturn(Optional.of(Document.builder().id(did).build()));
        @SuppressWarnings("unchecked")
        KafkaTemplate<String, Object> kafka = mock(KafkaTemplate.class);
        IngestSplitter splitter = new IngestSplitter(sessions, documents, storage, new TimeWindowChunker(60),
            mock(EnrichCompletion.class), kafka);
        ReflectionTestUtils.setField(splitter, "partTargetBytes", 64 * 1024L);
        ReflectionTestUtils.setField(splitter, "fallbackLinesPerPart", 5000);

        splitter.onIngest(new IngestRequest(sid, UUID.randomUUID(), did, "s3://staging/x"), mock(Acknowledgment.class));

        ArgumentCaptor<Object> msgs = ArgumentCaptor.forClass(Object.class);
        verify(kafka, atLeastOnce()).send(eq("log.ingest.parts"), anyString(), msgs.capture());
        List<IngestPartRequest> parts = new ArrayList<>();
        for (Object o : msgs.getAllValues()) {
            parts.add((IngestPartRequest) o);
        }
        assertTrue(parts.size() > 5, "expected many parts, got " + parts.size());
        long expectedStart = 0;
        long expectedLine = 1;
        String text = new String(file, StandardCharsets.UTF_8);
        for (IngestPartRequest p : parts) {
            assertEquals(expectedStart, p.byteStart(), "parts must be contiguous");
            assertEquals(expectedLine, p.firstLineNumber(), "line numbers must be global");
            String slice = new String(file, (int) p.byteStart(), (int) (p.byteEndExclusive() - p.byteStart()),
                StandardCharsets.UTF_8);
            assertTrue(slice.startsWith("2026-07-15"), "a part must start on a record, not a stack frame");
            assertTrue(slice.endsWith("\n"));
            expectedStart = p.byteEndExclusive();
            expectedLine += slice.chars().filter(c -> c == '\n').count();
        }
        assertEquals(file.length, expectedStart, "parts must cover every byte");
        assertEquals(text.lines().count() + 1, expectedLine);
        verify(documents).setTotalPartsProcessing(did, parts.size());
    }

    @Test
    void chunkerForwardFillsContinuationLinesAndUsesGlobalFallbackBuckets() {
        TimeWindowChunker c = new TimeWindowChunker(60);
        List<LogWindow> w = c.chunk(List.of(
            "2026-07-15 09:00:10 ERROR x - boom", "\tat a.b(C.java:1)",
            "2026-07-15 09:01:00 INFO y - next"), 0);
        assertEquals(2, w.size());
        assertEquals(2, w.get(0).lines().size(), "the stack frame stays with its record");
        assertEquals(Instant.parse("2026-07-15T09:00:00Z"), w.get(0).timeBucket());

        List<String> untimed = new ArrayList<>();
        for (int i = 0; i < 700; i++) {
            untimed.add("no timestamp here " + i);
        }
        List<LogWindow> part2 = c.chunk(untimed, 5000);
        assertEquals(Instant.EPOCH.plusSeconds(10 * 60), part2.get(0).timeBucket(),
            "synthetic bucket comes from the GLOBAL line index so independent parts agree");
    }

    @Test
    void aVeryBusyMinuteBecomesSeveralChunksWithTheSameBucket() {
        List<String> lines = new ArrayList<>();
        for (int i = 0; i < 5000; i++) {
            lines.add("2026-07-15 09:00:" + String.format("%02d", i % 60) + " INFO gw - request " + i);
        }
        List<LogWindow> w = new TimeWindowChunker(60).chunk(lines, 0);
        assertEquals(3, w.size(), "5000 lines in one minute -> chunks of at most 2000 lines");
        assertTrue(w.stream().allMatch(x -> x.timeBucket().equals(Instant.parse("2026-07-15T09:00:00Z"))));
        assertEquals(5000, w.stream().mapToInt(x -> x.lines().size()).sum());
    }

    @Test
    void boundedLineReaderTruncatesHugeLinesAndStripsCr() throws Exception {
        String huge = "x".repeat(PartConsumer.MAX_LINE_CHARS + 10);
        java.io.BufferedReader r = new java.io.BufferedReader(new java.io.StringReader("a\r\n" + huge + "\nlast"));
        assertEquals("a", PartConsumer.readBoundedLine(r));
        String second = PartConsumer.readBoundedLine(r);
        assertTrue(second.endsWith("...[truncated 10 chars]"));
        assertEquals("last", PartConsumer.readBoundedLine(r));
        assertEquals(null, PartConsumer.readBoundedLine(r));
    }

    @Test
    void splitterRejectsGzipAndKeepsExactOffsetsPastAHugeLine() {
        FileStorageService storage = mock(FileStorageService.class);
        SessionRepository sessions = mock(SessionRepository.class);
        DocumentRepository documents = mock(DocumentRepository.class);
        UUID sid = UUID.randomUUID();
        UUID did = UUID.randomUUID();
        when(sessions.existsById(sid)).thenReturn(true);
        when(documents.findById(did)).thenReturn(Optional.of(Document.builder().id(did).build()));
        @SuppressWarnings("unchecked")
        KafkaTemplate<String, Object> kafka = mock(KafkaTemplate.class);
        IngestSplitter splitter = new IngestSplitter(sessions, documents, storage, new TimeWindowChunker(60),
            mock(EnrichCompletion.class), kafka);
        ReflectionTestUtils.setField(splitter, "partTargetBytes", 1024L * 1024);
        ReflectionTestUtils.setField(splitter, "fallbackLinesPerPart", 5000);

        when(storage.openStream(anyString())).thenAnswer(i -> new ByteArrayInputStream(new byte[]{0x1f, (byte) 0x8b, 8, 0}));
        splitter.onIngest(new IngestRequest(sid, UUID.randomUUID(), did, "s3://x"), mock(Acknowledgment.class));
        verify(documents).markFailed(eq(did), org.mockito.ArgumentMatchers.contains("not supported"));

        byte[] big = ("2026-07-15 09:00:00 INFO - " + "y".repeat(3 * 1024 * 1024) + "\n2026-07-15 09:01:00 INFO - after\n")
            .getBytes(StandardCharsets.UTF_8);
        when(storage.openStream(anyString())).thenAnswer(i -> new ByteArrayInputStream(big));
        UUID did2 = UUID.randomUUID();
        when(documents.findById(did2)).thenReturn(Optional.of(Document.builder().id(did2).build()));
        splitter.onIngest(new IngestRequest(sid, UUID.randomUUID(), did2, "s3://y"), mock(Acknowledgment.class));
        ArgumentCaptor<Object> msgs = ArgumentCaptor.forClass(Object.class);
        verify(kafka, atLeastOnce()).send(eq("log.ingest.parts"), anyString(), msgs.capture());
        IngestPartRequest last = (IngestPartRequest) msgs.getAllValues().get(msgs.getAllValues().size() - 1);
        assertEquals(big.length, last.byteEndExclusive(), "offsets stay exact even though the line was not buffered");
    }

    @Test
    void recordAwareSplitterKeepsAStackTraceInOneSegment() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 60; i++) {
            sb.append("2026-07-15 09:00:").append(String.format("%02d", i)).append(" INFO filler line number ").append(i).append('\n');
        }
        sb.append("2026-07-15 09:01:00 ERROR boom java.lang.IllegalStateException\n");
        for (int f = 0; f < 10; f++) {
            sb.append("\tat com.example.Frame").append(f).append(".call(Frame.java:1)\n");
        }
        List<String> segments = RecordAwareSplitter.split(sb.toString(), 1200);
        long withTrace = segments.stream().filter(s -> s.contains("IllegalStateException")).count();
        assertEquals(1, withTrace);
        String seg = segments.stream().filter(s -> s.contains("IllegalStateException")).findFirst().orElseThrow();
        assertTrue(seg.contains("Frame9"), "all frames travel with the exception line");
        assertTrue(segments.stream().allMatch(s -> s.length() <= 1200));
    }
}
