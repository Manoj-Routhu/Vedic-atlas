"""Speaker recognition and enrollment builders."""

from __future__ import annotations

from core.logging_config import logger
from schemas.config_schemas import AppConfig

from bootstrap.builders.audio import picovoice_access_key


def build_speaker_id(cfg: AppConfig):
    """Multi-speaker recognizer, backend selected by audio.speaker_id.backend;
    None (feature off) on any failure.

    'resemblyzer' (default) is local/no-key — see
    docs/voice/open-source-wake-speaker-design.md. 'eagle' is Picovoice,
    kept available, needs PICOVOICE_ACCESS_KEY, not installed/used by
    default. Zero enrolled profiles is not a failure — the recognizer
    still builds and simply scores no one until someone is enrolled via
    /api/speakers.
    """
    scfg = cfg.audio.speaker_id
    if not scfg.enabled:
        return None
    backend = (scfg.backend or "resemblyzer").lower()
    try:
        from core.constants import PROJECT_ROOT
        profiles_dir = PROJECT_ROOT / scfg.profiles_dir
        if backend == "resemblyzer":
            from tpa.speaker.resemblyzer_speaker_recognizer import ResemblyzerSpeakerRecognizer
            recognizer = ResemblyzerSpeakerRecognizer(
                profiles_dir=profiles_dir, score_window_sec=scfg.score_window_sec,
            )
        elif backend == "eagle":
            access_key = picovoice_access_key()
            if not access_key:
                logger.warning("[voice] speaker ID backend 'eagle' needs PICOVOICE_ACCESS_KEY; disabled")
                return None
            from tpa.speaker.eagle_speaker_recognizer import EagleSpeakerRecognizer
            recognizer = EagleSpeakerRecognizer(access_key=access_key, profiles_dir=profiles_dir)
        else:
            logger.warning(f"[voice] unknown speaker_id backend '{backend}'; disabled")
            return None
        logger.info(f"[voice] speaker ID active, backend={backend} ({len(recognizer.speaker_names)} enrolled)")
        return recognizer
    except Exception as e:
        logger.warning(f"[voice] speaker ID unavailable ({e}); disabled")
        return None


def build_speaker_enrollment_service(cfg: AppConfig, audio_capture):
    """Enrollment-side counterpart to build_speaker_id. None if speaker ID
    is disabled, misconfigured, or the mic adapter failed to build."""
    scfg = cfg.audio.speaker_id
    if not scfg.enabled or audio_capture is None:
        return None
    backend = (scfg.backend or "resemblyzer").lower()
    try:
        from core.constants import PROJECT_ROOT
        from service.speakers.speaker_enrollment_service import SpeakerEnrollmentService
        profiles_dir = PROJECT_ROOT / scfg.profiles_dir
        if backend == "resemblyzer":
            from tpa.speaker.resemblyzer_speaker_enroller import ResemblyzerSpeakerEnroller
            enroller = ResemblyzerSpeakerEnroller(
                profiles_dir=profiles_dir, min_enroll_seconds=scfg.min_enroll_seconds,
            )
        elif backend == "eagle":
            access_key = picovoice_access_key()
            if not access_key:
                return None
            from tpa.speaker.eagle_speaker_enroller import EagleSpeakerEnroller
            enroller = EagleSpeakerEnroller(access_key=access_key, profiles_dir=profiles_dir)
        else:
            return None
        return SpeakerEnrollmentService(enroller=enroller, audio=audio_capture)
    except Exception as e:
        logger.warning(f"[voice] speaker enrollment unavailable ({e}); disabled")
        return None
