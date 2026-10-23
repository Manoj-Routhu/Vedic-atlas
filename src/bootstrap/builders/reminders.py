"""Spoken reminders builder."""

from __future__ import annotations

from core.logging_config import logger
from schemas.config_schemas import AppConfig


def build_reminders(cfg: AppConfig, *, calendar, tasks, voice_session, calendar_changed):
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
    announcer = ReminderAnnouncer(ledger, feed, voice_session, rules, idle_settle_sec=rc.idle_settle_sec)
    scheduler = ReminderScheduler(
        sources, ledger, announcer, rules, poll_sec=rc.poll_sec, horizon_hours=rc.horizon_hours, tick_sec=rc.tick_sec,
    )
    service = ReminderService(scheduler, announcer, feed)
    calendar_changed.subscribe(service.nudge)
    return service
