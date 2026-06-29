"""Deterministic policy gates for agent tool execution."""

from __future__ import annotations

from agents.models import CleanupMode, PolicyDecision

SEVERITY_ORDER = {"warning": 0, "minor": 1, "major": 2, "critical": 3}

ALWAYS_APPROVE_DOMAINS = frozenset({"customer", "meter", "billing", "financial"})
ALWAYS_APPROVE_RULE_PREFIXES = frozenset(
    {"CUSTOMER_", "METER_", "BILLING_", "FEEDER_", "TOPO_"}
)

VALID_QUEUES = frozenset(
    {
        "ex_gis_topology",
        "ex_critical_blocker",
        "ex_customer_meter",
        "ex_spatial",
        "ex_asset",
        "ex_default",
    }
)


def severity_rank(severity: str) -> int:
    return SEVERITY_ORDER.get(severity.lower(), 2)


def evaluate_cleanup(
    *,
    mode: CleanupMode,
    severity: str,
    domain: str,
    rule_code: str,
    autofix_allowed: bool = False,
    has_rollback: bool = False,
) -> PolicyDecision:
    """Decide whether a cleanup plan may execute or needs approval."""
    if domain in ALWAYS_APPROVE_DOMAINS:
        return PolicyDecision(
            allowed=False,
            requires_approval=True,
            reason=f"Domain '{domain}' requires human approval.",
        )
    if any(rule_code.startswith(p) for p in ALWAYS_APPROVE_RULE_PREFIXES):
        if rule_code.startswith("TOPO_") and severity_rank(severity) <= SEVERITY_ORDER["minor"]:
            pass  # low-risk topology may auto-fix below
        else:
            return PolicyDecision(
                allowed=False,
                requires_approval=True,
                reason=f"Rule '{rule_code}' requires human approval.",
            )

    if severity_rank(severity) >= SEVERITY_ORDER["critical"]:
        return PolicyDecision(
            allowed=False,
            requires_approval=True,
            reason="Critical severity always requires approval.",
        )

    if mode == CleanupMode.MANUAL:
        return PolicyDecision(
            allowed=False,
            requires_approval=True,
            reason="Manual QGIS remediation — no auto execution.",
        )

    if mode == CleanupMode.ASSISTED:
        return PolicyDecision(
            allowed=False,
            requires_approval=True,
            reason="Assisted mode requires steward approval.",
        )

    # AUTO_FIX
    if not autofix_allowed:
        return PolicyDecision(
            allowed=False,
            requires_approval=True,
            reason="Rule is not marked autofix_allowed.",
        )
    if not has_rollback:
        return PolicyDecision(
            allowed=False,
            requires_approval=True,
            reason="Rollback SQL required for auto-fix.",
        )
    if severity_rank(severity) > SEVERITY_ORDER["minor"]:
        return PolicyDecision(
            allowed=False,
            requires_approval=True,
            reason="Auto-fix limited to minor/warning severity.",
        )

    return PolicyDecision(allowed=True, requires_approval=False, reason="Low-risk auto-fix permitted.")


def route_queue(*, domain: str, severity: str, rule_code: str) -> str:
    if severity_rank(severity) >= SEVERITY_ORDER["critical"]:
        return "ex_critical_blocker"
    if domain == "topology" or rule_code.startswith("TOPO_") or rule_code.startswith("ASSET_ORPHAN"):
        return "ex_gis_topology"
    if domain in ("customer", "meter"):
        return "ex_customer_meter"
    if domain == "spatial":
        return "ex_spatial"
    if domain == "asset":
        return "ex_asset"
    return "ex_default"


def validate_queue_name(queue_name: str) -> bool:
    return queue_name in VALID_QUEUES
