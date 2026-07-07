import { useEffect, useMemo, useState } from 'react';
import { getCopilotProgress } from '../api/giop-api';
import { buildThinkingSteps } from '../components/CopilotMessageContent';

export function useCopilotThinkingProgress(
  requestId: string | undefined,
  query: string,
  active: boolean,
): { steps: string[]; activeIndex: number } {
  const [serverSteps, setServerSteps] = useState<Array<{ label: string; status?: string }>>([]);

  useEffect(() => {
    if (!active) {
      setServerSteps([]);
      return;
    }
    if (!requestId) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const resp = await getCopilotProgress(requestId);
        if (!cancelled && Array.isArray(resp.steps)) {
          setServerSteps(
            resp.steps.map((s) => ({
              label: String(s.label ?? ''),
              status: s.status ? String(s.status) : undefined,
            })),
          );
        }
      } catch {
        /* ignore — fallback steps still show */
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 600);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, requestId]);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active || serverSteps.length > 0) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 1800);
    return () => window.clearInterval(timer);
  }, [active, serverSteps.length]);

  return useMemo(() => {
    const built = buildThinkingSteps(query, serverSteps);
    if (serverSteps.length === 0 && active) {
      const idx = Math.min(Math.floor(tick), built.steps.length - 1);
      return { steps: built.steps, activeIndex: idx };
    }
    return built;
  }, [query, serverSteps, active, tick]);
}
