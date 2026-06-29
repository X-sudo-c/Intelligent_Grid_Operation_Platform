import { useCallback, useEffect, useRef, useState } from 'react';
import { GiopGisImportWizard } from './GiopGisImportWizard';
import {
  importBundledBoundaries,
  importBoundaryGeopackage,
  listGisImports,
  listReferenceLayers,
  type GiopGisImportJob,
  type GiopReferenceLayer,
} from '../api/giop-api';

interface GiopGisReferenceTabProps {
  isLightMode: boolean;
  onMapRefresh?: () => void;
}

/** Shown when catalog API is down — upload still targets ECG boundaries. */
const FALLBACK_BOUNDARY_TARGETS: Pick<GiopReferenceLayer, 'slug' | 'display_name'>[] = [
  { slug: 'ecg-admin-boundaries', display_name: 'ECG administrative boundaries' },
];

function kindBadge(kind: string, isLightMode: boolean): string {
  const base = 'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide';
  if (kind === 'boundary') {
    return `${base} ${isLightMode ? 'bg-sky-100 text-sky-800' : 'bg-sky-900/50 text-sky-200'}`;
  }
  if (kind === 'network') {
    return `${base} ${isLightMode ? 'bg-violet-100 text-violet-800' : 'bg-violet-900/50 text-violet-200'}`;
  }
  return `${base} ${isLightMode ? 'bg-slate-100 text-slate-700' : 'bg-slate-800 text-slate-300'}`;
}

function statusTone(status: string, isLightMode: boolean): string {
  if (status === 'completed') {
    return isLightMode ? 'text-emerald-700' : 'text-emerald-400';
  }
  if (status === 'failed') {
    return isLightMode ? 'text-red-700' : 'text-red-400';
  }
  if (status === 'running' || status === 'processing') {
    return isLightMode ? 'text-amber-700' : 'text-amber-400';
  }
  return isLightMode ? 'text-slate-500' : 'text-slate-400';
}

export function GiopGisReferenceTab({ isLightMode, onMapRefresh }: GiopGisReferenceTabProps) {
  const [layers, setLayers] = useState<GiopReferenceLayer[]>([]);
  const [jobs, setJobs] = useState<GiopGisImportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState('ecg-admin-boundaries');
  const fileRef = useRef<HTMLInputElement>(null);

  const card = isLightMode ? 'border-slate-200 bg-white' : 'border-slate-700 bg-slate-900/40';
  const muted = isLightMode ? 'text-slate-500' : 'text-slate-400';
  const btn = 'rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-white text-sm py-1.5 px-3';
  const btnSecondary =
    'rounded border border-cyan-700/50 hover:bg-cyan-900/20 disabled:opacity-50 text-cyan-700 dark:text-cyan-300 text-sm py-1.5 px-3';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [layerData, jobData] = await Promise.all([
        listReferenceLayers().catch((err) => {
          const message = err instanceof Error ? err.message : 'Catalog unavailable';
          setCatalogError(message);
          return [] as GiopReferenceLayer[];
        }),
        listGisImports().catch(() => [] as GiopGisImportJob[]),
      ]);
      if (layerData.length > 0) {
        setCatalogError(null);
      }
      setLayers(layerData);
      setJobs(jobData);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to load reference layers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  const catalogLayers = layers.filter((l) => l.active);
  const boundaryLayers = catalogLayers.filter((l) => l.kind === 'boundary' && l.gpkg_layer_name);
  const uploadTargets =
    boundaryLayers.length > 0
      ? boundaryLayers.map((l) => ({ slug: l.slug, display_name: l.display_name }))
      : FALLBACK_BOUNDARY_TARGETS;
  const networkLayers = catalogLayers.filter((l) => l.kind === 'network');

  const handleUpload = async (file: File) => {
    setBusy(true);
    setStatus(`Uploading ${file.name}…`);
    try {
      const { job } = await importBoundaryGeopackage(file, selectedSlug);
      setStatus(`Import job ${job.id.slice(0, 8)}… queued`);
      await load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleBundled = async () => {
    setBusy(true);
    setStatus('Importing bundled ECG boundaries from server GPKG…');
    try {
      const { job } = await importBundledBoundaries();
      setStatus(`Bundled import ${job.id.slice(0, 8)}… queued`);
      await load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Bundled import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      <div className={`rounded-lg border p-4 space-y-4 ${card}`}>
        <div>
          <h3 className="text-sm font-semibold mb-1">Reference layer import</h3>
          <p className={`text-xs ${muted}`}>
            Import GIS layers as read-only map context for field collection. Reference data lives in{' '}
            <code className="text-[10px]">gis.*</code> — it does not become CIM master until explicitly
            promoted through staging validation.
          </p>
        </div>

        {catalogError && (
          <div
            className={`rounded-md border px-3 py-2 text-xs ${
              isLightMode
                ? 'border-amber-300 bg-amber-50 text-amber-900'
                : 'border-amber-800/60 bg-amber-950/40 text-amber-100'
            }`}
          >
            Catalog API unavailable ({catalogError}). You can still upload — restart sync-service if
            imports fail: <code className="text-[10px]">./scripts/start_giop_stack.sh</code>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs space-y-1">
            <span className={`block ${muted}`}>Boundary layer</span>
            <select
              value={selectedSlug}
              onChange={(e) => setSelectedSlug(e.target.value)}
              className={`rounded border px-2 py-1.5 text-sm ${
                isLightMode ? 'border-slate-300 bg-white' : 'border-slate-600 bg-slate-900'
              }`}
              disabled={busy}
            >
              {uploadTargets.map((layer) => (
                <option key={layer.slug} value={layer.slug}>
                  {layer.display_name}
                </option>
              ))}
            </select>
          </label>

          <input
            ref={fileRef}
            type="file"
            accept=".gpkg,.geojson,.json,.kml,.kmz,.zip,.shp,application/geopackage+sqlite3,application/geo+json"
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
            {busy ? 'Working…' : 'Upload reference file'}
          </button>
          <button type="button" className={btnSecondary} disabled={busy} onClick={() => void handleBundled()}>
            Import bundled boundaries
          </button>
        </div>

        {status && <p className={`text-xs ${muted}`}>{status}</p>}
      </div>

      <GiopGisImportWizard
        isLightMode={isLightMode}
        boundaryLayers={layers}
        onImported={() => {
          void load();
          onMapRefresh?.();
        }}
      />

      <div className={`rounded-lg border p-4 ${card}`}>
        <h3 className="text-sm font-semibold mb-3">Reference layer catalog</h3>
        {loading && layers.length === 0 ? (
          <p className={`text-xs ${muted}`}>Loading…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className={muted}>
                <tr className="border-b border-slate-700/30">
                  <th className="py-2 pr-3 font-medium">Layer</th>
                  <th className="py-2 pr-3 font-medium">Kind</th>
                  <th className="py-2 pr-3 font-medium">Render</th>
                  <th className="py-2 pr-3 font-medium">Features</th>
                  <th className="py-2 font-medium">Last import</th>
                </tr>
              </thead>
              <tbody>
                {catalogLayers.map((layer) => (
                  <tr key={layer.slug} className="border-b border-slate-700/20 last:border-0">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{layer.display_name}</div>
                      {layer.description && (
                        <div className={`mt-0.5 text-[10px] ${muted}`}>{layer.description}</div>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <span className={kindBadge(layer.kind, isLightMode)}>{layer.kind}</span>
                    </td>
                    <td className="py-2 pr-3">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${
                          isLightMode ? 'bg-slate-100 text-slate-700' : 'bg-slate-800 text-slate-300'
                        }`}
                      >
                        {layer.render_mode ?? 'martin'}
                      </span>
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {layer.feature_count != null ? layer.feature_count.toLocaleString() : '—'}
                    </td>
                    <td className={`py-2 text-[10px] ${muted}`}>
                      {layer.last_imported_at
                        ? new Date(layer.last_imported_at).toLocaleString()
                        : 'Never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {networkLayers.length > 0 && (
          <p className={`mt-3 text-[10px] ${muted}`}>
            Optional network layers ({networkLayers.length}) are disabled until a full legacy GPKG
            import is run. Boundary imports via the wizard do not load conductors or transformers.
          </p>
        )}
      </div>

      <div className={`rounded-lg border p-4 ${card}`}>
        <h3 className="text-sm font-semibold mb-3">Recent import jobs</h3>
        {jobs.length === 0 ? (
          <p className={`text-xs ${muted}`}>No import jobs yet.</p>
        ) : (
          <ul className="space-y-2 text-xs">
            {jobs.map((job) => (
              <li
                key={job.id}
                className={`flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 ${
                  isLightMode ? 'border-slate-200' : 'border-slate-700/60'
                }`}
              >
                <div>
                  <span className="font-mono">{job.id.slice(0, 8)}…</span>
                  <span className={`ml-2 ${muted}`}>
                    {(job.layers ?? []).join(', ') || job.format}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {job.feature_count != null && (
                    <span className={muted}>{job.feature_count.toLocaleString()} features</span>
                  )}
                  <span className={statusTone(job.status, isLightMode)}>{job.status}</span>
                </div>
                {job.error_message && (
                  <p className={`w-full text-[10px] ${isLightMode ? 'text-red-700' : 'text-red-400'}`}>
                    {job.error_message}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
