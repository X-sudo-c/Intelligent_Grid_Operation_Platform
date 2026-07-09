#!/usr/bin/env python3
"""Import Ghana OSM roads and places from Geofabrik PBF into gis.map_places."""

from __future__ import annotations

import argparse
import logging
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Iterator
from urllib.request import urlretrieve

REPO_ROOT = Path(__file__).resolve().parents[2]
SYNC_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SYNC_ROOT))

env_path = REPO_ROOT / ".env"
if env_path.is_file():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())

logger = logging.getLogger("import_osm_map_places")

GHANA_PBF_URL = "https://download.geofabrik.de/africa/ghana-latest.osm.pbf"
DEFAULT_PBF = REPO_ROOT / "data" / "ghana-latest.osm.pbf"

_NORMALIZE_RE = re.compile(r"[^a-z0-9]+")

HIGHWAY_EXCLUDE = frozenset(
    {
        "footway",
        "path",
        "steps",
        "cycleway",
        "bridleway",
        "track",
        "proposed",
        "construction",
        "corridor",
        "bus_guideway",
        "escape",
        "raceway",
        "platform",
        "bus_stop",
        "crossing",
        "give_way",
        "mini_roundabout",
        "turning_circle",
        "turning_loop",
        "passing_place",
        "traffic_signals",
        "stop",
        "elevator",
        "via_ferrata",
    }
)

PLACE_TAGS = frozenset(
    {
        "city",
        "town",
        "village",
        "suburb",
        "neighbourhood",
        "hamlet",
        "locality",
        "quarter",
        "isolated_dwelling",
    }
)

POI_TAGS = frozenset(
    {
        "amenity",
        "shop",
        "tourism",
        "leisure",
        "office",
        "historic",
        "man_made",
        "building",
    }
)

UPSERT_SQL = """
INSERT INTO gis.map_places (
  osm_id, osm_type, name, name_norm, place_type, city,
  lon, lat, centroid, west, south, east, north, source, active, updated_at
)
VALUES %s
ON CONFLICT (osm_type, osm_id) DO UPDATE SET
  name = EXCLUDED.name,
  name_norm = EXCLUDED.name_norm,
  place_type = EXCLUDED.place_type,
  city = EXCLUDED.city,
  lon = EXCLUDED.lon,
  lat = EXCLUDED.lat,
  centroid = EXCLUDED.centroid,
  west = EXCLUDED.west,
  south = EXCLUDED.south,
  east = EXCLUDED.east,
  north = EXCLUDED.north,
  source = EXCLUDED.source,
  active = EXCLUDED.active,
  updated_at = now()
"""

ENRICH_DISTRICT_SQL = """
UPDATE gis.map_places mp
SET
  district = b.district,
  region = b.region,
  updated_at = now()
FROM gis.ecg_admin_boundaries b
WHERE mp.district IS NULL
  AND b.geom IS NOT NULL
  AND ST_Within(mp.centroid, b.geom)
"""


def normalize_name(text: str) -> str:
    return _NORMALIZE_RE.sub(" ", (text or "").lower()).strip()


def _city_from_tags(tags: dict[str, str]) -> str | None:
    for key in ("addr:city", "is_in:city", "addr:place"):
        value = (tags.get(key) or "").strip()
        if value:
            return value
    return None


def _bbox_from_coords(coords: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    return min(lons), min(lats), max(lons), max(lats)


def _centroid_from_coords(coords: list[tuple[float, float]]) -> tuple[float, float]:
    if not coords:
        return 0.0, 0.0
    if len(coords) == 1:
        return coords[0]
    lon = sum(c[0] for c in coords) / len(coords)
    lat = sum(c[1] for c in coords) / len(coords)
    return lon, lat


def _row_tuple(row: dict[str, Any]) -> tuple[Any, ...]:
    lon = float(row["lon"])
    lat = float(row["lat"])
    west, south, east, north = row["bbox"]
    return (
        int(row["osm_id"]),
        str(row["osm_type"]),
        str(row["name"]),
        str(row["name_norm"]),
        str(row["place_type"]),
        row.get("city"),
        lon,
        lat,
        f"SRID=4326;POINT({lon} {lat})",
        float(west),
        float(south),
        float(east),
        float(north),
        str(row.get("source") or "osm"),
        True,
    )


def extract_places_from_pbf(pbf_path: Path) -> list[dict[str, Any]]:
    try:
        import osmium
    except ImportError as exc:
        raise SystemExit(
            "pyosmium is required. Install with: pip install osmium"
        ) from exc

    node_index = osmium.index.create_map_in_memory()  # type: ignore[attr-defined]

    class NodeIndexHandler(osmium.SimpleHandler):  # type: ignore[misc,valid-type]
        def node(self, n: Any) -> None:
            if n.location.valid():
                node_index.set(n.id, n.location)

    class PlaceExtractor(osmium.SimpleHandler):  # type: ignore[misc,valid-type]
        def __init__(self) -> None:
            super().__init__()
            self.rows: list[dict[str, Any]] = []

        def _append(
            self,
            *,
            osm_id: int,
            osm_type: str,
            name: str,
            place_type: str,
            tags: dict[str, str],
            coords: list[tuple[float, float]],
        ) -> None:
            name = name.strip()
            if len(name) < 2:
                return
            name_norm = normalize_name(name)
            if len(name_norm) < 2:
                return
            lon, lat = _centroid_from_coords(coords)
            if not (-4.0 <= lon <= 2.0 and 4.0 <= lat <= 12.0):
                return
            west, south, east, north = _bbox_from_coords(coords)
            self.rows.append(
                {
                    "osm_id": osm_id,
                    "osm_type": osm_type,
                    "name": name,
                    "name_norm": name_norm,
                    "place_type": place_type,
                    "city": _city_from_tags(tags),
                    "lon": lon,
                    "lat": lat,
                    "bbox": (west, south, east, north),
                    "source": "osm",
                }
            )

        def node(self, n: Any) -> None:
            tags = {k: v for k, v in n.tags}
            name = tags.get("name")
            if not name or not n.location.valid():
                return
            coords = [(n.location.lon, n.location.lat)]
            place = tags.get("place")
            if place in PLACE_TAGS:
                self._append(
                    osm_id=n.id,
                    osm_type="node",
                    name=name,
                    place_type=place,
                    tags=tags,
                    coords=coords,
                )
                return
            for tag_key in POI_TAGS:
                if tag_key in tags:
                    self._append(
                        osm_id=n.id,
                        osm_type="node",
                        name=name,
                        place_type="poi",
                        tags=tags,
                        coords=coords,
                    )
                    return

        def way(self, w: Any) -> None:
            tags = {k: v for k, v in w.tags}
            name = tags.get("name")
            if not name:
                return
            coords: list[tuple[float, float]] = []
            for node_ref in w.nodes:
                loc = node_index.get(node_ref.ref)
                if loc is None:
                    continue
                coords.append((loc.lon, loc.lat))
            if not coords:
                return

            highway = tags.get("highway")
            if highway and highway not in HIGHWAY_EXCLUDE:
                self._append(
                    osm_id=w.id,
                    osm_type="way",
                    name=name,
                    place_type="road",
                    tags=tags,
                    coords=coords,
                )
                return

            place = tags.get("place")
            if place in PLACE_TAGS:
                self._append(
                    osm_id=w.id,
                    osm_type="way",
                    name=name,
                    place_type=place,
                    tags=tags,
                    coords=coords,
                )
                return

            for tag_key in POI_TAGS:
                if tag_key in tags:
                    self._append(
                        osm_id=w.id,
                        osm_type="way",
                        name=name,
                        place_type="poi",
                        tags=tags,
                        coords=coords,
                    )
                    return

    logger.info("Indexing OSM nodes from %s", pbf_path)
    NodeIndexHandler().apply_file(str(pbf_path), locations=True)

    extractor = PlaceExtractor()
    logger.info("Extracting named roads and places")
    extractor.apply_file(str(pbf_path), locations=True)
    logger.info("Extracted %d map places", len(extractor.rows))
    return extractor.rows


def load_rows(
    conn,
    rows: Iterator[dict[str, Any]],
    *,
    batch_size: int = 2000,
    dry_run: bool = False,
) -> int:
    from psycopg2.extras import execute_values

    total = 0
    batch: list[tuple[Any, ...]] = []
    for row in rows:
        batch.append(_row_tuple(row))
        if len(batch) >= batch_size:
            total += _flush_batch(conn, batch, dry_run=dry_run)
            batch = []
    if batch:
        total += _flush_batch(conn, batch, dry_run=dry_run)
    return total


def _flush_batch(conn, batch: list[tuple[Any, ...]], *, dry_run: bool) -> int:
    if dry_run:
        return len(batch)
    from psycopg2.extras import execute_values

    with conn.cursor() as cur:
        execute_values(cur, UPSERT_SQL, batch, page_size=len(batch))
    conn.commit()
    return len(batch)


def enrich_districts(conn, *, dry_run: bool = False) -> int:
    if dry_run:
        return 0
    with conn.cursor() as cur:
        cur.execute(ENRICH_DISTRICT_SQL)
        updated = cur.rowcount
    conn.commit()
    return int(updated or 0)


def invalidate_autocomplete_cache() -> None:
    try:
        from redis_cache import _KEY_PREFIX, delete_pattern

        deleted = delete_pattern(f"{_KEY_PREFIX}map:autocomplete:*")
        if deleted:
            logger.info("Invalidated %d autocomplete cache keys", deleted)
    except Exception:
        logger.warning("Could not invalidate autocomplete Redis cache", exc_info=True)


def download_pbf(dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    logger.info("Downloading %s -> %s", GHANA_PBF_URL, dest)
    urlretrieve(GHANA_PBF_URL, dest)
    return dest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pbf",
        type=Path,
        default=Path(os.getenv("GHANA_OSM_PBF", str(DEFAULT_PBF))),
        help="Path to ghana-latest.osm.pbf",
    )
    parser.add_argument(
        "--download",
        action="store_true",
        help="Download Geofabrik Ghana PBF before import",
    )
    parser.add_argument(
        "--truncate",
        action="store_true",
        help="Delete existing gis.map_places rows before import",
    )
    parser.add_argument("--batch-size", type=int, default=2000)
    parser.add_argument("--dry-run", action="store_true", help="Parse only; do not write DB")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    pbf_path = args.pbf
    if args.download or not pbf_path.is_file():
        pbf_path = download_pbf(pbf_path)

    if not pbf_path.is_file():
        logger.error("PBF not found: %s (use --download)", pbf_path)
        return 1

    started = time.time()
    rows = extract_places_from_pbf(pbf_path)
    if args.dry_run:
        logger.info("Dry run: would import %d places", len(rows))
        return 0

    dsn = os.getenv("SUPABASE_DB_URI") or os.getenv("DATABASE_URL")
    if not dsn:
        logger.error("SUPABASE_DB_URI not set")
        return 1

    import psycopg2

    conn = psycopg2.connect(dsn)
    try:
        if args.truncate:
            with conn.cursor() as cur:
                cur.execute("TRUNCATE gis.map_places RESTART IDENTITY")
            conn.commit()
            logger.info("Truncated gis.map_places")

        count = load_rows(conn, iter(rows), batch_size=args.batch_size)
        enriched = enrich_districts(conn)
        logger.info(
            "Imported %d places; enriched %d with ECG district/region (%.1fs)",
            count,
            enriched,
            time.time() - started,
        )
        invalidate_autocomplete_cache()
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
