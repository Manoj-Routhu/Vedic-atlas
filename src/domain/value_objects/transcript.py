"""Transcript — the result of a speech-to-text pass.

New — the donor's voice/stt.py returned a bare string. Wrapping it as a
value object lets the pipeline carry confidence and partial/final state
without every caller re-deriving them from ad-hoc tuples.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Transcript:
    """Immutable STT result for one utterance or partial segment."""

    text: str
    confidence: float
    language: str = "en"
    is_final: bool = True
    duration_sec: float = 0.0
    # Whisper's average log-probability of the words it kept (duration-weighted over segments): about -0.2 for clear
    # speech, below -1.0 for a mumble it could not make out. `confidence` above is only the LANGUAGE probability.
    # None when the backend does not report it.
    avg_logprob: float | None = None