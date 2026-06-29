"""CIM RDF/XML export (FR-019) — IEC 61968/61970 profile via cim_rdf serializer."""

from __future__ import annotations

from typing import Any

from cim_export import DEFAULT_LAYERS, build_cim_payload, validate_export_scope
from cim_rdf import build_cim_rdf_meta, build_cim_rdf_xml, validate_rdf_fragment
from export_base import create_format_export_job, process_format_export_job, read_format_export_bytes

CIM_RDF_FILENAME = "export.cim.rdf.xml"
CIM_RDF_MEDIA = "application/rdf+xml"
LEGACY_XML_FILENAME = "export.cim.xml"
LEGACY_XML_MEDIA = "application/rdf+xml"


def build_cim_rdf_document(
    conn,
    *,
    layers: list[str] | None = None,
    clip: dict[str, float] | None,
    exclude_dq_blocked: bool = True,
    limit: int | None = None,
) -> tuple[str, dict[str, Any]]:
    payload = build_cim_payload(
        conn,
        layers=layers,
        clip=clip,
        exclude_dq_blocked=exclude_dq_blocked,
        limit=limit,
    )
    xml_text = build_cim_rdf_xml(payload)
    validate_rdf_fragment(xml_text)
    meta = build_cim_rdf_meta(payload)
    return xml_text, meta


def _build_job_body(conn, job: dict[str, Any], *, fmt: str) -> tuple[bytes, dict[str, Any], str, str]:
    clip = job["clip"]
    if clip and None in clip.values():
        clip = None
    validate_export_scope(conn, clip)
    layers = job.get("layers") or DEFAULT_LAYERS
    xml_text, meta = build_cim_rdf_document(conn, layers=layers, clip=clip)
    meta["@format"] = fmt
    if fmt == "cim-rdf":
        return xml_text.encode("utf-8"), meta, CIM_RDF_FILENAME, CIM_RDF_MEDIA
    return xml_text.encode("utf-8"), meta, LEGACY_XML_FILENAME, LEGACY_XML_MEDIA


def create_cim_xml_export_job(conn, *, layers, clip, requested_by):
    return create_format_export_job(
        conn,
        fmt="cim-xml",
        layers=layers,
        clip=clip,
        requested_by=requested_by,
    )


def create_cim_rdf_export_job(conn, *, layers, clip, requested_by):
    return create_format_export_job(
        conn,
        fmt="cim-rdf",
        layers=layers,
        clip=clip,
        requested_by=requested_by,
    )


def process_cim_xml_export_job(conn, job_id: str) -> dict[str, Any]:
    return process_format_export_job(
        conn,
        job_id,
        build_body=lambda c, j: _build_job_body(c, j, fmt="cim-xml"),
        default_filename=LEGACY_XML_FILENAME,
        content_type=LEGACY_XML_MEDIA,
    )


def process_cim_rdf_export_job(conn, job_id: str) -> dict[str, Any]:
    return process_format_export_job(
        conn,
        job_id,
        build_body=lambda c, j: _build_job_body(c, j, fmt="cim-rdf"),
        default_filename=CIM_RDF_FILENAME,
        content_type=CIM_RDF_MEDIA,
    )


def read_cim_xml_bytes(conn, job_id: str) -> tuple[bytes, str]:
    return read_format_export_bytes(
        conn,
        job_id,
        default_filename=LEGACY_XML_FILENAME,
        content_type=LEGACY_XML_MEDIA,
    )


def read_cim_rdf_bytes(conn, job_id: str) -> tuple[bytes, str]:
    return read_format_export_bytes(
        conn,
        job_id,
        default_filename=CIM_RDF_FILENAME,
        content_type=CIM_RDF_MEDIA,
    )
