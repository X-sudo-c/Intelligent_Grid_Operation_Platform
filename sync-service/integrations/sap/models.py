"""Canonical SAP customer record after adapter normalization."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class SapCustomerRecord:
    business_partner_id: str
    account_number: str
    customer_name: str
    balance_ghs: float

    @classmethod
    def from_raw(cls, raw: dict[str, Any]) -> SapCustomerRecord:
        bp = str(raw.get("business_partner_id") or raw.get("BusinessPartner") or "").strip()
        acct = str(raw.get("account_number") or raw.get("AccountNumber") or "").strip()
        name = str(raw.get("customer_name") or raw.get("CustomerName") or raw.get("BusinessPartnerName") or "").strip()
        balance = raw.get("balance_ghs", raw.get("BalanceGhs", 0))
        if not bp or not acct or not name:
            raise ValueError(f"Incomplete SAP customer record: {raw!r}")
        return cls(
            business_partner_id=bp,
            account_number=acct,
            customer_name=name,
            balance_ghs=float(balance or 0),
        )
