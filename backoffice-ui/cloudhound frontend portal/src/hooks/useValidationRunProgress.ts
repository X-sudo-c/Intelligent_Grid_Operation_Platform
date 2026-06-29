import { useCallback, useEffect, useRef, useState } from 'react';
import { getValidationRunProgress, type GiopValidationProgress } from '../api/giop-api';

const POLL_MS_RUNNING = 800;
const POLL_MS_SLOW = 2000;

function isTerminalStatus(status?: string | null): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function useValidationRunProgress(
  runId: string | null,
  enabled: boolean,
  onTerminal?: (progress: GiopValidationProgress) => void,
) {
  const [progress, setProgress] = useState<GiopValidationProgress | null>(null);
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
    if (!runId || runId === 'pending') {
      return;
    }
    terminalRef.current = false;
    setIsTerminal(false);
  }, [runId]);

  useEffect(() => {
    if (!enabled || !runId || runId === 'pending') {
      return;
    }

    let cancelled = false;
    let intervalId: number | undefined;
    let slowPolls = 0;

    const applyProgress = (p: GiopValidationProgress) => {
      setProgress(p);
      if (isTerminalStatus(p.status) && !terminalRef.current) {
        terminalRef.current = true;
        setIsTerminal(true);
        if (intervalId) window.clearInterval(intervalId);
        onTerminalRef.current?.(p);
      }
    };

    const poll = async () => {
      try {
        const p = await getValidationRunProgress(runId);
        if (cancelled) return;
        setPollError(null);
        applyProgress(p);
        slowPolls = 0;
      } catch (err) {
        if (cancelled) return;
        slowPolls += 1;
        const msg = err instanceof Error ? err.message : 'Progress unavailable';
        setPollError(msg);
        setProgress((prev) => {
          if (prev && isTerminalStatus(prev.status)) return prev;
          return (
            prev ?? {
              run_id: runId,
              status: 'running',
              current_phase: 'starting',
            }
          );
        });
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

  useEffect(() => {
    if (!enabled && !isTerminal) {
      setProgress(null);
      setPollError(null);
    }
  }, [enabled, isTerminal]);

  return { progress, pollError, isTerminal, reset };
}

export async function fetchValidationRunProgressOnce(
  runId: string,
): Promise<GiopValidationProgress> {
  return getValidationRunProgress(runId);
}
