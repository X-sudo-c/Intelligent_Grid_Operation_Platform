"""SAP customer fetch — mock adapter today; OData stub for production."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from .config import SapConfig, sap_config
from .mock_client import fetch_mock_customers
from .models import SapCustomerRecord


def fetch_sap_customers(config: SapConfig | None = None) -> list[SapCustomerRecord]:
    cfg = config or sap_config()
    if cfg.mock_mode:
        return fetch_mock_customers()
    if not cfg.base_url:
        raise RuntimeError("SAP_BASE_URL is required when SAP_MOCK_MODE=false")
    return _fetch_live_customers(cfg)


def _fetch_live_customers(cfg: SapConfig) -> list[SapCustomerRecord]:
    """Placeholder for OData BusinessPartner pull — requires ECG SAP credentials."""
    url = cfg.base_url.rstrip("/") + cfg.customer_entity_path
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    if cfg.client_id and cfg.client_secret:
        import base64

        token = base64.b64encode(f"{cfg.client_id}:{cfg.client_secret}".encode()).decode()
        req.add_header("Authorization", f"Basic {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"SAP HTTP {exc.code}: {exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"SAP connection failed: {exc.reason}") from exc

    rows = body.get("value") or body.get("d", {}).get("results") or []
    if not isinstance(rows, list):
        raise RuntimeError("Unexpected SAP OData response shape")
    return [SapCustomerRecord.from_raw(row) for row in rows]
