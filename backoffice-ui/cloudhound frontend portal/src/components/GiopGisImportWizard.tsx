import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from '../lib/maplibreSetup';
import {
  commitReferenceImport,
  getInspectPreview,
  inspectGisUpload,
  suggestInspectFields,
  type GiopInspectLayer,
  type GiopInspectResult,
  type GiopReferenceLayer,
} from '../api/giop-api';

type WizardStep = 'upload' | 'configure';

interface GiopGisImportWizardProps {
  isLightMode: boolean;
  boundaryLayers: GiopReferenceLayer[];
  onImported: () => void;
}

function boundsFromGeojson(geojson: GeoJSON.FeatureCollection): maplibregl.LngLatBoundsLike | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const [x, y] = coords;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      return;
    }
    for (const part of coords) visit(part);
  };

  for (const feature of geojson.features ?? []) {
    if (feature.geometry) visit(feature.geometry.coordinates);
  }
  if (!Number.isFinite(minX)) return null;
  return [
    [minX, minY],
    [maxX, maxY],
  ];
}

export function GiopGisImportWizard({
  isLightMode,
  boundaryLayers,
  onImported,
}: GiopGisImportWizardProps) {
  const [step, setStep] = useState<WizardStep>('upload');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [inspect, setInspect] = useState<GiopInspectResult | null>(null);
  const [selectedLayer, setSelectedLayer] = useState<GiopInspectLayer | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [dissolveColumn, setDissolveColumn] = useState('');
  const [labelField, setLabelField] = useState('');
  const [detailMinZoom, setDetailMinZoom] = useState(10);
  const [catalogSlug, setCatalogSlug] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  const card = isLightMode ? 'border-slate-200 bg-slate-50' : 'border-slate-700 bg-slate-900/30';
  const muted = isLightMode ? 'text-slate-500' : 'text-slate-400';
  const input = `rounded border px-2 py-1.5 text-sm w-full ${
    isLightMode ? 'border-slate-300 bg-white' : 'border-slate-600 bg-slate-900'
  }`;
  const btn = 'rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-white text-sm py-1.5 px-3';

  const reimportTargets = boundaryLayers.filter(
    (l) => l.kind === 'boundary' && !l.is_overview_derived && l.gpkg_layer_name,
  );

  const reset = () => {
    setStep('upload');
    setInspect(null);
    setSelectedLayer(null);
    setDisplayName('');
    setDissolveColumn('');
    setLabelField('');
    setDetailMinZoom(10);
    setCatalogSlug('');
    setStatus('');
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }
  };

  const loadLayerConfig = useCallback(async (inspectId: string, layer: GiopInspectLayer) => {
    setSelectedLayer(layer);
    setDisplayName(layer.name.replace(/[_-]+/g, ' '));
    try {
      const suggest = await suggestInspectFields(inspectId, layer.name);
      setDissolveColumn(suggest.dissolve_column ?? '');
      setLabelField(suggest.label_field ?? '');
    } catch {
      setDissolveColumn('');
      setLabelField('');
    }
  }, []);

  const handleUpload = async (file: File) => {
    setBusy(true);
    setStatus(`Inspecting ${file.name}…`);
    try {
      const result = await inspectGisUpload(file);
      setInspect(result);
      setStep('configure');
      const polygonLayer =
        result.layers.find((l) => (l.geometry_type || '').toUpperCase().includes('POLYGON')) ??
        result.layers[0];
      if (polygonLayer) {
        await loadLayerConfig(result.inspect_id, polygonLayer);
      }
      setStatus('');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Inspect failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  useEffect(() => {
    if (step !== 'configure' || !inspect || !selectedLayer || !mapContainerRef.current) return;

    let cancelled = false;
    const run = async () => {
      try {
        const geojson = await getInspectPreview(inspect.inspect_id, selectedLayer.name);
        if (cancelled || !mapContainerRef.current) return;

        if (mapRef.current) {
          mapRef.current.remove();
          mapRef.current = null;
        }

        const map = new maplibregl.Map({
          container: mapContainerRef.current,
          style: {
            version: 8,
            sources: {},
            layers: [
              {
                id: 'bg',
                type: 'background',
                paint: { 'background-color': isLightMode ? '#f1f5f9' : '#0f172a' },
              },
            ],
          },
          center: [0, 0],
          zoom: 1,
          attributionControl: false,
        });
        mapRef.current = map;

        map.on('load', () => {
          map.addSource('preview', { type: 'geojson', data: geojson });
          map.addLayer({
            id: 'preview-fill',
            type: 'fill',
            source: 'preview',
            paint: {
              'fill-color': isLightMode ? '#0ea5e9' : '#38bdf8',
              'fill-opacity': 0.2,
            },
          });
          map.addLayer({
            id: 'preview-line',
            type: 'line',
            source: 'preview',
            paint: {
              'line-color': isLightMode ? '#0369a1' : '#7dd3fc',
              'line-width': 1.5,
            },
          });
          const bounds = boundsFromGeojson(geojson);
          if (bounds) map.fitBounds(bounds, { padding: 24, maxZoom: 12 });
        });
      } catch (err) {
        if (!cancelled) {
          setStatus(err instanceof Error ? err.message : 'Preview failed');
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [step, inspect, selectedLayer, isLightMode]);

  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  const handleImport = async () => {
    if (!inspect || !selectedLayer) return;
    setBusy(true);
    setStatus('Queuing import…');
    try {
      const { job } = await commitReferenceImport({
        inspect_id: inspect.inspect_id,
        display_name: displayName.trim() || selectedLayer.name,
        source_layer: selectedLayer.name,
        dissolve_column: dissolveColumn.trim() || null,
        label_field: labelField.trim() || null,
        detail_min_zoom: detailMinZoom,
        catalog_slug: catalogSlug.trim() || null,
      });
      setStatus(`Import job ${job.id.slice(0, 8)}… queued`);
      onImported();
      reset();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`rounded-lg border p-4 space-y-4 ${card}`}>
      <div>
        <h3 className="text-sm font-semibold mb-1">Import wizard</h3>
        <p className={`text-xs ${muted}`}>
          Upload a GIS file, pick the polygon layer, configure how it dissolves when zoomed out, then
          import to the reference catalog.
        </p>
      </div>

      {step === 'upload' && (
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".gpkg,.geojson,.json,.kml,.kmz,.zip,.shp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUpload(file);
            }}
          />
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? 'Inspecting…' : 'Choose file to inspect'}
          </button>
        </div>
      )}

      {step === 'configure' && inspect && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <label className="text-xs space-y-1 block">
              <span className={muted}>Source layer</span>
              <select
                className={input}
                value={selectedLayer?.name ?? ''}
                disabled={busy}
                onChange={(e) => {
                  const layer = inspect.layers.find((l) => l.name === e.target.value);
                  if (layer) void loadLayerConfig(inspect.inspect_id, layer);
                }}
              >
                {inspect.layers.map((layer) => (
                  <option key={layer.name} value={layer.name}>
                    {layer.name} ({layer.feature_count.toLocaleString()} features)
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs space-y-1 block">
              <span className={muted}>Display name</span>
              <input
                className={input}
                value={displayName}
                disabled={busy}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>

            <label className="text-xs space-y-1 block">
              <span className={muted}>Re-import to existing catalog (optional)</span>
              <select
                className={input}
                value={catalogSlug}
                disabled={busy}
                onChange={(e) => setCatalogSlug(e.target.value)}
              >
                <option value="">Create new reference layer</option>
                {reimportTargets.map((layer) => (
                  <option key={layer.slug} value={layer.slug}>
                    {layer.display_name}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs space-y-1 block">
                <span className={muted}>Dissolve column (overview)</span>
                <select
                  className={input}
                  value={dissolveColumn}
                  disabled={busy}
                  onChange={(e) => setDissolveColumn(e.target.value)}
                >
                  <option value="">None — single zoom level</option>
                  {(selectedLayer?.fields ?? []).map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs space-y-1 block">
                <span className={muted}>Label field</span>
                <select
                  className={input}
                  value={labelField}
                  disabled={busy}
                  onChange={(e) => setLabelField(e.target.value)}
                >
                  <option value="">Auto</option>
                  {(selectedLayer?.fields ?? []).map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="text-xs space-y-1 block">
              <span className={muted}>
                Detail min zoom {dissolveColumn ? `(overview below ${detailMinZoom})` : ''}
              </span>
              <input
                type="number"
                min={0}
                max={18}
                step={1}
                className={input}
                value={detailMinZoom}
                disabled={busy || !dissolveColumn}
                onChange={(e) => setDetailMinZoom(Number(e.target.value) || 10)}
              />
            </label>

            <div className="flex flex-wrap gap-2 pt-1">
              <button type="button" className={btn} disabled={busy} onClick={() => void handleImport()}>
                {busy ? 'Working…' : 'Import to reference catalog'}
              </button>
              <button
                type="button"
                className="rounded border border-slate-500/40 px-3 py-1.5 text-sm disabled:opacity-50"
                disabled={busy}
                onClick={reset}
              >
                Cancel
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <p className={`text-xs ${muted}`}>Layer preview ({inspect.filename})</p>
            <div
              ref={mapContainerRef}
              className={`h-64 w-full rounded border ${
                isLightMode ? 'border-slate-300' : 'border-slate-600'
              }`}
            />
          </div>
        </div>
      )}

      {status && <p className={`text-xs ${muted}`}>{status}</p>}
    </div>
  );
}
