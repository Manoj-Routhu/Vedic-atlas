"""SSE text encoding — safe multi-line `data:` framing for Server-Sent Events.

Donor: veda/routes/stream.py's module-level `_sse_encode`, read in full and
lifted out unchanged so both stream.py and any other SSE route (ambient.py's
narration payloads are single-line JSON and don't need this, but future
routes streaming free text will) share one implementation.
"""


def sse_encode(payload: str, event: str | None = None) -> str:
    """Encode a chunk as a single SSE event, splitting embedded newlines
    into the multi-line `data:` form so the client can reassemble the
    original text without losing paragraph breaks. Trailing CRs are stripped.

    Without this, ``f"data: {chunk}\\n\\n"`` for a chunk containing a
    literal newline produces malformed SSE (the embedded ``\\n`` ends the
    `data:` field early), and the client either drops the lines after the
    first newline or concatenates paragraphs with no separator.

    `event` names the event (an `event:` line before the data). Chunks of reply text have no name; the phone app
    treats an unnamed event as reply text and ignores a name it does not know.
    """
    body = payload.replace("\r\n", "\n").replace("\r", "\n")
    lines = body.split("\n") if body else [""]
    head = f"event: {event.replace(chr(10), ' ').replace(chr(13), ' ')}\n" if event else ""
    return head + "".join(f"data: {line}\n" for line in lines) + "\n"
