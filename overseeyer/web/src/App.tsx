import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  applyMigrations,
  createMigration,
  getLogTail,
  getMemgraphBootstrapStatus,
  getObservability,
  getSupertonicStatus,
  getTrialStatus,
  memgraphBootstrapStreamUrl,
  observabilityStreamUrl,
  restartService,
  startService,
  startStack,
  stopService,
  supertonicStartStreamUrl,
  trialRunStreamUrl,
  verifyMapTiles,
  type LogTail,
  type ObservabilitySnapshot,
  type ServiceStatus,
  type TrialRunParams,
} from './api';
import { ActionButton, LogFab, LogPanel, StatusToast, type LogPanelState } from './LogPanel';

const STATUS_DOT: Record<string, string> = {
  up: 'bg-emerald-400',
  down: 'bg-red-400',
  partial: 'bg-amber-400',
  missing: 'bg-orange-400',
  unknown: 'bg-slate-500',
};

function currentBootstrapLines(lines: string[]): string[] {
  let start = 0;
  lines.forEach((line, index) => {
    if (line.startsWith('--- bootstrap ')) start = index;
  });
  return lines.slice(start);
}

function currentTrialLines(lines: string[]): string[] {
  let start = 0;
  lines.forEach((line, index) => {
    if (line.startsWith('--- trial ')) start = index;
  });
  return lines.slice(start);
}

function currentSupertonicLines(lines: string[]): string[] {
  let start = 0;
  lines.forEach((line, index) => {
    if (line.startsWith('--- supertonic ')) start = index;
  });
  return lines.slice(start);
}

const OVERALL: Record<string, string> = {
  healthy: 'text-emerald-400',
  partial: 'text-amber-400',
  degraded: 'text-orange-400',
  offline: 'text-red-400',
};

const APM_COLORS: Record<string, string> = {
  green: 'text-emerald-400',
  amber: 'text-amber-400',
  red: 'text-red-400',
};

const CHECK_COLORS: Record<string, string> = {
  ok: 'text-emerald-400',
  pass: 'text-emerald-400',
  warn: 'text-amber-400',
  fail: 'text-red-400',
  unavailable: 'text-slate-500',
  partial: 'text-amber-400',
};

function stamp(line: string): string {
  return `${new Date().toLocaleTimeString()}  ${line}`;
}

const DEFAULT_LOG_PANEL: LogPanelState = { open: false, minimized: false, x: 24, y: 72 };

export function App() {
  const [snapshot, setSnapshot] = useState<ObservabilitySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [message, setMessage] = useState('');
  const [busyService, setBusyService] = useState<{ id: string; action: string } | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [migrationName, setMigrationName] = useState('');
  const [stackOpts, setStackOpts] = useState({ portal: true, backoffice: false, bootstrap: false });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [notifyOnDegrade, setNotifyOnDegrade] = useState(false);
  const [selectedLog, setSelectedLog] = useState<string | null>(null);
  const [logTail, setLogTail] = useState<LogTail | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logPanel, setLogPanel] = useState<LogPanelState>(DEFAULT_LOG_PANEL);
  const [activityLines, setActivityLines] = useState<string[]>([]);
  const [bootstrapLines, setBootstrapLines] = useState<string[]>([]);
  const [bootstrapRunning, setBootstrapRunning] = useState(false);
  const [trialLines, setTrialLines] = useState<string[]>([]);
  const [trialRunning, setTrialRunning] = useState(false);
  const [trialAction, setTrialAction] = useState<string | null>(null);
  const [supertonicLines, setSupertonicLines] = useState<string[]>([]);
  const [supertonicRunning, setSupertonicRunning] = useState(false);
  const [simulateCount, setSimulateCount] = useState(20);
  const [prepEmptyMaster, setPrepEmptyMaster] = useState(false);
  const [prepFreshStaging, setPrepFreshStaging] = useState(false);
  const [simulateValidation, setSimulateValidation] = useState(false);
  const prevOverall = useRef<string | null>(null);
  const bootstrapSource = useRef<EventSource | null>(null);
  const trialSource = useRef<EventSource | null>(null);
  const supertonicSource = useRef<EventSource | null>(null);
  const refreshInFlight = useRef(false);

  const hasActiveTask =
    manualRefreshing ||
    pendingAction !== null ||
    busyService !== null ||
    bootstrapRunning ||
    trialRunning ||
    supertonicRunning;

  const openLogPanel = useCallback((logName?: string | null) => {
    setLogPanel((p) => ({ ...p, open: true, minimized: false }));
    if (logName) void loadLogRef.current?.(logName);
  }, []);

  const pushActivity = useCallback((line: string) => {
    setActivityLines((prev) => [...prev.slice(-120), stamp(line)]);
  }, []);

  const loadLogRef = useRef<(name: string) => Promise<void>>(async () => {});

  const applySnapshot = useCallback(
    (data: ObservabilitySnapshot) => {
      if (
        notifyOnDegrade &&
        prevOverall.current === 'healthy' &&
        data.stack.overall !== 'healthy' &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        new Notification('OVERSEEYER', {
          body: `Stack status changed to ${data.stack.overall}`,
        });
      }
      prevOverall.current = data.stack.overall;
      setSnapshot(data);
    },
    [notifyOnDegrade],
  );

  const refreshSnapshot = useCallback(
    async (opts?: { showSpinner?: boolean }) => {
      if (refreshInFlight.current) return;
      refreshInFlight.current = true;
      if (opts?.showSpinner) setManualRefreshing(true);
      try {
        const data = await getObservability();
        applySnapshot(data);
      } catch (err) {
        setMessage(err instanceof Error ? err.message : 'Failed to load observability');
      } finally {
        setLoading(false);
        refreshInFlight.current = false;
        if (opts?.showSpinner) setManualRefreshing(false);
      }
    },
    [applySnapshot],
  );

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  const loadLog = useCallback(async (name: string) => {
    setLogLoading(true);
    setSelectedLog(name);
    try {
      setLogTail(await getLogTail(name, 200));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load log';
      setMessage(msg);
      pushActivity(`Log error: ${msg}`);
      setLogTail(null);
    } finally {
      setLogLoading(false);
    }
  }, [pushActivity]);

  loadLogRef.current = loadLog;

  const selectLog = useCallback(
    (name: string | null) => {
      if (name) void loadLog(name);
      else {
        setSelectedLog(null);
        setLogTail(null);
      }
    },
    [loadLog],
  );

  useEffect(() => {
    if (!autoRefresh) return;

    let es: EventSource | null = null;
    let pollId: number | null = null;

    const startPolling = () => {
      if (pollId !== null) return;
      pollId = window.setInterval(() => void refreshSnapshot(), 15000);
    };

    try {
      es = new EventSource(observabilityStreamUrl());
      es.onmessage = (event) => {
        try {
          applySnapshot(JSON.parse(event.data) as ObservabilitySnapshot);
        } catch {
          /* ignore malformed SSE */
        }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        startPolling();
      };
    } catch {
      startPolling();
    }

    return () => {
      es?.close();
      if (pollId !== null) window.clearInterval(pollId);
    };
  }, [autoRefresh, refreshSnapshot, applySnapshot]);

  useEffect(() => {
    if (!selectedLog || !autoRefresh || !logPanel.open) return;
    const id = window.setInterval(() => void loadLog(selectedLog), 3000);
    return () => window.clearInterval(id);
  }, [selectedLog, autoRefresh, loadLog, logPanel.open]);

  useEffect(() => {
    if (!logPanel.open || bootstrapLines.length === 0) return;
    setActivityLines((prev) => {
      const stamped = bootstrapLines.map((l) =>
        l.startsWith('--- bootstrap ') ? stamp(l) : l,
      );
      const merged = [...prev.filter((l) => !l.includes('bootstrap')), ...stamped].slice(-200);
      return merged;
    });
  }, [bootstrapLines, logPanel.open]);

  useEffect(() => {
    void getMemgraphBootstrapStatus()
      .then((s) => {
        if (!s.running) return;
        setBootstrapRunning(true);
        setMessage('Memgraph bootstrap in progress…');
        return getLogTail(s.log_name, 80).then((t) =>
          setBootstrapLines(currentBootstrapLines(t.lines)),
        );
      })
      .catch(() => {});
    return () => bootstrapSource.current?.close();
  }, []);

  useEffect(() => {
    if (!bootstrapRunning) return;
    const id = window.setInterval(() => {
      void getMemgraphBootstrapStatus().then((s) => {
        if (s.running) {
          void getLogTail(s.log_name, 80).then((t) =>
            setBootstrapLines(currentBootstrapLines(t.lines)),
          );
        } else {
          setBootstrapRunning(false);
          void refreshSnapshot();
        }
      });
    }, 3000);
    return () => window.clearInterval(id);
  }, [bootstrapRunning, refreshSnapshot]);

  const runMemgraphBootstrap = useCallback(() => {
    if (bootstrapRunning) return;
    setBootstrapLines([]);
    setBootstrapRunning(true);
    setMessage('Memgraph bootstrap…');
    pushActivity('Memgraph bootstrap started');
    openLogPanel('memgraph-bootstrap.log');
    bootstrapSource.current?.close();

    const es = new EventSource(memgraphBootstrapStreamUrl());
    bootstrapSource.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type: string;
          text?: string;
          exit_code?: number;
        };
        if (data.type === 'line' && data.text) {
          setBootstrapLines((prev) => {
            if (data.text!.startsWith('--- bootstrap ')) return [data.text!];
            return [...currentBootstrapLines(prev).slice(-400), data.text!];
          });
        } else if (data.type === 'done') {
          setBootstrapRunning(false);
          es.close();
          const doneMsg =
            data.exit_code === 0
              ? 'Memgraph bootstrap done'
              : `Memgraph bootstrap failed (exit ${data.exit_code})`;
          setMessage(doneMsg);
          pushActivity(doneMsg);
          void refreshSnapshot();
        } else if (data.type === 'error') {
          setBootstrapRunning(false);
          es.close();
          const errMsg = data.text ?? 'Memgraph bootstrap failed';
          setMessage(errMsg);
          pushActivity(errMsg);
        }
      } catch {
        /* ignore malformed SSE */
      }
    };

    es.onerror = () => {
      es.close();
      void getMemgraphBootstrapStatus().then((s) => {
        if (s.running) {
          setBootstrapRunning(true);
          setMessage('Memgraph bootstrap running — reconnect or wait for completion');
          void getLogTail(s.log_name, 80).then((t) =>
            setBootstrapLines(currentBootstrapLines(t.lines)),
          );
        } else {
          setBootstrapRunning(false);
          setMessage('Memgraph bootstrap finished');
          void refreshSnapshot();
        }
      });
    };
  }, [bootstrapRunning, refreshSnapshot, openLogPanel, pushActivity]);

  useEffect(() => {
    if (!logPanel.open || trialLines.length === 0) return;
    setActivityLines((prev) => {
      const stamped = trialLines.map((l) => (l.startsWith('--- trial ') ? stamp(l) : l));
      const merged = [...prev.filter((l) => !l.includes('--- trial ')), ...stamped].slice(-200);
      return merged;
    });
  }, [trialLines, logPanel.open]);

  useEffect(() => {
    void getTrialStatus()
      .then((s) => {
        if (!s.running) return;
        setTrialRunning(true);
        setTrialAction(s.action);
        setMessage(`Trial ${s.action ?? 'job'} in progress…`);
        return getLogTail(s.log_name, 80).then((t) =>
          setTrialLines(currentTrialLines(t.lines)),
        );
      })
      .catch(() => {});
    return () => trialSource.current?.close();
  }, []);

  useEffect(() => {
    if (!trialRunning) return;
    const id = window.setInterval(() => {
      void getTrialStatus().then((s) => {
        if (s.running) {
          void getLogTail(s.log_name, 80).then((t) =>
            setTrialLines(currentTrialLines(t.lines)),
          );
        } else {
          setTrialRunning(false);
          setTrialAction(null);
          void refreshSnapshot();
        }
      });
    }, 3000);
    return () => window.clearInterval(id);
  }, [trialRunning, refreshSnapshot]);

  const runTrialJob = useCallback(
    (params: TrialRunParams, label: string, needsConfirm = false) => {
      if (trialRunning) return;
      if (needsConfirm && !window.confirm(`${label} — this cannot be undone. Continue?`)) return;

      setTrialLines([]);
      setTrialRunning(true);
      setTrialAction(params.action);
      setMessage(`${label}…`);
      pushActivity(`${label} started`);
      openLogPanel('trial-ops.log');
      trialSource.current?.close();

      const es = new EventSource(trialRunStreamUrl({ ...params, confirm: needsConfirm || params.confirm }));
      trialSource.current = es;

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as {
            type: string;
            text?: string;
            exit_code?: number;
            action?: string;
          };
          if (data.type === 'line' && data.text) {
            setTrialLines((prev) => {
              if (data.text!.startsWith('--- trial ')) return [data.text!];
              return [...currentTrialLines(prev).slice(-400), data.text!];
            });
          } else if (data.type === 'done') {
            setTrialRunning(false);
            setTrialAction(null);
            es.close();
            const doneMsg =
              data.exit_code === 0 ? `${label} done` : `${label} failed (exit ${data.exit_code})`;
            setMessage(doneMsg);
            pushActivity(doneMsg);
            void refreshSnapshot();
          } else if (data.type === 'error') {
            setTrialRunning(false);
            setTrialAction(null);
            es.close();
            const errMsg = data.text ?? `${label} failed`;
            setMessage(errMsg);
            pushActivity(errMsg);
          }
        } catch {
          /* ignore malformed SSE */
        }
      };

      es.onerror = () => {
        es.close();
        void getTrialStatus().then((s) => {
          if (s.running) {
            setTrialRunning(true);
            setTrialAction(s.action);
            setMessage(`Trial ${s.action ?? 'job'} running — reconnect or wait`);
            void getLogTail(s.log_name, 80).then((t) =>
              setTrialLines(currentTrialLines(t.lines)),
            );
          } else {
            setTrialRunning(false);
            setTrialAction(null);
            setMessage(`${label} finished`);
            void refreshSnapshot();
          }
        });
      };
    },
    [trialRunning, refreshSnapshot, openLogPanel, pushActivity],
  );

  useEffect(() => {
    if (!logPanel.open || supertonicLines.length === 0) return;
    setActivityLines((prev) => {
      const stamped = supertonicLines.map((l) =>
        l.startsWith('--- supertonic ') ? stamp(l) : l,
      );
      const merged = [...prev.filter((l) => !l.includes('--- supertonic ')), ...stamped].slice(-200);
      return merged;
    });
  }, [supertonicLines, logPanel.open]);

  useEffect(() => {
    void getSupertonicStatus()
      .then((s) => {
        if (!s.start_job_running && s.phase === 'ready') return;
        if (!s.start_job_running && s.phase === 'down') return;
        setSupertonicRunning(Boolean(s.start_job_running) || s.phase === 'starting' || s.phase === 'warming');
        if (s.start_job_running || s.phase !== 'down') {
          setMessage(`Supertonic ${s.phase}…`);
          return getLogTail(s.log_name, 80).then((t) =>
            setSupertonicLines(currentSupertonicLines(t.lines)),
          );
        }
      })
      .catch(() => {});
    return () => supertonicSource.current?.close();
  }, []);

  useEffect(() => {
    if (!supertonicRunning) return;
    const id = window.setInterval(() => {
      void getSupertonicStatus().then((s) => {
        if (s.start_job_running || s.phase === 'starting' || s.phase === 'warming') {
          void getLogTail(s.log_name, 80).then((t) =>
            setSupertonicLines(currentSupertonicLines(t.lines)),
          );
        } else {
          setSupertonicRunning(false);
          void refreshSnapshot();
        }
      });
    }, 3000);
    return () => window.clearInterval(id);
  }, [supertonicRunning, refreshSnapshot]);

  const runSupertonicStart = useCallback(() => {
    if (supertonicRunning) return;
    setSupertonicLines([]);
    setSupertonicRunning(true);
    setMessage('Starting Supertonic…');
    pushActivity('Supertonic start');
    openLogPanel('supertonic.log');
    supertonicSource.current?.close();

    const es = new EventSource(supertonicStartStreamUrl());
    supertonicSource.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type: string;
          text?: string;
          exit_code?: number;
          phase?: string;
        };
        if (data.type === 'line' && data.text) {
          setSupertonicLines((prev) => {
            if (data.text!.startsWith('--- supertonic ')) return [data.text!];
            return [...currentSupertonicLines(prev).slice(-400), data.text!];
          });
        } else if (data.type === 'done') {
          setSupertonicRunning(false);
          es.close();
          const doneMsg =
            data.exit_code === 0 && data.phase === 'ready'
              ? 'Supertonic ready'
              : `Supertonic finished (exit ${data.exit_code}, phase ${data.phase ?? '?'})`;
          setMessage(doneMsg);
          pushActivity(doneMsg);
          void refreshSnapshot();
        } else if (data.type === 'error') {
          setSupertonicRunning(false);
          es.close();
          const errMsg = data.text ?? 'Supertonic start failed';
          setMessage(errMsg);
          pushActivity(errMsg);
        }
      } catch {
        /* ignore malformed SSE */
      }
    };

    es.onerror = () => {
      es.close();
      void getSupertonicStatus().then((s) => {
        if (s.start_job_running || s.phase === 'starting' || s.phase === 'warming') {
          setSupertonicRunning(true);
          setMessage(`Supertonic ${s.phase} — check log panel`);
          void getLogTail(s.log_name, 80).then((t) =>
            setSupertonicLines(currentSupertonicLines(t.lines)),
          );
        } else {
          setSupertonicRunning(false);
          void refreshSnapshot();
        }
      });
    };
  }, [supertonicRunning, refreshSnapshot, openLogPanel, pushActivity]);

  const requestNotifications = async () => {
    if (typeof Notification === 'undefined') return;
    await Notification.requestPermission();
    setNotifyOnDegrade(true);
  };

  const run = async (actionKey: string, label: string, fn: () => Promise<unknown>, logName?: string | null) => {
    if (pendingAction === actionKey) return;
    setPendingAction(actionKey);
    setMessage(`${label}…`);
    pushActivity(`${label} started`);
    openLogPanel(logName ?? selectedLog);
    try {
      await fn();
      const done = `${label} done`;
      setMessage(done);
      pushActivity(done);
      await refreshSnapshot();
    } catch (err) {
      const fail = err instanceof Error ? err.message : `${label} failed`;
      setMessage(fail);
      pushActivity(fail);
    } finally {
      setPendingAction(null);
    }
  };

  const serviceAction = async (id: string, action: 'start' | 'stop' | 'restart') => {
    if (busyService?.id === id && busyService.action === action) return;
    const logName = (snapshot?.logs ?? []).find((f) => f.service_id === id)?.name ?? null;
    const label = `${action} ${id}`;
    setBusyService({ id, action });
    setMessage(`${label}…`);
    pushActivity(`${label} started`);
    openLogPanel(logName);
    const fns = { start: startService, stop: stopService, restart: restartService };
    try {
      const res = (await fns[action](id)) as {
        scheduled?: boolean;
        detail?: string;
        stopped?: boolean;
      };
      const done =
        res?.detail ??
        (res?.scheduled ? `${label} scheduled` : `${label} done`);
      setMessage(done);
      pushActivity(done);
      // API stop/restart kills this connection — skip refresh that would error.
      if (res?.scheduled && id === 'overseeyer-api' && action !== 'start') {
        return;
      }
      await refreshSnapshot();
    } catch (err) {
      const fail = err instanceof Error ? err.message : `${label} failed`;
      setMessage(fail);
      pushActivity(fail);
    } finally {
      setBusyService(null);
    }
  };
  const status = snapshot?.stack ?? null;
  const migrations = snapshot?.migrations ?? null;
  const metrics = snapshot?.sync_metrics;
  const dlq = snapshot?.dlq;
  const topology = snapshot?.topology;
  const graphSync = snapshot?.graph_sync;
  const redisCheck = snapshot?.redis;
  const voiceTtsCheck = snapshot?.voice_tts;
  const dataPlane = snapshot?.data_plane;
  const mapTiles = snapshot?.map_tiles;
  const trialCheck = snapshot?.trial;
  const logFiles = snapshot?.logs ?? [];
  const applied = new Set(migrations?.applied.map((a) => a.version) ?? []);

  const sortedMigrations = useMemo(() => {
    if (!migrations) return [];
    const appliedVersions = new Set(migrations.applied.map((a) => a.version));
    return [...migrations.local].sort((a, b) => {
      const aApplied = appliedVersions.has(a.version);
      const bApplied = appliedVersions.has(b.version);
      if (aApplied !== bApplied) return aApplied ? 1 : -1;
      return a.version.localeCompare(b.version);
    });
  }, [migrations]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-wide text-cyan-300">OVERSEEYER</h1>
            <p className="text-xs text-slate-400 mt-0.5">GIOP stack health &amp; orchestration</p>
          </div>
          <div className="flex items-center gap-3 text-xs flex-wrap">
            <label className="flex items-center gap-1.5 text-slate-400">
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
              Live updates
            </label>
            <label className="flex items-center gap-1.5 text-slate-400">
              <input
                type="checkbox"
                checked={notifyOnDegrade}
                onChange={(e) => {
                  if (e.target.checked) void requestNotifications();
                  else setNotifyOnDegrade(false);
                }}
              />
              Notify on degrade
            </label>
            <ActionButton
              label="Refresh"
              loading={manualRefreshing}
              loadingLabel="Refreshing…"
              disabled={manualRefreshing}
              color="cyan"
              onClick={() => void refreshSnapshot({ showSpinner: true })}
              className="px-3 py-1.5 text-xs"
            />
            <a href="http://127.0.0.1:5173" className="text-cyan-500 hover:underline" target="_blank" rel="noreferrer">
              GIOP Portal ↗
            </a>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        <StatusToast message={message} busy={hasActiveTask} />
        {loading && !status && <p className="text-slate-500">Connecting to OVERSEEYER API…</p>}

        {status && (
          <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
            <div className="flex flex-wrap items-center gap-4">
              <div>
                <span className={`text-2xl font-semibold capitalize ${OVERALL[status.overall] ?? 'text-slate-300'}`}>
                  {status.overall}
                </span>
                <p className="text-sm text-slate-400 mt-1">
                  {status.summary.up} up · {status.summary.partial} partial · {status.summary.down} down
                </p>
              </div>
              <div className="flex flex-wrap gap-3 ml-auto items-center">
                <label className="text-xs text-slate-400 flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={stackOpts.portal}
                    onChange={(e) => setStackOpts((o) => ({ ...o, portal: e.target.checked }))}
                  />
                  Portal
                </label>
                <label className="text-xs text-slate-400 flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={stackOpts.backoffice}
                    onChange={(e) => setStackOpts((o) => ({ ...o, backoffice: e.target.checked }))}
                  />
                  Legacy UI
                </label>
                <label className="text-xs text-slate-400 flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={stackOpts.bootstrap}
                    onChange={(e) => setStackOpts((o) => ({ ...o, bootstrap: e.target.checked }))}
                  />
                  Memgraph bootstrap
                </label>
                <ActionButton
                  label="Start all offline"
                  loading={pendingAction === 'start-stack'}
                  disabled={pendingAction === 'start-stack'}
                  color="emerald"
                  onClick={() => void run('start-stack', 'Start GIOP stack', () => startStack(stackOpts))}
                  className="text-xs px-4 py-2"
                />
              </div>
            </div>
          </section>
        )}

        {snapshot && (
          <section>
            <h2 className="text-sm font-semibold text-slate-300 mb-3 uppercase tracking-wider">Observability</h2>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
              <ObsCard title="Sync gateway APM">
                {metrics?.status === 'ok' ? (
                  <>
                    <p className={`text-lg font-semibold capitalize ${APM_COLORS[metrics.apm_status ?? ''] ?? 'text-slate-300'}`}>
                      {metrics.apm_status}
                    </p>
                    <p className="text-xs text-slate-500 mt-2">
                      p50 {metrics.latency_p50_ms}ms · p95 {metrics.latency_p95_ms}ms
                    </p>
                    <p className="text-xs text-slate-500">
                      {metrics.request_count} reqs · {metrics.error_rate_pct}% errors
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-slate-500">{metrics?.reason ?? 'unavailable'}</p>
                )}
              </ObsCard>

              <ObsCard title="Topology (Postgres)">
                {topology?.status !== 'unavailable' ? (
                  <>
                    <p className={`text-lg font-semibold capitalize ${CHECK_COLORS[topology?.status ?? ''] ?? ''}`}>
                      {topology?.status}
                    </p>
                    <p className="text-xs text-slate-500 mt-2">
                      {topology?.node_count?.toLocaleString() ?? 0} nodes ·{' '}
                      {topology?.edge_count?.toLocaleString() ?? 0} edges
                      {topology?.estimate ? ' (est.)' : ''}
                    </p>
                    {topology?.hint && <p className="text-xs text-amber-500 mt-1">{topology.hint}</p>}
                  </>
                ) : (
                  <p className="text-xs text-slate-500">{topology?.reason}</p>
                )}
              </ObsCard>

              <ObsCard title="Memgraph sync">
                {graphSync?.status === 'unavailable' ? (
                  <p className="text-xs text-slate-500">{graphSync.reason ?? 'unavailable'}</p>
                ) : (
                  <>
                    <p
                      className={`text-lg font-semibold capitalize ${
                        graphSync?.in_sync
                          ? 'text-emerald-400'
                          : CHECK_COLORS[graphSync?.status ?? ''] ?? 'text-slate-300'
                      }`}
                    >
                      {graphSync?.in_sync ? 'synced' : graphSync?.status}
                    </p>
                    <p className="text-xs text-slate-500 mt-2">
                      PG {graphSync?.postgres_nodes?.toLocaleString() ?? '—'} /{' '}
                      {graphSync?.postgres_edges?.toLocaleString() ?? '—'} edges
                    </p>
                    <p className="text-xs text-slate-500">
                      MG {graphSync?.memgraph_nodes?.toLocaleString() ?? '—'} /{' '}
                      {graphSync?.memgraph_edges?.toLocaleString() ?? '—'} edges
                    </p>
                    {!graphSync?.in_sync &&
                      (graphSync?.node_delta != null || graphSync?.edge_delta != null) && (
                        <p className="text-xs text-amber-500/90 mt-1">
                          Δ nodes {graphSync.node_delta ?? 0} · Δ edges {graphSync.edge_delta ?? 0}
                        </p>
                      )}
                    {graphSync?.hint && <p className="text-xs text-amber-500 mt-1">{graphSync.hint}</p>}
                    <ActionButton
                      label="Sync Memgraph"
                      loadingLabel="Syncing Memgraph…"
                      loading={bootstrapRunning}
                      disabled={bootstrapRunning}
                      color="violet"
                      onClick={() => runMemgraphBootstrap()}
                      className="mt-3 text-xs px-3 py-1.5"
                    />
                  </>
                )}
              </ObsCard>

              <ObsCard title="Redis cache">
                {redisCheck?.status === 'disabled' ? (
                  <p className="text-xs text-slate-500">REDIS_URL not configured</p>
                ) : redisCheck?.status === 'ok' ? (
                  <>
                    <p className="text-lg font-semibold text-emerald-400">reachable</p>
                    <p className="text-xs text-slate-500 mt-2">Port {redisCheck.port ?? 6379} · sync-service graph/map cache</p>
                  </>
                ) : (
                  <>
                    <p
                      className={`text-lg font-semibold capitalize ${
                        CHECK_COLORS[redisCheck?.status ?? ''] ?? 'text-slate-300'
                      }`}
                    >
                      {redisCheck?.status ?? 'unknown'}
                    </p>
                    {redisCheck?.hint && <p className="text-xs text-amber-500 mt-1">{redisCheck.hint}</p>}
                  </>
                )}
              </ObsCard>

              <ObsCard title="Voice copilot (Supertonic)">
                {voiceTtsCheck?.status === 'ok' ? (
                  <>
                    <p className="text-lg font-semibold text-emerald-400">TTS ready</p>
                    <p className="text-xs text-slate-500 mt-2">
                      Port {voiceTtsCheck.port ?? 7788}
                      {voiceTtsCheck.pid ? ` · pid ${voiceTtsCheck.pid}` : ''}
                    </p>
                    {voiceTtsCheck.voice_api?.stt?.available === false && (
                      <p className="text-xs text-amber-500 mt-1">
                        Local Whisper STT not installed — pip install -r sync-service/requirements-voice.txt
                      </p>
                    )}
                    {voiceTtsCheck.voice_api?.tts?.available === false && (
                      <p className="text-xs text-amber-500 mt-1">
                        sync-service cannot reach Supertonic — check SUPERTONIC_URL in .env
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2 mt-3">
                      <ActionButton
                        label="View log"
                        color="slate"
                        onClick={() => openLogPanel('supertonic.log')}
                        className="text-xs px-3 py-1.5"
                      />
                      <ActionButton
                        label="Restart"
                        loadingLabel="Restarting…"
                        loading={supertonicRunning || (busyService?.id === 'supertonic' && busyService.action === 'restart')}
                        disabled={supertonicRunning}
                        color="amber"
                        onClick={() => void serviceAction('supertonic', 'restart')}
                        className="text-xs px-3 py-1.5"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <p
                      className={`text-lg font-semibold capitalize ${
                        CHECK_COLORS[voiceTtsCheck?.status ?? ''] ?? 'text-slate-300'
                      }`}
                    >
                      {voiceTtsCheck?.phase && voiceTtsCheck.phase !== 'down'
                        ? voiceTtsCheck.phase
                        : voiceTtsCheck?.status ?? 'unknown'}
                    </p>
                    {voiceTtsCheck?.installed === false && (
                      <p className="text-xs text-amber-500 mt-1">
                        Package not installed yet — first start runs pip install supertonic[serve]
                      </p>
                    )}
                    {voiceTtsCheck?.hint && (
                      <p className="text-xs text-amber-500 mt-1">{voiceTtsCheck.hint}</p>
                    )}
                    {voiceTtsCheck?.log_tail && voiceTtsCheck.log_tail.length > 0 && (
                      <p className="text-xs text-slate-500 mt-2 font-mono truncate" title={voiceTtsCheck.log_tail.join('\n')}>
                        {voiceTtsCheck.log_tail[voiceTtsCheck.log_tail.length - 1]}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2 mt-3">
                      <ActionButton
                        label="Start Supertonic"
                        loadingLabel="Starting…"
                        loading={supertonicRunning}
                        disabled={supertonicRunning}
                        color="cyan"
                        onClick={() => runSupertonicStart()}
                        className="text-xs px-3 py-1.5"
                      />
                      <ActionButton
                        label="View log"
                        color="slate"
                        onClick={() => openLogPanel('supertonic.log')}
                        className="text-xs px-3 py-1.5"
                      />
                    </div>
                  </>
                )}
              </ObsCard>

              <ObsCard title="Queues">
                {dlq?.status === 'ok' ? (
                  <p className="text-lg font-semibold text-slate-200">
                    DLQ <span className="text-amber-400">{dlq.open_count}</span> open
                  </p>
                ) : (
                  <p className="text-xs text-slate-500">{dlq?.reason ?? 'DLQ unavailable'}</p>
                )}
                <p className="text-xs text-slate-500 mt-2">
                  Staging {dataPlane?.staging_count ?? '—'} · Conflicts {dataPlane?.open_conflicts ?? '—'}
                </p>
              </ObsCard>

              <ObsCard title="Timescale">
                {dataPlane?.timescale?.reachable ? (
                  <>
                    <p className="text-lg font-semibold text-emerald-400">reachable</p>
                    <p className="text-xs text-slate-500 mt-2">
                      meter_readings: {dataPlane.timescale.meter_readings_table ? 'yes' : 'no'}
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-slate-500">{dataPlane?.timescale?.error ?? 'unavailable'}</p>
                )}
              </ObsCard>

              <ObsCard title="Map tiles (00017 / 00018)">
                {mapTiles?.status === 'unavailable' ? (
                  <p className="text-xs text-slate-500">{mapTiles.reason}</p>
                ) : (
                  <>
                    <p className={`text-lg font-semibold capitalize ${CHECK_COLORS[mapTiles?.status ?? ''] ?? ''}`}>
                      {mapTiles?.status}
                    </p>
                    <p className="text-xs text-slate-500 mt-2">
                      {mapTiles?.node_view_rows?.toLocaleString() ?? '—'} nodes ·{' '}
                      {mapTiles?.line_view_rows?.toLocaleString() ?? '—'} lines
                      {mapTiles?.has_asset_kind && mapTiles.transformer_nodes != null
                        ? ` · ${mapTiles.transformer_nodes.toLocaleString()} transformers`
                        : ''}
                    </p>
                    {mapTiles?.martin_layers && (
                      <p className="text-xs text-slate-500 mt-1">
                        Martin:{' '}
                        {Object.entries(mapTiles.martin_layers)
                          .map(([k, v]) => `${k.replace('map_', '')} ${v ? '✓' : '✗'}`)
                          .join(' · ')}
                      </p>
                    )}
                    {mapTiles?.martin_cache && (
                      <p className="text-xs text-slate-500 mt-1">
                        nginx cache :{mapTiles.martin_cache.port ?? 3002}{' '}
                        <span
                          className={
                            mapTiles.martin_cache.status === 'up'
                              ? 'text-emerald-400'
                              : 'text-amber-400'
                          }
                        >
                          {mapTiles.martin_cache.status}
                        </span>
                        {mapTiles.martin_cache.status !== 'up' && mapTiles.martin_cache.hint
                          ? ` — ${mapTiles.martin_cache.hint}`
                          : ''}
                      </p>
                    )}
                    {mapTiles?.hint && <p className="text-xs text-amber-500 mt-1">{mapTiles.hint}</p>}
                    {mapTiles?.reason && mapTiles.status !== 'pass' && (
                      <p className="text-xs text-slate-500 mt-1">{mapTiles.reason}</p>
                    )}
                    <ActionButton
                      label="Re-verify"
                      loading={pendingAction === 'verify-map-tiles'}
                      disabled={pendingAction === 'verify-map-tiles'}
                      color="cyan"
                      onClick={() => void run('verify-map-tiles', 'Verify map tiles', () => verifyMapTiles())}
                      className="mt-3 text-xs px-3 py-1.5"
                    />
                    {mapTiles?.status === 'warn' && (
                      <ActionButton
                        label="Restart Martin"
                        loading={
                          busyService?.id === 'martin' && busyService.action === 'restart'
                        }
                        loadingLabel="Restarting Martin…"
                        disabled={busyService?.id === 'martin' && busyService.action === 'restart'}
                        color="amber"
                        onClick={() => void serviceAction('martin', 'restart')}
                        className="mt-3 ml-2 text-xs px-3 py-1.5"
                      />
                    )}
                    {mapTiles?.martin_cache?.status !== 'up' && (
                      <ActionButton
                        label="Start nginx cache"
                        loading={
                          busyService?.id === 'martin-cache' &&
                          (busyService.action === 'start' || busyService.action === 'restart')
                        }
                        loadingLabel="Starting cache…"
                        disabled={
                          busyService?.id === 'martin-cache' &&
                          (busyService.action === 'start' || busyService.action === 'restart')
                        }
                        color="amber"
                        onClick={() => void serviceAction('martin-cache', 'start')}
                        className="mt-3 ml-2 text-xs px-3 py-1.5"
                      />
                    )}
                  </>
                )}
              </ObsCard>
            </div>
          </section>
        )}

        {trialCheck && (
          <section className="rounded-xl border border-violet-900/50 bg-violet-950/20 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
              <div>
                <h2 className="text-sm font-semibold text-violet-200 uppercase tracking-wider">
                  Field trial ops
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  Backup, empty master, simulate field captures, restore — dev/local only
                </p>
              </div>
              {trialRunning && (
                <span className="text-xs text-amber-400 animate-pulse">
                  Running: {trialAction ?? 'trial job'}…
                </span>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-4">
              <ObsCard title="Master network">
                <p className="text-lg font-semibold text-slate-200">
                  {trialCheck.counts?.connectivity_nodes?.toLocaleString() ?? '—'} nodes
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {trialCheck.counts?.ac_line_segments?.toLocaleString() ?? '—'} lines
                </p>
              </ObsCard>
              <ObsCard title="Staging">
                <p className="text-lg font-semibold text-slate-200">
                  {trialCheck.counts?.staging_identified_objects?.toLocaleString() ?? '—'} captures
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  DQ open: {trialCheck.counts?.dq_exceptions_open?.toLocaleString() ?? '—'}
                </p>
              </ObsCard>
              <ObsCard title="Latest backup">
                {trialCheck.latest_backup ? (
                  <>
                    <p className="text-sm font-mono text-emerald-400 truncate" title={trialCheck.latest_backup}>
                      {trialCheck.latest_backup.split('/').pop()}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      {trialCheck.backup_count ?? 0} dump(s) on disk
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-amber-500">No backup yet — run Backup first</p>
                )}
              </ObsCard>
              <ObsCard title="Prerequisites">
                <p className={`text-sm ${trialCheck.postgres_reachable ? 'text-emerald-400' : 'text-red-400'}`}>
                  Postgres {trialCheck.postgres_reachable ? 'up' : 'down'}
                </p>
                <p className={`text-sm mt-1 ${trialCheck.sync_reachable ? 'text-emerald-400' : 'text-slate-500'}`}>
                  sync-service {trialCheck.sync_reachable ? 'up' : 'down (needed for simulate)'}
                </p>
              </ObsCard>
            </div>

            <div className="flex flex-wrap gap-2 items-center">
              <ActionButton
                label="Backup DB"
                loadingLabel="Backing up…"
                loading={trialRunning && trialAction === 'backup'}
                disabled={trialRunning || bootstrapRunning}
                color="emerald"
                onClick={() => runTrialJob({ action: 'backup' }, 'Trial backup')}
                className="text-xs px-3 py-1.5"
              />
              <ActionButton
                label="Prep trial"
                loadingLabel="Preparing…"
                loading={trialRunning && trialAction === 'prep'}
                disabled={trialRunning || bootstrapRunning}
                color="violet"
                onClick={() =>
                  runTrialJob(
                    {
                      action: 'prep',
                      empty_master: prepEmptyMaster,
                      fresh_staging: prepFreshStaging,
                    },
                    'Trial prep',
                    prepEmptyMaster || prepFreshStaging,
                  )
                }
                className="text-xs px-3 py-1.5"
              />
              <ActionButton
                label="Restore latest"
                loadingLabel="Restoring…"
                loading={trialRunning && trialAction === 'restore'}
                disabled={trialRunning || bootstrapRunning || !trialCheck.latest_backup}
                color="amber"
                onClick={() => runTrialJob({ action: 'restore' }, 'Restore from backup', true)}
                className="text-xs px-3 py-1.5"
              />
              <ActionButton
                label="Clear staging"
                loadingLabel="Clearing…"
                loading={trialRunning && trialAction === 'clear_staging'}
                disabled={trialRunning || bootstrapRunning}
                color="slate"
                onClick={() => runTrialJob({ action: 'clear_staging' }, 'Clear staging', true)}
                className="text-xs px-3 py-1.5"
              />
              <ActionButton
                label="Reimport GIS"
                loadingLabel="Reimporting…"
                loading={trialRunning && trialAction === 'reimport_gis'}
                disabled={trialRunning || bootstrapRunning}
                color="cyan"
                onClick={() => runTrialJob({ action: 'reimport_gis' }, 'Reimport master from GIS')}
                className="text-xs px-3 py-1.5"
              />
              <span className="inline-flex items-center gap-2 text-xs text-slate-400 ml-2">
                <label className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={prepEmptyMaster}
                    onChange={(e) => setPrepEmptyMaster(e.target.checked)}
                    disabled={trialRunning}
                  />
                  empty master
                </label>
                <label className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={prepFreshStaging}
                    onChange={(e) => setPrepFreshStaging(e.target.checked)}
                    disabled={trialRunning}
                  />
                  fresh staging
                </label>
              </span>
            </div>

            <div className="flex flex-wrap gap-2 items-center mt-3 pt-3 border-t border-violet-900/40">
              <label className="text-xs text-slate-400 inline-flex items-center gap-1">
                Simulate
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={simulateCount}
                  onChange={(e) => setSimulateCount(Number(e.target.value) || 20)}
                  disabled={trialRunning}
                  className="w-14 rounded bg-slate-900 border border-slate-700 px-1.5 py-0.5 text-slate-200"
                />
                captures
              </label>
              <label className="text-xs text-slate-400 inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={simulateValidation}
                  onChange={(e) => setSimulateValidation(e.target.checked)}
                  disabled={trialRunning}
                />
                run validation after
              </label>
              <ActionButton
                label="Run simulator"
                loadingLabel="Simulating…"
                loading={trialRunning && trialAction === 'simulate'}
                disabled={trialRunning || bootstrapRunning || !trialCheck.sync_reachable}
                color="violet"
                onClick={() =>
                  runTrialJob(
                    {
                      action: 'simulate',
                      count: simulateCount,
                      run_validation: simulateValidation,
                    },
                    `Simulate ${simulateCount} field captures`,
                  )
                }
                className="text-xs px-3 py-1.5"
              />
            </div>
          </section>
        )}

        {status && (
          <section>
            <h2 className="text-sm font-semibold text-slate-300 mb-3 uppercase tracking-wider">Services</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {status.services.map((svc: ServiceStatus) => {
                const selfManaged = svc.id.startsWith('overseeyer-');
                const logName = logFiles.find((f) => f.service_id === svc.id)?.name;
                return (
                  <article
                    key={svc.id}
                    className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 hover:border-slate-700 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`h-2.5 w-2.5 rounded-full ${STATUS_DOT[svc.status] ?? STATUS_DOT.unknown}`} />
                      <h3 className="font-medium text-sm">{svc.name}</h3>
                    </div>
                    <p className="text-xs text-slate-500 mt-2">
                      {svc.status} · {svc.detail}
                      {svc.pid ? ` · pid ${svc.pid}` : ''}
                    </p>
                    {selfManaged && svc.id === 'overseeyer-api' && (
                      <p className="text-xs text-amber-500/90 mt-2">
                        Stop/restart disconnects this UI briefly.
                      </p>
                    )}
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      <Btn
                        label="Start"
                        color="emerald"
                        loading={busyService?.id === svc.id && busyService.action === 'start'}
                        onClick={() => void serviceAction(svc.id, 'start')}
                      />
                      <Btn
                        label="Restart"
                        color="amber"
                        loading={busyService?.id === svc.id && busyService.action === 'restart'}
                        onClick={() => void serviceAction(svc.id, 'restart')}
                      />
                      <Btn
                        label="Stop"
                        color="slate"
                        loading={busyService?.id === svc.id && busyService.action === 'stop'}
                        disabled={svc.kind === 'supabase'}
                        onClick={() => void serviceAction(svc.id, 'stop')}
                      />
                      {logName && (
                        <Btn
                          label="View log"
                          color="slate"
                          onClick={() => {
                            openLogPanel(logName);
                            void loadLog(logName);
                          }}
                        />
                      )}
                      {svc.id === 'memgraph' && (
                        <Btn
                          label="Bootstrap"
                          color="violet"
                          loading={bootstrapRunning}
                          loadingLabel="Syncing…"
                          disabled={bootstrapRunning}
                          onClick={() => runMemgraphBootstrap()}
                        />
                      )}
                      {svc.id === 'supertonic' && (
                        <Btn
                          label="Start"
                          color="violet"
                          loading={supertonicRunning}
                          loadingLabel="Starting…"
                          disabled={supertonicRunning}
                          onClick={() => runSupertonicStart()}
                        />
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {migrations && (
          <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-5">
            <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wider">Migrations</h2>
                <p className="text-xs text-slate-500 mt-1">
                  {migrations.applied_count} applied · {migrations.pending_count} pending · {migrations.local_count} files
                </p>
                {migrations.db_error && <p className="text-xs text-amber-500 mt-1">{migrations.db_error}</p>}
              </div>
              <div className="flex gap-2">
                <ActionButton
                  label="Verify map tiles"
                  loading={pendingAction === 'verify-map-tiles'}
                  disabled={pendingAction === 'verify-map-tiles'}
                  color="slate"
                  onClick={() => void run('verify-map-tiles', 'Verify map tiles', () => verifyMapTiles())}
                  className="text-xs px-3 py-1.5"
                />
                <ActionButton
                  label="Apply pending"
                  loading={pendingAction === 'apply-migrations'}
                  disabled={pendingAction === 'apply-migrations'}
                  color="cyan"
                  onClick={() =>
                    void run('apply-migrations', 'Apply migrations', async () => {
                      await applyMigrations('up', false, (status) => {
                        if (status.running) {
                          const phase = status.phase?.replace(/_/g, ' ') ?? 'in progress';
                          setMessage(`Applying migrations (${phase})…`);
                        }
                      });
                    })
                  }
                  className="text-xs px-3 py-1.5"
                />
                <ActionButton
                  label="DB reset"
                  loading={pendingAction === 'db-reset'}
                  disabled={pendingAction === 'db-reset'}
                  color="red"
                  onClick={() => {
                    if (!window.confirm('Wipe DB and re-apply all migrations?')) return;
                    void run('db-reset', 'DB reset', () =>
                      applyMigrations('reset', true, (status) => {
                        if (status.running) {
                          const phase = status.phase?.replace(/_/g, ' ') ?? 'in progress';
                          setMessage(`DB reset (${phase})…`);
                        }
                      }),
                    );
                  }}
                  className="text-xs px-3 py-1.5"
                />
              </div>
            </div>

            <div className="flex gap-2 mb-4">
              <input
                type="text"
                placeholder="new_migration_name"
                value={migrationName}
                onChange={(e) => setMigrationName(e.target.value)}
                className="text-sm flex-1 min-w-[200px] px-3 py-2 rounded border border-slate-700 bg-slate-800"
              />
              <ActionButton
                label="Create file"
                loading={pendingAction === 'create-migration'}
                disabled={pendingAction === 'create-migration' || !migrationName.trim()}
                color="violet"
                onClick={() => {
                  if (!migrationName.trim()) return;
                  void run('create-migration', 'Create migration', async () => {
                    const r = await createMigration(migrationName.trim());
                    setMigrationName('');
                    setMessage(`Created ${r.filename}`);
                  });
                }}
                className="text-xs px-4 py-2"
              />
            </div>

            <div className="overflow-auto max-h-80 rounded border border-slate-800">
              <table className="w-full text-xs">
                <thead className="bg-slate-900 sticky top-0">
                  <tr className="text-slate-500 text-left">
                    <th className="py-2 px-3">Version</th>
                    <th className="py-2 px-3">File</th>
                    <th className="py-2 px-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedMigrations.map((m) => {
                    const isApplied = applied.has(m.version);
                    return (
                      <tr key={m.filename} className={!isApplied && migrations.db_reachable ? 'text-amber-400' : 'text-slate-300'}>
                        <td className="py-1.5 px-3 font-mono">{m.version}</td>
                        <td className="py-1.5 px-3 font-mono">{m.filename}</td>
                        <td className="py-1.5 px-3">{isApplied ? 'applied' : migrations.db_reachable ? 'pending' : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      <LogPanel
        state={logPanel}
        onStateChange={(patch) => setLogPanel((p) => ({ ...p, ...patch }))}
        selectedLog={selectedLog}
        logTail={logTail}
        logLoading={logLoading}
        logFiles={logFiles}
        onSelectLog={selectLog}
        activityLines={activityLines}
        statusLine={
          pendingAction ??
          (busyService ? `${busyService.action} ${busyService.id}` : null) ??
          (supertonicRunning ? 'Supertonic start' : null) ??
          (trialRunning ? `Trial: ${trialAction ?? 'job'}` : null) ??
          (bootstrapRunning ? 'Memgraph bootstrap' : null)
        }
        busy={hasActiveTask}
      />
      {!logPanel.open && (
        <LogFab
          busy={hasActiveTask}
          onClick={() => setLogPanel((p) => ({ ...p, open: true, minimized: false }))}
        />
      )}
    </div>
  );
}

function ObsCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <h3 className="text-xs font-medium text-slate-500 uppercase tracking-wide">{title}</h3>
      <div className="mt-2">{children}</div>
    </article>
  );
}

function Btn({
  label,
  loadingLabel,
  color,
  loading,
  disabled,
  onClick,
}: {
  label: string;
  loadingLabel?: string;
  color: 'emerald' | 'amber' | 'slate' | 'violet';
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <ActionButton
      label={label}
      loadingLabel={loadingLabel}
      loading={loading}
      disabled={disabled}
      color={color}
      onClick={onClick}
      className="text-xs px-2 py-1"
    />
  );
}
