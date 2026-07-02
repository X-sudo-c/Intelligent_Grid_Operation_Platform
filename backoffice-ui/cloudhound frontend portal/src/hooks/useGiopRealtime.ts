import { useEffect, useRef } from 'react';
import { getGiopSupabaseClient } from '../lib/giopSupabaseClient';

interface UseGiopRealtimeOptions {
  onStagingChange?: (reason: string) => void;
  onMasterChange?: (reason: string) => void;
  enabled?: boolean;
}

export function useGiopRealtime({
  onStagingChange,
  onMasterChange,
  enabled = true,
}: UseGiopRealtimeOptions) {
  // Callers pass inline callbacks; keep the latest in refs so the websocket
  // channel is created once per `enabled` flip, not torn down on every render.
  const onStagingChangeRef = useRef(onStagingChange);
  const onMasterChangeRef = useRef(onMasterChange);
  onStagingChangeRef.current = onStagingChange;
  onMasterChangeRef.current = onMasterChange;

  useEffect(() => {
    if (!enabled) return;

    const supabase = getGiopSupabaseClient();

    const channel = supabase
      .channel('giop-grid-portal')
      .on(
        'postgres_changes',
        { event: '*', schema: 'staging', table: 'connectivity_nodes' },
        (payload) => onStagingChangeRef.current?.(`staging nodes ${payload.eventType}`),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'staging', table: 'identified_objects' },
        (payload) => onStagingChangeRef.current?.(`staging assets ${payload.eventType}`),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'connectivity_nodes' },
        (payload) => onMasterChangeRef.current?.(`nodes ${payload.eventType}`),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ac_line_segments' },
        (payload) => onMasterChangeRef.current?.(`lines ${payload.eventType}`),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'identified_objects' },
        (payload) => onMasterChangeRef.current?.(`assets ${payload.eventType}`),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [enabled]);
}
