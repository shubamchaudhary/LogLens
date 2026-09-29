"""Structured-output contract for Graph 1 (a JSON array used to crash the session)."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("DATABASE_URL", "postgresql://unused")

from app import llm  # noqa: E402


def fake(replies):
    it = iter(replies)
    return lambda system, user: next(it)


def test_one_element_list_is_accepted(monkeypatch):
    monkeypatch.setattr(llm, "chat", fake(['[{"narrative": "n", "root_cause": "r"}]']))
    assert llm.chat_json_object("s", "u", ("narrative",))["narrative"] == "n"


def test_missing_key_triggers_one_repair(monkeypatch):
    monkeypatch.setattr(llm, "chat", fake(['{"story": "x"}', '{"grounded": false, "reason": "no"}']))
    assert llm.chat_json_object("s", "u", ("grounded",))["grounded"] is False


def test_two_bad_replies_raise(monkeypatch):
    monkeypatch.setattr(llm, "chat", fake(['not json at all', '[1, 2]']))
    with pytest.raises(llm.BadModelOutput):
        llm.chat_json_object("s", "u", ("narrative",))
