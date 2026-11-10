"""The terminal client reads /api/stream: reply text only. A named event (the `filler` phrase the phone shows) is not part of the
reply, so it must never be glued onto the answer ("Thinking.Sorry, ...").

Run: pytest tests/test_cli_stream_events.py
"""

from __future__ import annotations

import httpx

from controller.cli.client import VedaClient


def _client(body: str) -> VedaClient:
    c = VedaClient(server_url="http://127.0.0.1:8000")
    c._http = httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, text=body)))
    return c


def test_a_filler_event_is_not_printed_as_part_of_the_reply():
    body = "event: filler\ndata: Thinking.\n\ndata: It is \n\ndata: sunny.\n\ndata: [DONE]\n\n"
    assert "".join(_client(body).stream_chat("weather")) == "It is sunny."


def test_several_fillers_and_a_hindi_one_are_all_dropped():
    body = "event: filler\ndata: One moment.\n\nevent: filler\ndata: Still on it.\n\nevent: filler\ndata: सोचने दीजिए।\n\ndata: Done.\n\ndata: [DONE]\n\n"
    assert list(_client(body).stream_chat("hi")) == ["Done."]


def test_plain_text_and_multiline_text_are_unchanged():
    body = "data: Line one\ndata: line two\n\ndata: [DONE]\n\n"
    assert list(_client(body).stream_chat("hi")) == ["Line one\nline two"]


def test_an_event_named_message_is_reply_text_and_another_unknown_name_is_ignored():
    body = "event: message\ndata: Hello.\n\nevent: progress\ndata: 40%\n\ndata: [DONE]\n\n"
    assert list(_client(body).stream_chat("hi")) == ["Hello."]


def test_a_reply_that_only_has_a_filler_ends_cleanly():
    body = "event: filler\ndata: One moment.\n\ndata: [DONE]\n\n"
    assert list(_client(body).stream_chat("hi")) == []
