"""Pydantic models for the validation agent engine."""

from __future__ import annotations

from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field


class RunType(str, Enum):
    FULL_CYCLE = "full_cycle"
    ASSET_CHECKS = "asset_checks"
    TOPOLOGY_MASTER = "topology_master"
    REVALIDATION = "revalidation"


class RunMode(str, Enum):
    DETERMINISTIC = "deterministic"
    AGENT = "agent"


class CleanupMode(str, Enum):
    AUTO_FIX = "AUTO_FIX"
    ASSISTED = "ASSISTED"
    MANUAL = "MANUAL"


class ValidationRunRequest(BaseModel):
    run_type: RunType = RunType.FULL_CYCLE
    mode: RunMode = RunMode.DETERMINISTIC
    mrid: str | None = None
    tier: str = "master"
    operator_id: str | None = None
    clip: dict[str, float] | None = None


class CleanupPlan(BaseModel):
    mode: CleanupMode = CleanupMode.ASSISTED
    target_mrid: str
    exception_id: str | None = None
    steps: list[str] = Field(default_factory=list)
    risk: str = "medium"
    qgis_steps: str | None = None
    rollback_sql: str | None = None


class PolicyDecision(BaseModel):
    allowed: bool
    requires_approval: bool
    reason: str


class AgentChatRequest(BaseModel):
    message: str
    exception_id: str | None = None
    mrid: str | None = None
    operator_id: str | None = None
    context: dict[str, Any] = Field(default_factory=dict)


class AgentChatResponse(BaseModel):
    content: str
    findings: list[str] = Field(default_factory=list)
    actions: list[str] = Field(default_factory=list)
    ui_actions: list[dict[str, Any]] = Field(default_factory=list)
    agent: dict[str, Any] = Field(default_factory=dict)


class ApprovalDecision(BaseModel):
    operator_id: str | None = None
    note: str | None = None
