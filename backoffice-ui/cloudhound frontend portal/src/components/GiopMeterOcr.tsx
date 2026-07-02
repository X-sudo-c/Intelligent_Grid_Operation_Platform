import { useState } from 'react';
import { submitMeterOcr, submitTelemetry, createInspection } from '../api/giop-api';

interface GiopMeterOcrProps {
  isLightMode: boolean;
}

export function GiopMeterOcr({ isLightMode }: GiopMeterOcrProps) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [serial, setSerial] = useState('');
  const [kwh, setKwh] = useState('');
  const [mrid, setMrid] = useState('');
  const [status, setStatus] = useState('');
  const [statusClass, setStatusClass] = useState('text-slate-500');
  const [validationStatus, setValidationStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmitTelemetry = Boolean(mrid.trim() && parseFloat(kwh) > 0);

  const runOcr = async () => {
    if (!file) {
      setStatus('Select a meter photo first.');
      setStatusClass('text-amber-400');
      return;
    }
    setBusy(true);
    setStatus('Running OCR…');
    setStatusClass('text-slate-400');
    try {
      const data = await submitMeterOcr(file);
      setSerial(data.extracted_serial || '');
      setKwh(data.extracted_kwh != null ? String(data.extracted_kwh) : '');
      setMrid(data.meter_mrid || '');
      const serialConf = data.serial_confidence != null ? `${(data.serial_confidence * 100).toFixed(0)}%` : '—';
      const kwhConf = data.kwh_confidence != null ? `${(data.kwh_confidence * 100).toFixed(0)}%` : '—';
      const match = data.registry_match ? 'Registry match' : 'Serial not in registry — enter MRID manually';
      setStatus(`Serial conf: ${serialConf} · kWh conf: ${kwhConf} · ${match}`);
      setStatusClass(data.registry_match ? 'text-green-400' : 'text-amber-400');
      if (data.meter_mrid) {
        try {
          const inspection = await createInspection({
            assetMrid: data.meter_mrid,
            inspectorNotes: `OCR serial=${data.extracted_serial ?? ''} kwh=${data.extracted_kwh ?? ''}`,
          });
          setValidationStatus(inspection.ai_validation_status);
        } catch {
          setValidationStatus(null);
        }
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'OCR failed');
      setStatusClass('text-red-400');
    } finally {
      setBusy(false);
    }
  };

  const runTelemetry = async () => {
    if (!canSubmitTelemetry) return;
    setBusy(true);
    setStatus('Submitting telemetry…');
    setStatusClass('text-slate-400');
    try {
      await submitTelemetry(mrid.trim(), parseFloat(kwh));
      setStatus('Telemetry ingested successfully.');
      setStatusClass('text-green-400');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Telemetry failed');
      setStatusClass('text-red-400');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-auto p-6 max-w-2xl space-y-4">
      <h3 className={`text-sm font-semibold ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>Meter Reading (OCR)</h3>

      <div>
        <label className={`block text-xs mb-1 ${isLightMode ? 'text-slate-500' : 'text-premium-muted'}`}>Meter photo</label>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className={`block w-full text-sm file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 ${isLightMode ? 'text-slate-700 file:bg-slate-200' : 'text-slate-300 file:bg-slate-800 file:text-slate-200'}`}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            if (f) {
              setPreview(URL.createObjectURL(f));
            } else {
              setPreview(null);
            }
          }}
        />
      </div>

      {preview && (
        <img src={preview} alt="Preview" className="max-h-24 rounded border border-slate-700" />
      )}

      <button
        type="button"
        disabled={busy}
        onClick={() => void runOcr()}
        className="px-4 py-1.5 bg-violet-600 hover:bg-violet-500 rounded text-sm font-medium text-white disabled:opacity-50"
      >
        Extract with OCR
      </button>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <label className={`block text-xs mb-1 ${isLightMode ? 'text-slate-500' : 'text-premium-muted'}`}>Serial number</label>
          <input
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            className={`w-full rounded px-2 py-1.5 font-mono text-xs border ${isLightMode ? 'bg-white border-slate-300' : 'bg-slate-900 border-slate-700'}`}
          />
        </div>
        <div>
          <label className={`block text-xs mb-1 ${isLightMode ? 'text-slate-500' : 'text-premium-muted'}`}>kWh reading</label>
          <input
            type="number"
            step="0.001"
            value={kwh}
            onChange={(e) => setKwh(e.target.value)}
            className={`w-full rounded px-2 py-1.5 font-mono text-xs border ${isLightMode ? 'bg-white border-slate-300' : 'bg-slate-900 border-slate-700'}`}
          />
        </div>
        <div className="col-span-2">
          <label className={`block text-xs mb-1 ${isLightMode ? 'text-slate-500' : 'text-premium-muted'}`}>Meter MRID</label>
          <input
            value={mrid}
            onChange={(e) => setMrid(e.target.value)}
            placeholder="Resolved from registry or enter manually"
            className={`w-full rounded px-2 py-1.5 font-mono text-xs border ${isLightMode ? 'bg-white border-slate-300' : 'bg-slate-900 border-slate-700'}`}
          />
        </div>
      </div>

      <p className={`text-xs ${statusClass}`}>{status}</p>
      {validationStatus && (
        <p className={`text-xs ${isLightMode ? 'text-slate-600' : 'text-slate-400'}`}>
          AI validation: <span className="font-medium">{validationStatus}</span>
        </p>
      )}

      <button
        type="button"
        disabled={!canSubmitTelemetry || busy}
        onClick={() => void runTelemetry()}
        className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-medium text-white disabled:opacity-50"
      >
        Confirm &amp; Submit Telemetry
      </button>
    </div>
  );
}
