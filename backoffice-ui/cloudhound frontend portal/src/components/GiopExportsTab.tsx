import { useCallback, useEffect, useState } from 'react';
import {
  createCimExport,
  createDxfExport,
  createFormatExport,
  downloadExportUrl,
  EXPORT_FORMAT_LABELS,
  listCimExports,
  type GiopExportFormat,
  type GiopExportJob,
} from '../api/giop-api';

interface GiopExportsTabProps {
  isLightMode: boolean;
}

const PHASE1: GiopExportFormat[] = ['geopackage', 'kml', 'shapefile'];
const PHASE2: GiopExportFormat[] = ['csv'];
const PHASE3: GiopExportFormat[] = ['cim-rdf', 'cim-xml'];
const PHASE4: GiopExportFormat[] = ['mdms-csv', 'sap-csv'];

function downloadLabel(job: GiopExportJob): string {
  const fmt = job.format ?? 'cim-json';
  const labels: Record<string, string> = {
    'cim-json': 'export.cim.json',
    dxf: 'export.dxf',
    geopackage: 'export.gpkg',
    kml: 'export.kml',
    shapefile: 'export_shapefile.zip',
    csv: 'export_csv.zip',
    'cim-xml': 'export.cim.xml',
    'cim-rdf': 'export.cim.rdf.xml',
    'mdms-csv': 'export_mdms.csv',
    'sap-csv': 'export_sap.csv',
  };
  return labels[fmt] ?? fmt;
}

export function GiopExportsTab({ isLightMode }: GiopExportsTabProps) {
  const [jobs, setJobs] = useState<GiopExportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const card = isLightMode ? 'border-slate-200 bg-white' : 'border-premium-border/70 bg-premium-card';
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const btn = 'rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-white text-sm py-1.5 px-3';
  const btnSecondary = 'rounded border border-cyan-700/50 hover:bg-cyan-900/20 disabled:opacity-50 text-cyan-700 dark:text-cyan-300 text-sm py-1.5 px-3';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setJobs(await listCimExports());
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Failed to load exports');
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  const startExport = async (key: string, fn: () => Promise<{ job: GiopExportJob }>) => {
    setBusy(key);
    setStatus(`Starting ${EXPORT_FORMAT_LABELS[key] ?? key} export…`);
    try {
      const { job } = await fn();
      setStatus(`${EXPORT_FORMAT_LABELS[key] ?? key} job ${job.id.slice(0, 8)}… queued`);
      await load();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setBusy(null);
    }
  };

  const renderPhase = (title: string, formats: GiopExportFormat[]) => (
    <div className="space-y-2">
      <p className={`text-xs font-semibold uppercase ${muted}`}>{title}</p>
      <div className="flex flex-wrap gap-2">
        {formats.map((fmt) => (
          <button
            key={fmt}
            type="button"
            disabled={busy !== null}
            onClick={() => void startExport(fmt, () => createFormatExport(fmt))}
            className={btnSecondary}
          >
            {busy === fmt ? 'Starting…' : `→ ${EXPORT_FORMAT_LABELS[fmt] ?? fmt}`}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      <div className={`rounded-lg border p-4 space-y-4 ${card}`}>
        <div>
          <h3 className="text-sm font-semibold mb-1">Master data export</h3>
          <p className={`text-xs ${muted}`}>
            Export approved master data. Default clip: Ghana bbox. DQ-blocked assets excluded.
          </p>
        </div>

        <div className="space-y-2">
          <p className={`text-xs font-semibold uppercase ${muted}`}>Core formats</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void startExport('cim-json', createCimExport)}
              className={btn}
            >
              {busy === 'cim-json' ? 'Starting…' : 'Export → CIM JSON'}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void startExport('dxf', createDxfExport)}
              className={btn}
            >
              {busy === 'dxf' ? 'Starting…' : 'Export → AutoCAD DXF'}
            </button>
          </div>
        </div>

        {renderPhase('Phase 1 — GIS vector', PHASE1)}
        {renderPhase('Phase 2 — Tabular', PHASE2)}
        {renderPhase('Phase 3 — CIM XML', PHASE3)}
        {renderPhase('Phase 4 — Integration batches', PHASE4)}

        {status && <p className={`text-xs ${muted}`}>{status}</p>}
      </div>

      <div className={`rounded-lg border overflow-hidden ${card}`}>
        <div className={`px-3 py-2 text-xs font-semibold uppercase ${isLightMode ? 'bg-slate-100 text-slate-600' : 'bg-slate-800 text-slate-400'}`}>
          Export jobs {loading ? '(loading…)' : `(${jobs.length})`}
        </div>
        <table className="w-full text-xs">
          <thead className={isLightMode ? 'bg-slate-50 text-slate-600' : 'bg-slate-900 text-slate-400'}>
            <tr>
              <th className="text-left px-3 py-2">Created</th>
              <th className="text-left px-3 py-2">Format</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Features</th>
              <th className="text-left px-3 py-2">Download</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} className={`border-t ${isLightMode ? 'border-slate-200' : 'border-premium-border/80'}`}>
                <td className="px-3 py-2 whitespace-nowrap">
                  {job.created_at ? new Date(job.created_at).toLocaleString() : '—'}
                </td>
                <td className="px-3 py-2">{EXPORT_FORMAT_LABELS[job.format ?? 'cim-json'] ?? job.format ?? 'cim-json'}</td>
                <td className="px-3 py-2">{job.status}</td>
                <td className="px-3 py-2">{job.feature_count ?? '—'}</td>
                <td className="px-3 py-2">
                  {job.status === 'completed' ? (
                    <a href={downloadExportUrl(job.id)} className="text-cyan-600 hover:underline" download>
                      {downloadLabel(job)}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
            {!loading && jobs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                  No export jobs yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
