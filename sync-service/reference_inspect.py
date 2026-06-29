"""Inspect uploaded GIS files — layer list, attributes, and preview GeoJSON."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Any

from reference_import import IMPORTS_DIR, OGR_EXTENSIONS

INSPECT_DIR = IMPORTS_DIR / "inspect"
VALID_COLUMN = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


def _require_ogr() -> None:
    if shutil.which("ogrinfo") is None or shutil.which("ogr2ogr") is None:
        raise RuntimeError("GDAL tools not found — install gdal-bin (ogrinfo, ogr2ogr)")


def save_inspect_upload(body: bytes, filename: str) -> tuple[str, Path]:
    _require_ogr()
    inspect_id = str(uuid.uuid4())
    ext = Path(filename).suffix.lower() if filename else ".gpkg"
    if ext not in OGR_EXTENSIONS:
        ext = ".gpkg"
    dest_dir = INSPECT_DIR / inspect_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = dest_dir / f"source{ext}"
    dest_path.write_bytes(body)
    meta = {
        "inspect_id": inspect_id,
        "filename": filename or dest_path.name,
        "path": str(dest_path),
        "extension": ext,
    }
    (dest_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    return inspect_id, dest_path


def load_inspect_path(inspect_id: str) -> Path:
    meta_path = INSPECT_DIR / inspect_id / "meta.json"
    if not meta_path.is_file():
        raise ValueError("Inspect session not found or expired")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    path = Path(meta["path"])
    if not path.is_file():
        raise ValueError("Inspect upload file missing")
    return path


def _parse_ogrinfo_layers(path: Path) -> list[str]:
    proc = subprocess.run(
        ["ogrinfo", "-json", str(path)],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "ogrinfo failed")
    data = json.loads(proc.stdout)
    layers = data.get("layers") or []
    return [layer.get("name") for layer in layers if layer.get("name")]


def _layer_summary(path: Path, layer_name: str | None) -> dict[str, Any]:
    args = ["ogrinfo", "-json", "-al", "-so", str(path)]
    if layer_name:
        args.append(layer_name)
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "ogrinfo layer summary failed")
    data = json.loads(proc.stdout)
    layers = data.get("layers") or []
    if not layers:
        return {"name": layer_name, "feature_count": 0, "geometry_type": None, "fields": []}
    layer = layers[0]
    geom_type = None
    geom_fields = layer.get("geometryFields") or []
    if geom_fields:
        geom_type = geom_fields[0].get("type")
    fields = []
    for field in layer.get("fields") or []:
        if field.get("name", "").lower() in ("geom", "wkb_geometry", "geometry"):
            continue
        fields.append(
            {
                "name": field.get("name"),
                "type": field.get("type"),
            }
        )
    return {
        "name": layer.get("name") or layer_name,
        "feature_count": int(layer.get("featureCount") or 0),
        "geometry_type": geom_type,
        "fields": fields,
    }


def inspect_file(path: Path) -> dict[str, Any]:
    _require_ogr()
    layer_names = _parse_ogrinfo_layers(path)
    layers: list[dict[str, Any]] = []
    for name in layer_names:
        try:
            summary = _layer_summary(path, name)
            layers.append(summary)
        except Exception as exc:
            layers.append({"name": name, "feature_count": 0, "error": str(exc), "fields": []})
    return {
        "filename": path.name,
        "layer_count": len(layers),
        "layers": layers,
    }


def inspect_uploaded(inspect_id: str) -> dict[str, Any]:
    path = load_inspect_path(inspect_id)
    result = inspect_file(path)
    result["inspect_id"] = inspect_id
    return result


def layer_preview_geojson(
    inspect_id: str,
    layer_name: str | None = None,
    *,
    limit: int = 150,
) -> dict[str, Any]:
    _require_ogr()
    path = load_inspect_path(inspect_id)
    out_path = INSPECT_DIR / inspect_id / "preview.geojson"
    cmd = [
        "ogr2ogr",
        "-f",
        "GeoJSON",
        str(out_path),
        str(path),
    ]
    if layer_name:
        cmd.append(layer_name)
    cmd.extend(["-limit", str(limit)])
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "ogr2ogr preview failed")
    if not out_path.is_file():
        return {"type": "FeatureCollection", "features": []}
    data = json.loads(out_path.read_text(encoding="utf-8"))
    return data


def suggest_boundary_fields(fields: list[dict[str, Any]]) -> dict[str, str | None]:
    names = [f.get("name", "") for f in fields]
    lower = {n.lower(): n for n in names if n}

    def pick(*candidates: str) -> str | None:
        for c in candidates:
            if c in lower:
                return lower[c]
        return None

    return {
        "dissolve_column": pick("region", "region_name", "state", "province", "parent", "area", "zone"),
        "label_field": pick("district", "district_name", "name", "label", "locality", "area_name"),
    }


def copy_inspect_to_job(inspect_id: str, job_id: str) -> tuple[str | None, str]:
    from reference_import import save_import_upload

    path = load_inspect_path(inspect_id)
    meta_path = INSPECT_DIR / inspect_id / "meta.json"
    filename = path.name
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        filename = meta.get("filename") or filename
    return save_import_upload(job_id, path.read_bytes(), filename)


def validate_column(name: str | None) -> str | None:
    if not name:
        return None
    if not VALID_COLUMN.match(name):
        raise ValueError(f"Invalid column name: {name}")
    return name
