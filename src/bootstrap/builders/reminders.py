"""Spoken reminders builder."""

from __future__ import annotations

from core.logging_config import logger
from schemas.config_schemas import AppConfig


def _standalone_speaker(cfg: AppConfig):
    """A speaker for reminders when there is no voice loop: the same TTS voice and speaker, no microphone. None (text
    only) when either is unavailable."""
    from bootstrap.builders.audio import build_speaker
    from bootstrap.builders.tts import build_tts
    from service.reminders.standalone_speaker import StandaloneSpeaker

    tts, playback = build_tts(cfg), build_speaker(cfg)
    if tts is None or playback is None:
        logger.warning("[reminders] no voice loop and no usable TTS/speaker: reminders will be text only")
        return None
    logger.info("[reminders] voice loop is off: reminders are spoken through the standalone speaker")
    return StandaloneSpeaker(tts, playback)


def build_reminders(cfg: AppConfig, *, calendar, tasks, voice_session, calendar_changed, music=None):
    """Spoken reminders for calendar events and due tasks. A timer, not an agent: no model, no tools, no prompt. It speaks
    through the voice session only when that is idle, and always leaves the text for the terminal. None when disabled."""
    rc = cfg.reminders
    if not rc.enabled:
        logger.info("[reminders] disabled (reminders.enabled=false)")
        return None
    from domain.policies.reminder_policy import ReminderRules
    from service.reminders.announcer import ReminderAnnouncer
    from service.reminders.feed import ReminderFeed
    from service.reminders.reminder_service import ReminderService
    from service.reminders.scheduler import ReminderScheduler
    from service.reminders.sources import CalendarReminderSource, TaskReminderSource
    from tpa.persistence.repositories.reminder_ledger_repository import SqliteReminderLedger

    rules = ReminderRules(
        enabled=True, lead_minutes=tuple(rc.lead_minutes), at_start=rc.at_start, skip_all_day=rc.skip_all_day,
    )
    sources = []
    if calendar is not None:
        sources.append(CalendarReminderSource(calendar))
    if rc.include_tasks:
        sources.append(TaskReminderSource(tasks))
    ledger, feed = SqliteReminderLedger(), ReminderFeed()
    speaker = voice_session if voice_session is not None else _standalone_speaker(cfg)
    if music is not None and speaker is not None:   # a reminder pauses the music while it is spoken
        from service.music.music_service import MusicAwareSpeaker
        speaker = MusicAwareSpeaker(speaker, music)
    announcer = ReminderAnnouncer(ledger, feed, speaker, rules, idle_settle_sec=rc.idle_settle_sec)
    scheduler = ReminderScheduler(
        sources, ledger, announcer, rules, poll_sec=rc.poll_sec, horizon_hours=rc.horizon_hours, tick_sec=rc.tick_sec,
    )
    service = ReminderService(scheduler, announcer, feed)
    calendar_changed.subscribe(service.nudge)
    return service
