"""SAP connection settings (mock or live OData)."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _truthy(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class SapConfig:
    mock_mode: bool
    base_url: str
    client_id: str
    client_secret: str
    customer_entity_path: str
    sync_enabled: bool

    @property
    def mode_label(self) -> str:
        return "mock" if self.mock_mode else "live"


def sap_config() -> SapConfig:
    mock_default = not os.environ.get("SAP_BASE_URL", "").strip()
    return SapConfig(
        mock_mode=_truthy(os.environ.get("SAP_MOCK_MODE"), default=mock_default),
        base_url=os.environ.get("SAP_BASE_URL", "").strip(),
        client_id=os.environ.get("SAP_CLIENT_ID", "").strip(),
        client_secret=os.environ.get("SAP_CLIENT_SECRET", "").strip(),
        customer_entity_path=os.environ.get(
            "SAP_CUSTOMER_ODATA_PATH",
            "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner",
        ).strip(),
        sync_enabled=_truthy(os.environ.get("SAP_CUSTOMER_SYNC_ENABLED"), default=True),
    )
