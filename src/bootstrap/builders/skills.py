"""Skill registry, skill runner and Google Gmail/Calendar tool registration."""

from __future__ import annotations

import os

from core.logging_config import logger
from schemas.config_schemas import AppConfig
from service.hooks.registry import HookRegistry
from service.skills.builtin.file_ops import FileOpsSkill
from service.skills.builtin.terminal import TerminalSkill
from service.skills.registry import SkillRegistry
from service.skills.skill_runner import SkillRunner
from tpa.online.google.calendar_client import GoogleCalendarClient
from tpa.online.google.consent import SCOPES as GOOGLE_SCOPES
from tpa.online.google.gmail_client import GmailClient
from tpa.online.google.google_auth import GoogleAuth
from tpa.online.http_client import AllowListedHttpClient


def build_skills(cfg: AppConfig, hooks: HookRegistry) -> tuple[SkillRegistry, SkillRunner]:
    scfg = cfg.skills
    registry = SkillRegistry()
    registry.register(TerminalSkill(permission_level=scfg.terminal.permission_level, enabled=scfg.terminal.enabled, **scfg.terminal.extra))
    registry.register(FileOpsSkill(permission_level=scfg.file_ops.permission_level, enabled=scfg.file_ops.enabled, **scfg.file_ops.extra))
    return registry, SkillRunner(skill_registry=registry, hook_registry=hooks)


GOOGLE_TOOLS = ("gmail_search", "gmail_read", "gmail_draft", "gmail_send", "calendar_agenda", "calendar_create")


def register_google_tools(
    online, tool_manifests: dict, skill_registry: SkillRegistry, on_calendar_change=None,
) -> tuple[GoogleAuth | None, GoogleCalendarClient | None]:
    """Gmail + Calendar skills over one shared Google sign-in. They are registered even when the account is not yet
    linked, so asking about mail gets "it isn't set up" (and scripts/google_auth.py tells the user how) instead of a
    wrong answer from another tool."""
    from service.mail.draft_outbox import DraftOutbox
    from service.mail.contact_book import load_mail_contacts
    from service.skills.builtin.calendar_agenda import CalendarAgendaSkill
    from service.skills.builtin.calendar_create import CalendarCreateSkill
    from service.skills.builtin.gmail import GmailDraftSkill, GmailReadSkill, GmailSearchSkill, GmailSendSkill

    if not any(name in tool_manifests for name in GOOGLE_TOOLS):
        return None, None
    http = AllowListedHttpClient(allow_list=frozenset(online.allowlist))
    auth = GoogleAuth(
        http,
        client_id=lambda: os.environ.get(online.google_client_id_env),
        client_secret=lambda: os.environ.get(online.google_client_secret_env),
        refresh_token=lambda: os.environ.get(online.google_refresh_token_env),
        required_scopes=GOOGLE_SCOPES,
    )
    mail, calendar, outbox = GmailClient(http, auth), GoogleCalendarClient(http, auth), DraftOutbox()
    mail_contacts = load_mail_contacts()      # config/mail_contacts.yaml: name -> address; a missing file is an empty map
    builders = {
        "gmail_search": lambda m: GmailSearchSkill(mail, m),
        "gmail_read": lambda m: GmailReadSkill(mail, m),
        "gmail_draft": lambda m: GmailDraftSkill(mail, m, outbox, contacts=mail_contacts),
        "gmail_send": lambda m: GmailSendSkill(mail, m, outbox),
        "calendar_agenda": lambda m: CalendarAgendaSkill(calendar, m),
        "calendar_create": lambda m: CalendarCreateSkill(calendar, m, on_created=on_calendar_change),
    }
    for name, build in builders.items():
        if name in tool_manifests:
            skill_registry.register(build(tool_manifests[name]))
    missing = auth.missing()
    if missing:
        logger.info(f"[google] not linked (missing {', '.join(missing)}): mail and calendar tools will say so. Run `veda login`")
    else:
        logger.info("[google] Gmail and Calendar tools ready")
    return auth, calendar
