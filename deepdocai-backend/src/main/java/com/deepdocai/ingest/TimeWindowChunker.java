package com.deepdocai.ingest;

import com.deepdocai.ingest.model.LogWindow;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.temporal.ChronoField;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Groups log lines into fixed-width time windows ({@code chunkai.window-seconds},
 * default 60s) — logs are temporal, so time windows align findings with the
 * metric buckets they explain.
 *
 * <p>Timestamp extraction tries a small ordered set of formats (ISO-8601,
 * {@code yyyy-MM-dd HH:mm:ss}, syslog). A line without a recognisable timestamp
 * inherits the current window's bucket. If the whole file has no timestamps at
 * all, it falls back to fixed 500-line windows with synthetic, monotonically
 * increasing buckets derived from file order.
 */
@Component
public class TimeWindowChunker {

    private static final int FALLBACK_WINDOW_LINES = 500;

    private final long windowSeconds;

    /** Ordered timestamp patterns; group(1) is the timestamp text passed to {@link #parse}. */
    private static final Pattern ISO = Pattern.compile(
        "(\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d{1,9})?(?:Z|[+-]\\d{2}:?\\d{2})?)");
    private static final Pattern SYSLOG = Pattern.compile(
        "^([A-Z][a-z]{2}\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2})");

    private static final DateTimeFormatter SYSLOG_FMT = new DateTimeFormatterBuilder()
        .appendPattern("MMM")
        .appendLiteral(' ')
        .padNext(2)
        .appendValue(ChronoField.DAY_OF_MONTH)
        .appendLiteral(' ')
        .appendPattern("HH:mm:ss")
        .parseDefaulting(ChronoField.YEAR, LocalDate.now(ZoneOffset.UTC).getYear())
        .toFormatter();

    public TimeWindowChunker(@Value("${chunkai.window-seconds:60}") long windowSeconds) {
        this.windowSeconds = windowSeconds;
    }

    /**
     * Split the given lines (already read in file order) into windows. The caller
     * streams the file line-by-line into this list; the whole file is never held
     * as a single blob.
     */
    public List<LogWindow> chunk(List<String> rawLines) {
        int n = rawLines.size();
        if (n == 0) {
            return List.of();
        }

        Instant[] ts = new Instant[n];
        boolean any = false;
        for (int i = 0; i < n; i++) {
            ts[i] = extractTimestamp(rawLines.get(i));
            any |= ts[i] != null;
        }
        if (!any) {
            return fallbackByLineCount(rawLines);
        }

        // Forward-fill: a line with no timestamp joins the current window; leading
        // timestamp-less lines adopt the first real timestamp.
        Instant firstTs = null;
        for (Instant t : ts) {
            if (t != null) {
                firstTs = t;
                break;
            }
        }
        Instant carry = firstTs;
        Instant[] effective = new Instant[n];
        for (int i = 0; i < n; i++) {
            if (ts[i] != null) {
                carry = ts[i];
            }
            effective[i] = carry;
        }

        List<LogWindow> windows = new ArrayList<>();
        int windowStart = 0;
        Instant currentBucket = bucketOf(effective[0]);
        for (int i = 1; i < n; i++) {
            Instant bucket = bucketOf(effective[i]);
            if (!bucket.equals(currentBucket)) {
                windows.add(new LogWindow(currentBucket, windowStart + 1, i,
                    new ArrayList<>(rawLines.subList(windowStart, i))));
                windowStart = i;
                currentBucket = bucket;
            }
        }
        windows.add(new LogWindow(currentBucket, windowStart + 1, n,
            new ArrayList<>(rawLines.subList(windowStart, n))));
        return windows;
    }

    private List<LogWindow> fallbackByLineCount(List<String> rawLines) {
        List<LogWindow> windows = new ArrayList<>();
        int n = rawLines.size();
        int windowIndex = 0;
        for (int start = 0; start < n; start += FALLBACK_WINDOW_LINES) {
            int end = Math.min(start + FALLBACK_WINDOW_LINES, n);
            Instant synthetic = Instant.EPOCH.plusSeconds((long) windowIndex * windowSeconds);
            windows.add(new LogWindow(synthetic, start + 1, end,
                new ArrayList<>(rawLines.subList(start, end))));
            windowIndex++;
        }
        return windows;
    }

    private Instant bucketOf(Instant t) {
        long epoch = t.getEpochSecond();
        long floored = epoch - Math.floorMod(epoch, windowSeconds);
        return Instant.ofEpochSecond(floored);
    }

    /** Extract the first recognisable timestamp from a line, or {@code null}. */
    Instant extractTimestamp(String line) {
        Matcher iso = ISO.matcher(line);
        if (iso.find()) {
            Instant parsed = parseIso(iso.group(1));
            if (parsed != null) {
                return parsed;
            }
        }
        Matcher sys = SYSLOG.matcher(line);
        if (sys.find()) {
            try {
                LocalDateTime ldt = LocalDateTime.parse(sys.group(1), SYSLOG_FMT);
                return ldt.toInstant(ZoneOffset.UTC);
            } catch (Exception ignored) {
                // fall through
            }
        }
        return null;
    }

    private Instant parseIso(String text) {
        String normalised = text.replace(',', '.').replace(' ', 'T');
        try {
            // Zoned/offset form (e.g. ...Z or +05:30).
            return OffsetDateTime.parse(normalised).toInstant();
        } catch (Exception ignored) {
            // no offset — assume UTC
        }
        try {
            return LocalDateTime.parse(normalised).toInstant(ZoneOffset.UTC);
        } catch (Exception ignored) {
            return null;
        }
    }
}
