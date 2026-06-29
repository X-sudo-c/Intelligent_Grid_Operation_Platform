"""Shared master-network feature queries for GIS vector exports."""

from __future__ import annotations

from typing import Any

from cim_export import _blocked_mrids, _bbox_clause


def fetch_export_nodes(
    conn,
    *,
    clip: dict[str, float] | None,
    exclude_dq_blocked: bool = True,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    blocked = _blocked_mrids(conn, exclude_dq_blocked)
    bbox_sql, bbox_params = _bbox_clause("cn", "geom", clip)
    lim = f" LIMIT {int(limit)}" if limit else ""
    nodes: list[dict[str, Any]] = []
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT cn.mrid::text, io.name, cn.boundary_feeder_id,
                   ce.nominal_voltage::text, io.lifecycle_state::text,
                   ST_X(cn.geom) AS lon, ST_Y(cn.geom) AS lat,
                   ST_AsBinary(cn.geom) AS wkb
            FROM public.connectivity_nodes cn
            JOIN public.identified_objects io ON io.mrid = cn.mrid
            LEFT JOIN public.conducting_equipment ce ON ce.mrid = cn.mrid
            WHERE io.validation = 'APPROVED'
            {bbox_sql}
            ORDER BY io.name
            {lim}
            """,
            bbox_params,
        )
        for row in cur.fetchall():
            mrid = row[0]
            if mrid in blocked:
                continue
            nodes.append(
                {
                    "mrid": mrid,
                    "name": row[1],
                    "boundary_feeder_id": row[2],
                    "nominal_voltage": row[3],
                    "lifecycle_state": row[4],
                    "lon": float(row[5]),
                    "lat": float(row[6]),
                    "wkb": bytes(row[7]) if row[7] else None,
                }
            )
    return nodes


def fetch_export_lines(
    conn,
    *,
    clip: dict[str, float] | None,
    exclude_dq_blocked: bool = True,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    blocked = _blocked_mrids(conn, exclude_dq_blocked)
    line_bbox, line_params = _bbox_clause("als", "geom", clip)
    lim = f" LIMIT {int(limit)}" if limit else ""
    lines: list[dict[str, Any]] = []
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT als.mrid::text, io.name,
                   als.source_node_id::text, als.target_node_id::text,
                   ce.nominal_voltage::text, ce.phases,
                   ST_AsBinary(als.geom) AS wkb
            FROM public.ac_line_segments als
            JOIN public.identified_objects io ON io.mrid = als.mrid
            JOIN public.conducting_equipment ce ON ce.mrid = als.mrid
            WHERE io.validation = 'APPROVED'
            {line_bbox}
            ORDER BY io.name
            {lim}
            """,
            line_params,
        )
        for row in cur.fetchall():
            mrid = row[0]
            if mrid in blocked or row[2] in blocked or row[3] in blocked:
                continue
            lines.append(
                {
                    "mrid": mrid,
                    "name": row[1],
                    "source_node_mrid": row[2],
                    "target_node_mrid": row[3],
                    "nominal_voltage": row[4],
                    "phases": row[5],
                    "wkb": bytes(row[6]) if row[6] else None,
                }
            )
    return lines


def fetch_export_meters(
    conn,
    *,
    exclude_dq_blocked: bool = True,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    blocked = _blocked_mrids(conn, exclude_dq_blocked)
    lim = f" LIMIT {int(limit)}" if limit else ""
    meters: list[dict[str, Any]] = []
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT m.mrid::text, io.name, m.serial_number, m.manufacturer,
                   m.installed_at, io.lifecycle_state::text
            FROM public.meters m
            JOIN public.identified_objects io ON io.mrid = m.mrid
            WHERE io.validation = 'APPROVED'
            ORDER BY m.serial_number
            {lim}
            """
        )
        for row in cur.fetchall():
            if row[0] in blocked:
                continue
            meters.append(
                {
                    "mrid": row[0],
                    "name": row[1],
                    "serial_number": row[2],
                    "manufacturer": row[3],
                    "installed_at": row[4].isoformat() if row[4] else None,
                    "lifecycle_state": row[5],
                }
            )
    return meters


def fetch_export_equipment(
    conn,
    *,
    clip: dict[str, float] | None,
    exclude_dq_blocked: bool = True,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    blocked = _blocked_mrids(conn, exclude_dq_blocked)
    bbox_sql, bbox_params = _bbox_clause("cn", "geom", clip)
    lim = f" LIMIT {int(limit)}" if limit else ""
    items: list[dict[str, Any]] = []
    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT ce.mrid::text, io.name, ce.nominal_voltage::text,
                   ce.phases, io.lifecycle_state::text,
                   cn.boundary_feeder_id,
                   ST_X(cn.geom) AS lon, ST_Y(cn.geom) AS lat
            FROM public.conducting_equipment ce
            JOIN public.identified_objects io ON io.mrid = ce.mrid
            JOIN public.connectivity_nodes cn ON cn.mrid = ce.mrid
            WHERE io.validation = 'APPROVED'
            {bbox_sql}
            ORDER BY io.name
            {lim}
            """,
            bbox_params,
        )
        for row in cur.fetchall():
            if row[0] in blocked:
                continue
            items.append(
                {
                    "mrid": row[0],
                    "name": row[1],
                    "nominal_voltage": row[2],
                    "phases": row[3],
                    "lifecycle_state": row[4],
                    "boundary_feeder_id": row[5],
                    "lon": float(row[6]) if row[6] is not None else None,
                    "lat": float(row[7]) if row[7] is not None else None,
                }
            )
    return items


def export_counts(nodes: list, lines: list) -> dict[str, int]:
    return {
        "connectivity_nodes": len(nodes),
        "ac_line_segments": len(lines),
        "total_features": len(nodes) + len(lines),
    }
