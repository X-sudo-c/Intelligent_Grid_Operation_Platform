import { useCallback, useEffect, useState } from 'react';
import {
  listMigrationFailed,
  listMigrationRuns,
  migrateDxf,
  migrateGeopackage,
  type GiopMigrationFailed,
  type GiopMigrationRun,
} from '../api/giop-api';

interface GiopMigrationTabProps {
  isLightMode: boolean;
}

type SourceFormat = 'dxf' | 'geopackage';

export function GiopMigrationTab({ isLightMode }: GiopMigrationTabProps) {
  const [runs, setRuns] = useState<GiopMigrationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [failed, setFailed] = useState<GiopMigrationFailed[]>([]);

  const [format, setFormat] = useState<SourceFormat>('dxf');
  const [sourceName, setSourceName] = useState('dxf-import');
  const [dxfText, setDxfText] = useState('');
  const [filePath, setFilePath] = useState('');
  const [gpkgTable, setGpkgTable] = useState('');
  const [applyAffine, setApplyAffine] = useState(true);
  const [anchorLon, setAnchorLon] = useState('-0.2');
  const [anchorLat, setAnchorLat] = useState('5.6');
  const [scale, setScale] = useState('0.0001');
  const [rotation, setRotation] = useState('0');

  const card = isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/70 bg-premium-card';
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const input = `w-full rounded border px-2 py-1 text-xs ${
    isLightMode ? 'border-slate-300 bg-white' : 'border-slate-700 bg-slate-800 text-slate-100'
  }`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRuns(await listMigrationRuns());
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to load runs');
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const viewFailed = useCallback(async (runId: string) => {
    setSelected(runId);
    try {
      setFailed(await listMigrationFailed(runId));
    } catch {
      setFailed([]);
    }
  }, []);

  const affine = applyAffine
    ? {
        anchor_lon: Number(anchorLon),
        anchor_lat: Number(anchorLat),
        scale: Number(scale),
        rotation_deg: Number(rotation),
      }
    : undefined;

  const handleRun = async () => {
    setBusy(true);
    setStatus('Running migration…');
    try {
      const result =
        format === 'dxf'
          ? await migrateDxf({
              dxf_text: dxfText || undefined,
              file_path: dxfText ? undefined : filePath || undefined,
              source_name: sourceName,
              apply_affine: applyAffine,
              affine,
              requested_by: 'portal',
            })
          : await migrateGeopackage({
              file_path: filePath,
              table: gpkgTable || undefined,
              source_name: sourceName,
              apply_affine: applyAffine,
              affine,
              requested_by: 'portal',
            });
      setStatus(
        `Run ${result.run_id.slice(0, 8)}… ${result.status}: ${result.committed} committed, ${result.failed} failed`,
      );
      await load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Migration failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      <div className={`rounded-lg border p-4 ${card}`}>
        <h3 className="text-sm font-semibold mb-1">Migration adapter (FR-017)</h3>
        <p className={`text-xs mb-3 ${muted}`}>
          Parse AutoCAD DXF (POINT / LINE) or GeoPackage geometry, georeference with an affine
          transform, validate, and commit valid features to staging. Failures route to the
          migration DLQ.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="text-xs space-y-1">
            <span className={muted}>Source format</span>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as SourceFormat)}
              className={input}
            >
              <option value="dxf">AutoCAD DXF</option>
              <option value="geopackage">GeoPackage</option>
            </select>
          </label>
          <label className="text-xs space-y-1">
            <span className={muted}>Source name</span>
            <input value={sourceName} onChange={(e) => setSourceName(e.target.value)} className={input} />
          </label>
        </div>

        {format === 'dxf' ? (
          <label className="text-xs space-y-1 block mt-3">
            <span className={muted}>DXF text (paste) — or use a server file path below</span>
            <textarea
              value={dxfText}
              onChange={(e) => setDxfText(e.target.value)}
              rows={4}
              placeholder="0&#10;POINT&#10;8&#10;POLES&#10;10&#10;..."
              className={`${input} font-mono`}
            />
          </label>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          <label className="text-xs space-y-1">
            <span className={muted}>{format === 'dxf' ? 'Server file path (optional)' : 'GeoPackage file path'}</span>
            <input value={filePath} onChange={(e) => setFilePath(e.target.value)} className={input} />
          </label>
          {format === 'geopackage' ? (
            <label className="text-xs space-y-1">
              <span className={muted}>Layer / table (optional)</span>
              <input value={gpkgTable} onChange={(e) => setGpkgTable(e.target.value)} className={input} />
            </label>
          ) : null}
        </div>

        <label className="flex items-center gap-2 text-xs mt-3">
          <input type="checkbox" checked={applyAffine} onChange={(e) => setApplyAffine(e.target.checked)} />
          <span>Apply affine georeferencing</span>
        </label>

        {applyAffine ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-2">
            <label className="text-xs space-y-1">
              <span className={muted}>Anchor lon</span>
              <input value={anchorLon} onChange={(e) => setAnchorLon(e.target.value)} className={input} />
            </label>
            <label className="text-xs space-y-1">
              <span className={muted}>Anchor lat</span>
              <input value={anchorLat} onChange={(e) => setAnchorLat(e.target.value)} className={input} />
            </label>
            <label className="text-xs space-y-1">
              <span className={muted}>Scale (deg/unit)</span>
              <input value={scale} onChange={(e) => setScale(e.target.value)} className={input} />
            </label>
            <label className="text-xs space-y-1">
              <span className={muted}>Rotation (°)</span>
              <input value={rotation} onChange={(e) => setRotation(e.target.value)} className={input} />
            </label>
          </div>
        ) : null}

        <button
          type="button"
          disabled={busy}
          onClick={() => void handleRun()}
          className="mt-3 rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-white text-sm py-1.5 px-3"
        >
          {busy ? 'Running…' : 'Run migration'}
        </button>
        {status && <p className={`text-xs mt-2 ${muted}`}>{status}</p>}
      </div>

      <div className={`rounded-lg border overflow-hidden ${card}`}>
        <div className={`px-3 py-2 text-xs font-semibold uppercase ${isLightMode ? 'bg-slate-100 text-slate-600' : 'bg-slate-800 text-slate-400'}`}>
          Migration runs {loading ? '(loading…)' : `(${runs.length})`}
        </div>
        <table className="w-full text-xs">
          <thead className={isLightMode ? 'bg-slate-50 text-slate-600' : 'bg-slate-900 text-slate-400'}>
            <tr>
              <th className="text-left px-3 py-2">Started</th>
              <th className="text-left px-3 py-2">Source</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Features</th>
              <th className="text-left px-3 py-2">Committed</th>
              <th className="text-left px-3 py-2">Failed</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.id}
                onClick={() => void viewFailed(run.id)}
                className={`border-t cursor-pointer ${isLightMode ? 'border-slate-200 hover:bg-slate-50' : 'border-slate-800 hover:bg-premium-hover/50'} ${
                  selected === run.id ? (isLightMode ? 'bg-slate-100' : 'bg-slate-800/70') : ''
                }`}
              >
                <td className="px-3 py-2 whitespace-nowrap">
                  {run.started_at ? new Date(run.started_at).toLocaleString() : '—'}
                </td>
                <td className="px-3 py-2">
                  <span className="uppercase text-[10px] mr-1 opacity-70">{run.source_format}</span>
                  {run.source_name}
                </td>
                <td className="px-3 py-2">{run.status}</td>
                <td className="px-3 py-2">{run.feature_count}</td>
                <td className="px-3 py-2 text-emerald-500">{run.committed_count}</td>
                <td className="px-3 py-2 text-rose-500">{run.failed_count}</td>
              </tr>
            ))}
            {!loading && runs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  No migration runs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className={`rounded-lg border overflow-hidden ${card}`}>
          <div className={`px-3 py-2 text-xs font-semibold uppercase ${isLightMode ? 'bg-slate-100 text-slate-600' : 'bg-slate-800 text-slate-400'}`}>
            Failed elements — run {selected.slice(0, 8)}… ({failed.length})
          </div>
          <table className="w-full text-xs">
            <thead className={isLightMode ? 'bg-slate-50 text-slate-600' : 'bg-slate-900 text-slate-400'}>
              <tr>
                <th className="text-left px-3 py-2">Source ref</th>
                <th className="text-left px-3 py-2">Primitive</th>
                <th className="text-left px-3 py-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {failed.map((row) => (
                <tr key={row.id} className={`border-t ${isLightMode ? 'border-slate-200' : 'border-premium-border/80'}`}>
                  <td className="px-3 py-2 whitespace-nowrap">{row.source_ref}</td>
                  <td className="px-3 py-2">{row.primitive}</td>
                  <td className="px-3 py-2 text-rose-500">{row.error_message}</td>
                </tr>
              ))}
              {failed.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-slate-500">
                    No failed elements for this run.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
