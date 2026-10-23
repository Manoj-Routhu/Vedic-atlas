"""Always-on voice loop builder."""

from __future__ import annotations

import asyncio

from core.logging_config import logger
from domain.events.ambient_event import AmbientEvent
from domain.events.event_kind import EventKind
from domain.value_objects.urgency import Urgency
from schemas.config_schemas import AppConfig

from bootstrap.builders.audio import build_speaker, build_stt, build_vad, build_wake_word
from bootstrap.builders.tts import build_tts


def build_voice_session(cfg: AppConfig, *, audio, capture_gate, supervisor, event_bus, speaker_id=None):
    """Assemble the always-on voice loop. None if any required piece is missing."""
    if not cfg.audio.voice_enabled:
        logger.info("[voice] disabled by config")
        return None

    vad, stt, tts, speaker = build_vad(cfg), build_stt(cfg), build_tts(cfg), build_speaker(cfg)
    missing = [n for n, v in (("mic", audio), ("vad", vad), ("stt", stt), ("tts", tts), ("speaker", speaker)) if v is None]
    if missing:
        logger.warning(f"[voice] not started - missing: {', '.join(missing)}")
        return None

    wake = build_wake_word(cfg)
    if wake is None and cfg.audio.wake_word_enabled and (cfg.audio.wake_engine or "none").lower() != "none":
        # Fail closed. A wake word was configured, so "always listening" must never be the fallback.
        logger.error(
            f"[voice] wake engine '{cfg.audio.wake_engine}' is configured but could not be started - "
            "voice listening is DISABLED rather than falling back to listening continuously "
            "(set audio.wake_engine: none to opt in to always-on listening)"
        )
        return None

    from service.voice.utterance_collector import UtteranceCollector
    from service.voice.voice_session import VoiceSession

    v = cfg.audio.vad
    collector = UtteranceCollector(
        vad=vad,
        start_frames=v.start_frames,
        silence_ms=v.silence_ms,
        max_duration_sec=v.max_utterance_sec,
        pre_roll_frames=v.pre_roll_frames,
    )

    def _publish(event: dict) -> None:
        """Surface voice activity on the ambient bus so the UI/CLI can follow it."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        ambient = AmbientEvent(
            kind=EventKind.OBSERVATION,
            description=event.get("text", event["kind"]),
            urgency=Urgency.LOW,
            source="voice",
            dedupe_key=f"voice:{event['kind']}",
            payload=event,
        )
        asyncio.ensure_future(event_bus.publish(ambient), loop=loop)

    return VoiceSession(
        audio=audio, collector=collector, stt=stt, tts=tts, speaker=speaker,
        supervisor=supervisor, capture_gate=capture_gate,
        min_chars=cfg.audio.min_transcript_chars,
        speak_replies=cfg.audio.speak_replies,
        speak_timeout_sec=cfg.audio.speak_timeout_sec,
        post_speak_settle_sec=cfg.audio.post_speak_settle_sec,
        echo_guard=cfg.audio.echo_guard,
        wake_word=wake,
        wake_engine=cfg.audio.wake_engine,
        wake_window_sec=cfg.audio.wake_window_sec,
        speaker_id=speaker_id,
        require_known_speaker=cfg.audio.speaker_id.require_known_speaker,
        speaker_match_threshold=cfg.audio.speaker_id.match_threshold,
        on_event=_publish,
    )
