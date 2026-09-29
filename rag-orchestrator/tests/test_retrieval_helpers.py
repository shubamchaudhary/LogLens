"""Unit tests for the retrieval helpers that the retrieval eval exposed as bugs."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("DATABASE_URL", "postgresql://unused")

from app import db, prompts  # noqa: E402


def test_lexical_terms_drop_question_words():
    # these words made the old AND query match nothing
    assert db.lexical_terms("Which upstream provider throttled payment requests?") == [
        "upstream", "provider", "throttled", "payment", "requests"]


def test_lexical_terms_keep_log_tokens():
    assert "sqltimeoutexception" in db.lexical_terms("When was the first SQLTimeoutException?")
    assert "503" in db.lexical_terms("Why did POST /api/checkout return 503?")


def test_rrf_prefers_items_ranked_by_both_lists():
    a = [{"chunk_id": "x"}, {"chunk_id": "y"}, {"chunk_id": "z"}]
    b = [{"chunk_id": "z"}, {"chunk_id": "y"}]
    fused = db._rrf_fuse([a, b], 3)
    assert fused[0]["chunk_id"] == "y" or fused[0]["chunk_id"] == "z"
    assert {r["chunk_id"] for r in fused} == {"x", "y", "z"}


def test_focus_snippet_spends_budget_on_matching_lines():
    lines = [f"2026-07-15 09:00:{i:02d} INFO filler request {i}" for i in range(50)]
    lines.insert(40, "2026-07-15 09:00:40 WARN payment provider throttled request status=429 provider=stripe")
    content = "\n".join(lines)
    snip = prompts.focus_snippet(content, "Which provider throttled payments?", 300)
    assert "provider=stripe" in snip  # the old content[:300] slice never reached line 40
    assert len(snip) <= 300
