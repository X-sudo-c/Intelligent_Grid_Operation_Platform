"""In-memory / fixture SAP customer feed for local development."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .models import SapCustomerRecord

_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "mock_customers.json"


def fetch_mock_customers(*, simulate_failure: bool = False) -> list[SapCustomerRecord]:
    if simulate_failure:
        raise RuntimeError("Mock SAP endpoint unavailable (simulated failure)")
    raw: list[dict[str, Any]] = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    return [SapCustomerRecord.from_raw(row) for row in raw]
