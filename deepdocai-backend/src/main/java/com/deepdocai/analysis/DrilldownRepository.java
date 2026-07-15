package com.deepdocai.analysis;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

import java.sql.Array;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Persistence for the per-session drill-down chat ({@code drilldown_messages}).
 * One row per question+answer turn, so a session's grounded Q&A history survives
 * logout, reload and device changes. Uses raw JDBC to match the other
 * analysis-side tables (native {@code UUID[]} columns, no JPA entity).
 */
@Repository
public class DrilldownRepository {

    private final JdbcTemplate jdbc;

    public DrilldownRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** One persisted drill-down turn, serialized straight to JSON. */
    public record MessageRow(
        UUID id, String question, String answer, List<UUID> citations, Instant createdAt) {
    }

    /** Append a turn. Citations are the chunk ids the answer cited (may be empty). */
    public UUID save(UUID sessionId, String question, String answer, List<UUID> citations) {
        UUID id = UUID.randomUUID();
        List<UUID> safe = citations == null ? List.of() : citations;
        jdbc.update(con -> {
            PreparedStatement ps = con.prepareStatement(
                "INSERT INTO drilldown_messages (id, session_id, question, answer, citations) "
                + "VALUES (?, ?, ?, ?, ?)");
            ps.setObject(1, id);
            ps.setObject(2, sessionId);
            ps.setString(3, question);
            ps.setString(4, answer);
            Array arr = con.createArrayOf("uuid", safe.stream().map(UUID::toString).toArray());
            ps.setArray(5, arr);
            return ps;
        });
        return id;
    }

    /** The session's full chat history, oldest first. */
    public List<MessageRow> history(UUID sessionId) {
        return jdbc.query(
            "SELECT id, question, answer, citations, created_at FROM drilldown_messages "
            + "WHERE session_id = ? ORDER BY created_at, id",
            MESSAGE_MAPPER, sessionId);
    }

    /** Wipe a session's chat history. */
    public int clear(UUID sessionId) {
        return jdbc.update("DELETE FROM drilldown_messages WHERE session_id = ?", sessionId);
    }

    private static final RowMapper<MessageRow> MESSAGE_MAPPER = (rs, i) -> new MessageRow(
        rs.getObject("id", UUID.class),
        rs.getString("question"),
        rs.getString("answer"),
        readUuidArray(rs, "citations"),
        readInstant(rs, "created_at"));

    private static Instant readInstant(ResultSet rs, String col) throws SQLException {
        OffsetDateTime odt = rs.getObject(col, OffsetDateTime.class);
        return odt == null ? null : odt.toInstant();
    }

    private static List<UUID> readUuidArray(ResultSet rs, String col) throws SQLException {
        Array a = rs.getArray(col);
        if (a == null) {
            return List.of();
        }
        Object raw = a.getArray();
        if (!(raw instanceof Object[] arr)) {
            return List.of();
        }
        List<UUID> out = new ArrayList<>(arr.length);
        for (Object o : arr) {
            if (o == null) {
                continue;
            }
            out.add(o instanceof UUID u ? u : UUID.fromString(o.toString()));
        }
        return out;
    }
}
