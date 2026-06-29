"""Pull customers from SAP (mock or live) into public.customer_accounts."""

from __future__ import annotations

import json
import uuid
from typing import Any

from dlq import insert_dlq

from lineage import log_lineage

from .client import fetch_sap_customers
from .config import sap_config
from .models import SapCustomerRecord


def _start_run(conn, mode: str) -> str:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO sap_sync_runs (sync_type, mode, status)
            VALUES ('customers', %s, 'running')
            RETURNING id::text
            """,
            (mode,),
        )
        return cur.fetchone()[0]


def _finish_run(
    conn,
    run_id: str,
    *,
    status: str,
    fetched: int,
    upserted: int,
    failed: int,
    error_summary: str | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE sap_sync_runs
            SET status = %s, fetched_count = %s, upserted_count = %s,
                failed_count = %s, error_summary = %s, finished_at = NOW()
            WHERE id = %s::uuid
            """,
            (status, fetched, upserted, failed, error_summary, run_id),
        )


def upsert_customer(conn, record: SapCustomerRecord) -> str:
    """Upsert by sap_business_partner_id or account_number. Returns account_mrid."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT account_mrid::text, customer_name, account_number, balance_ghs
            FROM customer_accounts
            WHERE sap_business_partner_id = %s OR account_number = %s
            LIMIT 1
            """,
            (record.business_partner_id, record.account_number),
        )
        existing = cur.fetchone()
        if existing:
            account_mrid = existing[0]
            before_state = {
                "customer_name": existing[1],
                "account_number": existing[2],
                "balance_ghs": float(existing[3]) if existing[3] is not None else None,
            }
            cur.execute(
                """
                UPDATE customer_accounts
                SET customer_name = %s,
                    account_number = %s,
                    balance_ghs = %s,
                    sap_business_partner_id = %s,
                    source_system = 'SAP',
                    updated_at = NOW()
                WHERE account_mrid = %s::uuid
                RETURNING account_mrid::text
                """,
                (
                    record.customer_name,
                    record.account_number,
                    record.balance_ghs,
                    record.business_partner_id,
                    account_mrid,
                ),
            )
            account_mrid = cur.fetchone()[0]
            log_lineage(
                conn,
                target_mrid=account_mrid,
                source_type="SYSTEM",
                action_type="SAP_CUSTOMER_UPSERT",
                provenance_ref=f"sap:{record.business_partner_id}",
                before_state=before_state,
                after_state={
                    "customer_name": record.customer_name,
                    "account_number": record.account_number,
                    "balance_ghs": record.balance_ghs,
                },
            )
            return account_mrid

        account_mrid = str(uuid.uuid4())
        cur.execute(
            """
            INSERT INTO customer_accounts (
              account_mrid, customer_name, account_number, balance_ghs,
              sap_business_partner_id, source_system, updated_at
            ) VALUES (%s::uuid, %s, %s, %s, %s, 'SAP', NOW())
            RETURNING account_mrid::text
            """,
            (
                account_mrid,
                record.customer_name,
                record.account_number,
                record.balance_ghs,
                record.business_partner_id,
            ),
        )
        account_mrid = cur.fetchone()[0]
    log_lineage(
        conn,
        target_mrid=account_mrid,
        source_type="SYSTEM",
        action_type="SAP_CUSTOMER_INSERT",
        provenance_ref=f"sap:{record.business_partner_id}",
        after_state={
            "customer_name": record.customer_name,
            "account_number": record.account_number,
            "balance_ghs": record.balance_ghs,
        },
    )
    return account_mrid


def upsert_customer_from_payload(conn, payload: dict[str, Any]) -> str:
    return upsert_customer(conn, SapCustomerRecord.from_raw(payload))


def sync_customers_from_sap(conn) -> dict[str, Any]:
    cfg = sap_config()
    if not cfg.sync_enabled:
        raise RuntimeError("SAP customer sync is disabled (SAP_CUSTOMER_SYNC_ENABLED=false)")

    run_id = _start_run(conn, cfg.mode_label)
    conn.commit()

    fetched = 0
    upserted = 0
    failed = 0
    errors: list[str] = []

    try:
        records = fetch_sap_customers(cfg)
        fetched = len(records)
    except Exception as exc:
        _finish_run(conn, run_id, status="failed", fetched=0, upserted=0, failed=0, error_summary=str(exc))
        conn.commit()
        raise

    for record in records:
        try:
            upsert_customer(conn, record)
            conn.commit()
            upserted += 1
        except Exception as exc:
            conn.rollback()
            failed += 1
            msg = str(exc)[:500]
            errors.append(f"{record.business_partner_id}: {msg}")
            insert_dlq(
                conn,
                source="SAP",
                payload={
                    "sync_type": "customers",
                    "business_partner_id": record.business_partner_id,
                    "account_number": record.account_number,
                    "customer_name": record.customer_name,
                    "balance_ghs": record.balance_ghs,
                },
                error_message=msg,
            )
            conn.commit()

    status = "completed" if failed == 0 else ("partial" if upserted else "failed")
    summary = "; ".join(errors[:5]) if errors else None
    _finish_run(conn, run_id, status=status, fetched=fetched, upserted=upserted, failed=failed, error_summary=summary)
    conn.commit()

    return {
        "run_id": run_id,
        "mode": cfg.mode_label,
        "status": status,
        "fetched": fetched,
        "upserted": upserted,
        "failed": failed,
        "errors": errors,
    }


def sap_integration_status(conn) -> dict[str, Any]:
    cfg = sap_config()
    last_run: dict[str, Any] | None = None
    open_dlq = 0
    customer_count = 0
    sap_linked = 0

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text, mode, status, fetched_count, upserted_count, failed_count,
                   error_summary, started_at, finished_at
            FROM sap_sync_runs
            ORDER BY started_at DESC
            LIMIT 1
            """
        )
        row = cur.fetchone()
        if row:
            last_run = {
                "id": row[0],
                "mode": row[1],
                "status": row[2],
                "fetched": row[3],
                "upserted": row[4],
                "failed": row[5],
                "error_summary": row[6],
                "started_at": row[7].isoformat() if row[7] else None,
                "finished_at": row[8].isoformat() if row[8] else None,
            }
        cur.execute(
            "SELECT COUNT(*) FROM integration_dlq WHERE source = 'SAP' AND status = 'OPEN'"
        )
        open_dlq = int(cur.fetchone()[0])
        cur.execute("SELECT COUNT(*) FROM customer_accounts")
        customer_count = int(cur.fetchone()[0])
        cur.execute(
            "SELECT COUNT(*) FROM customer_accounts WHERE sap_business_partner_id IS NOT NULL"
        )
        sap_linked = int(cur.fetchone()[0])

    return {
        "enabled": cfg.sync_enabled,
        "mode": cfg.mode_label,
        "mock_mode": cfg.mock_mode,
        "base_url_configured": bool(cfg.base_url),
        "customer_entity_path": cfg.customer_entity_path,
        "customer_accounts_total": customer_count,
        "customer_accounts_sap_linked": sap_linked,
        "open_sap_dlq_count": open_dlq,
        "last_run": last_run,
    }
