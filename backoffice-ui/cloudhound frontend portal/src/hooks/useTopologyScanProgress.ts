import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getTopologyDqRunProgress,
  type GiopTopologyScanProgress,
} from '../api/giop-api';
import { isTopologyScanTerminal } from '../components/topologyScanShared';

const POLL_MS_RUNNING = 1000;
const POLL_MS_SLOW = 2500;

export function useTopologyScanProgress(
  runId: string | null,
  enabled: boolean,
  onTerminal?: (progress: GiopTopologyScanProgress) => void,
) {
  const [progress, setProgress] = useState<GiopTopologyScanProgress | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [isTerminal, setIsTerminal] = useState(false);
  const terminalRef = useRef(false);
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;

  const reset = useCallback(() => {
    terminalRef.current = false;
    setIsTerminal(false);
    setProgress(null);
    setPollError(null);
  }, []);

  useEffect(() => {
    if (!runId) return;
    terminalRef.current = false;
    setIsTerminal(false);
  }, [runId]);

  useEffect(() => {
    if (!enabled || !runId) return;

    let cancelled = false;
    let intervalId: number | undefined;
    let slowPolls = 0;

    const applyProgress = (p: GiopTopologyScanProgress) => {
      setProgress(p);
      if (isTopologyScanTerminal(p.status) && !terminalRef.current) {
        terminalRef.current = true;
        setIsTerminal(true);
        if (intervalId) window.clearInterval(intervalId);
        onTerminalRef.current?.(p);
      }
    };

    const poll = async () => {
      try {
        const p = await getTopologyDqRunProgress(runId);
        if (cancelled) return;
        setPollError(null);
        applyProgress(p);
        slowPolls = 0;
      } catch (err) {
        if (cancelled) return;
        slowPolls += 1;
        setPollError(err instanceof Error ? err.message : 'Progress unavailable');
      }
    };

    void poll();
    intervalId = window.setInterval(() => {
      void poll();
      if (slowPolls > 3 && intervalId) {
        window.clearInterval(intervalId);
        intervalId = window.setInterval(() => void poll(), POLL_MS_SLOW);
      }
    }, POLL_MS_RUNNING);

    return () => {
      cancelled = true;
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [runId, enabled]);

  return { progress, pollError, isTerminal, reset };
}
