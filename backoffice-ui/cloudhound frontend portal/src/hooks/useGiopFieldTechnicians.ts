import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getFieldTechnicians,
  getTechnicianSubmissions,
  type GiopFieldTechnician,
  type GiopStagingAsset,
} from '../api/giop-api';
import { getGiopSupabaseClient } from '../lib/giopSupabaseClient';

interface UseGiopFieldTechniciansOptions {
  enabled?: boolean;
  staleMinutes?: number;
  pollMs?: number;
}

export function useGiopFieldTechnicians({
  enabled = true,
  staleMinutes = 30,
  pollMs = 20000,
}: UseGiopFieldTechniciansOptions = {}) {
  const [technicians, setTechnicians] = useState<GiopFieldTechnician[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<GiopStagingAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Realtime GPS pings arrive in bursts — coalesce refreshes instead of
  // stacking one fetch per event on top of the 20s poll.
  const inFlightRef = useRef(false);
  const rerunQueuedRef = useRef(false);
  // Skip state updates (and downstream map setData churn) when the payload
  // is identical to the previous poll.
  const lastPayloadRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    if (inFlightRef.current) {
      rerunQueuedRef.current = true;
      return;
    }
    inFlightRef.current = true;
    setLoading(true);
    setError(null);
    try {
      do {
        rerunQueuedRef.current = false;
        try {
          const rows = await getFieldTechnicians(staleMinutes);
          const payload = JSON.stringify(rows);
          if (payload !== lastPayloadRef.current) {
            lastPayloadRef.current = payload;
            setTechnicians(rows);
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to load field technicians');
        }
      } while (rerunQueuedRef.current);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [enabled, staleMinutes]);

  const loadSubmissions = useCallback(async (technicianId: string) => {
    try {
      const rows = await getTechnicianSubmissions(technicianId);
      setSubmissions(rows);
      setSelectedId(technicianId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load submissions');
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(timer);
  }, [enabled, pollMs, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    const supabase = getGiopSupabaseClient();
    const channel = supabase
      .channel('giop-field-technicians')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'field_technician_positions' },
        () => void refresh(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [enabled, refresh]);

  return {
    technicians,
    selectedId,
    submissions,
    loading,
    error,
    refresh,
    selectTechnician: loadSubmissions,
    clearSelection: () => {
      setSelectedId(null);
      setSubmissions([]);
    },
  };
}
