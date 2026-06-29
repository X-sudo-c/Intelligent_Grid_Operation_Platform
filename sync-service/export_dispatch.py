"""Central dispatch for all gis_transfer_jobs export formats."""

from __future__ import annotations

from typing import Any, Callable

from cim_export import process_export_job, read_export_bytes as read_cim_bytes
from cim_xml_export import (
    create_cim_rdf_export_job,
    create_cim_xml_export_job,
    process_cim_rdf_export_job,
    process_cim_xml_export_job,
    read_cim_rdf_bytes,
    read_cim_xml_bytes,
)
from csv_export import process_csv_export_job, read_csv_bytes
from dxf_export import process_dxf_export_job, read_dxf_bytes
from export_base import DOWNLOAD_INFO
from gpkg_export import process_gpkg_export_job, read_gpkg_bytes
from integration_export import (
    process_mdms_export_job,
    process_sap_export_job,
    read_mdms_bytes,
    read_sap_bytes,
)
from kml_export import process_kml_export_job, read_kml_bytes
from shapefile_export import process_shapefile_export_job, read_shapefile_bytes

PROCESSORS: dict[str, Callable] = {
    "cim-json": process_export_job,
    "dxf": process_dxf_export_job,
    "geopackage": process_gpkg_export_job,
    "kml": process_kml_export_job,
    "shapefile": process_shapefile_export_job,
    "csv": process_csv_export_job,
    "cim-xml": process_cim_xml_export_job,
    "cim-rdf": process_cim_rdf_export_job,
    "mdms-csv": process_mdms_export_job,
    "sap-csv": process_sap_export_job,
}

READERS: dict[str, Callable] = {
    "cim-json": read_cim_bytes,
    "dxf": read_dxf_bytes,
    "geopackage": read_gpkg_bytes,
    "kml": read_kml_bytes,
    "shapefile": read_shapefile_bytes,
    "csv": read_csv_bytes,
    "cim-xml": read_cim_xml_bytes,
    "cim-rdf": read_cim_rdf_bytes,
    "mdms-csv": read_mdms_bytes,
    "sap-csv": read_sap_bytes,
}

LINEAGE_ACTIONS: dict[str, str] = {
    "cim-json": "CIM_EXPORT",
    "dxf": "DXF_EXPORT",
    "geopackage": "GPKG_EXPORT",
    "kml": "KML_EXPORT",
    "shapefile": "SHP_EXPORT",
    "csv": "CSV_EXPORT",
    "cim-xml": "CIM_RDF_EXPORT",
    "cim-rdf": "CIM_RDF_EXPORT",
    "mdms-csv": "MDMS_EXPORT",
    "sap-csv": "SAP_EXPORT",
}

SUPPORTED_FORMATS = sorted(PROCESSORS.keys())


def process_job(conn, job_id: str, fmt: str) -> dict[str, Any]:
    processor = PROCESSORS.get(fmt)
    if not processor:
        raise ValueError(f"Unsupported export format: {fmt}")
    return processor(conn, job_id)


def read_job_bytes(conn, job_id: str, fmt: str) -> tuple[bytes, str]:
    reader = READERS.get(fmt)
    if not reader:
        raise ValueError(f"Unsupported export format: {fmt}")
    body, media_type = reader(conn, job_id)
    default_name, default_type = DOWNLOAD_INFO.get(fmt, ("export.bin", "application/octet-stream"))
    return body, media_type or default_type


def download_filename(job_id: str, fmt: str) -> str:
    name, _ = DOWNLOAD_INFO.get(fmt, (f"{fmt}.bin", "application/octet-stream"))
    if name.startswith("export."):
        return f"{job_id}.{name.split('.', 1)[1]}"
    return f"{job_id}_{name.replace('export_', '', 1)}"
