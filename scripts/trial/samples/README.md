# GIS import wizard — sample files

Use these in **GIS references → Import wizard** (`/references`).

| File | Format | What it tests |
|------|--------|----------------|
| `acme-districts.geojson` | GeoJSON | Inspect, preview, dissolve by `region`, label `district` |
| `acme-territory.kml` | KML | Non-GeoJSON upload path |
| `acme-multi.gpkg` | GeoPackage | Layer picker — choose **`districts`**, not `substations` |

## Suggested wizard settings

- **Dissolve column:** `region`
- **Label field:** `district`
- **Detail min zoom:** `10`

## Regenerate the GPKG

```bash
./scripts/trial/samples/build_acme_multi_gpkg.sh
```

Requires GDAL (`ogr2ogr`).
