import { useCallback, useEffect, useState } from 'react';
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

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const rows = await getFieldTechnicians(staleMinutes);
      setTechnicians(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load field technicians');
    } finally {
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
