"""Audit sink and guardrail hooks builders."""

from __future__ import annotations

from core.enums import HookEvent
from schemas.config_schemas import AppConfig
from service.guardrails.audit_log import AuditLogger
from service.guardrails.permissions import PermissionManager
from service.guardrails.rate_limit import RateLimiter
from service.guardrails.validators import InputValidator, OutputValidator
from service.hooks.dispatcher import (
    create_audit_hook, create_input_validator_hook, create_output_validator_hook,
    create_permission_check_hook, create_rate_limit_hook,
)
from service.hooks.registry import HookRegistry
from tpa.governance.sqlite_audit_sink import NullAuditSink, SqliteAuditSink


def build_audit_sink(cfg: AppConfig):
    gcfg = cfg.governance
    if not gcfg.enabled or gcfg.audit.backend != "sqlite":
        return NullAuditSink()
    from core.constants import PROJECT_ROOT
    return SqliteAuditSink(PROJECT_ROOT / gcfg.audit.db_path)


def build_guardrails(cfg: AppConfig) -> tuple[HookRegistry, PermissionManager]:
    gcfg = cfg.guardrails
    permissions = PermissionManager(
        default_level=gcfg.permissions.default_level,
        approval_timeout=gcfg.permissions.approval_timeout,
    )
    rate_limiter = RateLimiter(
        enabled=gcfg.rate_limiting.enabled,
        global_rpm=gcfg.rate_limiting.global_rpm,
        per_skill_rpm=gcfg.rate_limiting.per_skill_rpm,
    )
    input_validator = InputValidator(max_input_length=gcfg.validators.max_input_length)
    output_validator = OutputValidator(
        block_pii=gcfg.validators.block_pii_in_output,
        block_credentials=gcfg.validators.block_credentials_in_output,
        max_output_length=gcfg.validators.max_output_length,
    )
    from core.constants import PROJECT_ROOT
    audit_logger = AuditLogger(
        log_dir=PROJECT_ROOT / gcfg.audit.log_dir,
        enabled=gcfg.audit.enabled,
        log_inputs=gcfg.audit.log_inputs,
        log_outputs=gcfg.audit.log_outputs,
    )

    hooks = HookRegistry()
    hooks.register(HookEvent.PRE_SKILL, create_permission_check_hook(permissions))
    hooks.register(HookEvent.PRE_SKILL, create_rate_limit_hook(rate_limiter))
    hooks.register(HookEvent.PRE_SKILL, create_input_validator_hook(input_validator))
    hooks.register(HookEvent.POST_SKILL, create_output_validator_hook(output_validator))
    hooks.register(HookEvent.POST_SKILL, create_audit_hook(audit_logger))
    return hooks, permissions
