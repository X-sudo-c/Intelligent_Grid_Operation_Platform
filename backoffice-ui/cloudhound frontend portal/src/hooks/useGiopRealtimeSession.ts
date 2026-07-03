/**
 * Live speech-to-speech voice (PoC) — OpenAI Realtime over WebRTC.
 *
 * Hybrid design: the Realtime model handles the spoken conversation and turn
 * taking, but any map/data command is delegated to the existing chained
 * backend (`/portal/ai/voice-turn`) via a single `run_giop_command` tool. That
 * keeps the deterministic fast-path, DB tools, and map UI actions authoritative
 * while the realtime layer only owns audio + natural language.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { OpenAIRealtimeWebRTC, RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime';
import type { RealtimeItem } from '@openai/agents/realtime';
import { z } from 'zod';
import { createRealtimeSession, portalAiVoiceTurn } from '../api/giop-api';
import type { GiopCopilotPortalContext, GiopCopilotUiAction } from '../lib/giopCopilotTypes';
import { giopLog } from '../lib/giopDebugLog';

export type GiopRealtimeStatus =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'error';

/** SDK already waits ~5s before emitting disconnected, so keep app recovery fast. */
const DISCONNECT_GRACE_MS = 500;
/** Base gap between reconnect attempts (grows with backoff). */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 12000;
/** Refresh the session shortly before provider-side expiry. */
const TOKEN_REFRESH_SKEW_MS = 90_000;
const VOICE_TURN_MAX_ATTEMPTS = 2;
const VOICE_TURN_RETRY_MS = 600;
const DEBUG_EVENT_LIMIT = 80;
const SESSION_ERROR_DEDUPE_MS = 2500;

export interface GiopRealtimeDebugEvent {
  at: number;
  level: 'info' | 'warn' | 'error';
  event: string;
  detail?: string;
}

function reconnectDelayMs(attempt: number): number {
  const boundedAttempt = Math.max(1, attempt);
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (boundedAttempt - 1));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isClosedPeerConnectionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.toLowerCase().includes('peer connection is closed');
}

function normalizeRealtimeError(err: unknown): {
  message: string;
  detail?: string;
  generic: boolean;
} {
  if (err instanceof Error) {
    return { message: err.message || 'Live voice error', generic: !err.message };
  }
  if (typeof err === 'string') {
    return { message: err, generic: err.trim().toLowerCase() === 'live voice error' };
  }
  if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    const maybeMessage =
      (typeof rec.message === 'string' && rec.message) ||
      (typeof rec.error === 'string' && rec.error) ||
      (rec.error && typeof rec.error === 'object' && typeof (rec.error as Record<string, unknown>).message === 'string'
        ? String((rec.error as Record<string, unknown>).message)
        : '');
    let detail: string | undefined;
    try {
      detail = JSON.stringify(rec);
    } catch {
      detail = String(rec);
    }
    if (maybeMessage) {
      return { message: maybeMessage, detail, generic: maybeMessage.trim().toLowerCase() === 'live voice error' };
    }
    return { message: 'Live voice error', detail, generic: true };
  }
  return { message: 'Live voice error', generic: true };
}

function transportDiagnosticSnapshot(session: RealtimeSession | null): Record<string, unknown> {
  if (!session) return { transport: 'missing' };
  const transport = session.transport as unknown as {
    status?: string;
    callId?: string;
    connectionState?: {
      status?: string;
      callId?: string;
      peerConnection?: RTCPeerConnection;
      dataChannel?: RTCDataChannel;
    };
  };
  const state = transport.connectionState;
  const pc = state?.peerConnection;
  const dc = state?.dataChannel;
  return {
    transportStatus: transport.status ?? 'unknown',
    webRtcStatus: state?.status ?? null,
    callId: state?.callId ?? transport.callId ?? null,
    pcConnectionState: pc?.connectionState ?? null,
    pcIceConnectionState: pc?.iceConnectionState ?? null,
    pcIceGatheringState: pc?.iceGatheringState ?? null,
    pcSignalingState: pc?.signalingState ?? null,
    dcReadyState: dc?.readyState ?? null,
    dcBufferedAmount: typeof dc?.bufferedAmount === 'number' ? dc.bufferedAmount : null,
  };
}

function peerDiagnosticSnapshot(peerConnection: RTCPeerConnection): Record<string, unknown> {
  return {
    pcConnectionState: peerConnection.connectionState,
    pcIceConnectionState: peerConnection.iceConnectionState,
    pcIceGatheringState: peerConnection.iceGatheringState,
    pcSignalingState: peerConnection.signalingState,
  };
}

const AGENT_INSTRUCTIONS = `
You are the GIOP grid copilot for Ghana ECG, speaking with a GIS data steward.
Keep replies short and conversational — this is a live voice call.

You control a map and grid database ONLY through the run_giop_command tool.
Whenever the user asks to see, zoom, pan, highlight, or count anything on the
map or in the data (districts, regions, towns, poles, transformers, staging
captures, feeders, work orders in view), call run_giop_command with their request phrased plainly,
e.g. "zoom into Dome", "highlight Accra", "how many poles in Kumasi",
"what work orders are in view".
For relative zoom on the current map view (not a named place), pass the command
verbatim: "zoom in", "zoom out", "zoom in a bit", "zoom out more" — do not add
place names or rephrase as "zoom to …".
For "take me to" or "go to" a named place, pass it plainly, e.g. "take me to Roman Ridge".
For work orders in a named area, pass the place explicitly, e.g. "work orders in Accra".
To pan to a work order pin on the map, say "pan to the work order node".
For feeder connections, pass the feeder name or id plainly, e.g. "show connections on the Mallam feeder".
To trace the line segments from the node you just inspected, say "trace the connection path".
The tool moves the map and returns the factual answer — read that answer back
naturally. Never invent counts, place names, or map actions; always rely on the
tool result. For general questions you can answer directly.
`.trim();

function historyTextSummary(items: RealtimeItem[], limit = 8): string {
  const lines: string[] = [];
  for (const item of items.slice(-limit)) {
    if (item.type !== 'message') continue;
    const role = item.role === 'user' ? 'User' : 'Assistant';
    const text = (item.content ?? [])
      .map((part) => {
        if (part.type === 'input_text' || part.type === 'output_text') {
          return part.text;
        }
        if (part.type === 'input_audio' || part.type === 'output_audio') {
          return part.transcript ?? '';
        }
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
    if (text) lines.push(`${role}: ${text}`);
  }
  return lines.join('\n');
}

/**
 * Realtime history replay is strict: function calls cannot be re-added, message
 * statuses cannot be "in_progress", and audio parts cannot be replayed with
 * null audio bytes. Restore only completed text-bearing messages.
 */
function restorableHistory(items: RealtimeItem[]): RealtimeItem[] {
  const restored: RealtimeItem[] = [];
  for (const item of items) {
    if (item.type !== 'message') continue;

    const content = (item.content ?? [])
      .map((part) => {
        if (part.type === 'input_text' || part.type === 'output_text') {
          const text = (part.text ?? '').trim();
          return text ? { type: part.type, text } : null;
        }
        if (part.type === 'input_audio' || part.type === 'output_audio') {
          const transcript = (part.transcript ?? '').trim();
          if (!transcript) return null;
          return {
            type: item.role === 'user' ? 'input_text' : 'output_text',
            text: transcript,
          };
        }
        return null;
      })
      .filter(Boolean);

    if (content.length === 0) continue;
    restored.push({
      ...item,
      status: item.status === 'incomplete' ? 'incomplete' : 'completed',
      content,
    } as RealtimeItem);
  }
  return restored;
}

interface UseGiopRealtimeSessionOptions {
  getPortalContext: () => GiopCopilotPortalContext;
  onUiAction: (action: GiopCopilotUiAction) => void;
  onTranscript?: (role: 'user' | 'assistant', text: string) => void;
}

export function useGiopRealtimeSession({
  getPortalContext,
  onUiAction,
  onTranscript,
}: UseGiopRealtimeSessionOptions) {
  const [status, setStatus] = useState<GiopRealtimeStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [muted, setMuted] = useState(false);
  const [debugEvents, setDebugEvents] = useState<GiopRealtimeDebugEvent[]>([]);
  const [isOnline, setIsOnline] = useState<boolean>(() => navigator.onLine);
  const [isVisible, setIsVisible] = useState<boolean>(() => document.visibilityState === 'visible');

  const sessionRef = useRef<RealtimeSession | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const ctxRef = useRef(getPortalContext);
  const uiActionRef = useRef(onUiAction);
  const transcriptRef = useRef(onTranscript);
  ctxRef.current = getPortalContext;
  uiActionRef.current = onUiAction;
  transcriptRef.current = onTranscript;

  const intentLiveRef = useRef(false);
  const intentionalCloseRef = useRef(false);
  const reconnectingRef = useRef(false);
  const reconnectQueuedRef = useRef(false);
  const toolInFlightRef = useRef(false);
  const attemptsRef = useRef(0);
  const sessionEpochRef = useRef(0);
  const disconnectGraceTimerRef = useRef<number | undefined>(undefined);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const tokenRefreshTimerRef = useRef<number | undefined>(undefined);
  const historySnapshotRef = useRef<RealtimeItem[]>([]);
  const conversationMemoryRef = useRef<string>('');
  const lastReconnectReasonRef = useRef<string | null>(null);
  const lastSessionErrorRef = useRef<{ key: string; at: number } | null>(null);
  const openSessionRef = useRef<() => Promise<void>>(async () => undefined);
  const scheduleRecoveryRef = useRef<(reason?: string) => void>(() => undefined);
  const performReconnectRef = useRef<(reason?: string) => void>(() => undefined);

  const pushDebugEvent = useCallback(
    (
      level: GiopRealtimeDebugEvent['level'],
      event: string,
      detail?: unknown,
    ) => {
      let detailText: string | undefined;
      if (typeof detail === 'string') detailText = detail;
      else if (detail != null) {
        try {
          detailText = JSON.stringify(detail);
        } catch {
          detailText = String(detail);
        }
      }
      if (level === 'error') giopLog.realtime.error(event, detail);
      else if (level === 'warn') giopLog.realtime.warn(event, detail);
      else giopLog.realtime.info(event, detail);
      setDebugEvents((prev) => {
        const next = [
          ...prev,
          { at: Date.now(), level, event, detail: detailText },
        ];
        if (next.length > DEBUG_EVENT_LIMIT) {
          return next.slice(next.length - DEBUG_EVENT_LIMIT);
        }
        return next;
      });
    },
    [],
  );

  const snapshotHistory = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    try {
      const items = session.history;
      if (items.length > 0) {
        historySnapshotRef.current = JSON.parse(JSON.stringify(restorableHistory(items)));
        const summary = historyTextSummary(items);
        if (summary) conversationMemoryRef.current = summary;
      }
    } catch {
      /* best-effort */
    }
  }, []);

  const buildAgent = useCallback(() => {
    const memory = conversationMemoryRef.current.trim();
    const instructions = memory
      ? `${AGENT_INSTRUCTIONS}\n\nContinue this ongoing conversation naturally:\n${memory}`
      : AGENT_INSTRUCTIONS;

    const runGiopCommand = tool({
      name: 'run_giop_command',
      description:
        'Execute a map or grid-data command (pan/zoom/highlight/count/trace) and ' +
        'return the factual result. Use for anything touching the map or ECG data.',
      parameters: z.object({
        command: z
          .string()
          .describe('The user request in plain words, e.g. "zoom into Dome".'),
      }),
      async execute({ command }: { command: string }) {
        toolInFlightRef.current = true;
        snapshotHistory();
        pushDebugEvent('info', 'tool_command_started', { command });
        try {
          const ctx = ctxRef.current();
          let resp: Awaited<ReturnType<typeof portalAiVoiceTurn>> | null = null;
          let lastErr: unknown = null;
          for (let attempt = 1; attempt <= VOICE_TURN_MAX_ATTEMPTS; attempt += 1) {
            try {
              resp = await portalAiVoiceTurn({
                text: command,
                sessionId: sessionIdRef.current,
                mrid: ctx.focus_mrid ?? undefined,
                context: { ...ctx } as Record<string, unknown>,
              });
              pushDebugEvent('info', 'tool_command_succeeded', { attempt });
              break;
            } catch (err) {
              lastErr = err;
              pushDebugEvent(
                'warn',
                'tool_command_attempt_failed',
                err instanceof Error ? { attempt, error: err.message } : { attempt, error: String(err) },
              );
              if (attempt < VOICE_TURN_MAX_ATTEMPTS) {
                await wait(VOICE_TURN_RETRY_MS);
                continue;
              }
            }
          }
          if (!resp) throw lastErr instanceof Error ? lastErr : new Error('Voice command failed');

          if (resp.agent?.session_id) {
            sessionIdRef.current = String(resp.agent.session_id);
          }
          const uiActions = (resp.ui_actions ?? []) as GiopCopilotUiAction[];
          for (const action of uiActions) uiActionRef.current(action);
          const spoken = resp.agent?.speak ?? resp.content ?? 'Done.';
          setError(null);
          transcriptRef.current?.('assistant', spoken);
          conversationMemoryRef.current = [
            conversationMemoryRef.current,
            `User: ${command}`,
            `Assistant: ${spoken}`,
          ]
            .filter(Boolean)
            .slice(-12)
            .join('\n');
          return spoken;
        } catch (err) {
          const reason = err instanceof Error ? err.message : 'unknown error';
          const fallback =
            'I hit a temporary backend issue while checking that node, but I am still connected. Please ask again.';
          setError(`Voice command failed: ${reason}`);
          pushDebugEvent('error', 'tool_command_failed', reason);
          transcriptRef.current?.('assistant', fallback);
          conversationMemoryRef.current = [
            conversationMemoryRef.current,
            `User: ${command}`,
            `Assistant: ${fallback}`,
          ]
            .filter(Boolean)
            .slice(-12)
            .join('\n');
          return fallback;
        } finally {
          toolInFlightRef.current = false;
        }
      },
    });

    return new RealtimeAgent({
      name: 'GIOP Live Copilot',
      instructions,
      tools: [runGiopCommand],
    });
  }, [pushDebugEvent, snapshotHistory]);

  const clearTimers = useCallback(() => {
    window.clearTimeout(disconnectGraceTimerRef.current);
    window.clearTimeout(reconnectTimerRef.current);
    disconnectGraceTimerRef.current = undefined;
    reconnectTimerRef.current = undefined;
    reconnectQueuedRef.current = false;
  }, []);

  const closeSession = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      try {
        session.close();
      } catch {
        /* ignore */
      }
    }
  }, []);

  const openSession = useCallback(async () => {
    pushDebugEvent('info', 'session_open_started');
    const token = await createRealtimeSession();
    pushDebugEvent('info', 'session_token_minted', {
      model: token.model,
      expiresAt: token.expires_at ?? null,
    });
    const expiresAtMs = (token.expires_at ?? 0) * 1000;
    if (expiresAtMs > 0) {
      const delay = Math.max(5_000, expiresAtMs - Date.now() - TOKEN_REFRESH_SKEW_MS);
      pushDebugEvent('info', 'token_refresh_scheduled', { delayMs: delay });
      window.clearTimeout(tokenRefreshTimerRef.current);
      tokenRefreshTimerRef.current = window.setTimeout(() => {
        if (!intentLiveRef.current || reconnectingRef.current || reconnectQueuedRef.current) return;
        if (toolInFlightRef.current) {
          // Avoid disrupting an active tool turn; try again shortly.
          pushDebugEvent('warn', 'token_refresh_delayed_tool_in_flight');
          window.clearTimeout(tokenRefreshTimerRef.current);
          tokenRefreshTimerRef.current = window.setTimeout(() => {
            performReconnectRef.current('token_refresh_retry');
          }, 5_000);
          return;
        }
        performReconnectRef.current('token_refresh');
      }, delay);
    }

    const agent = buildAgent();
    const sessionEpoch = ++sessionEpochRef.current;
    const transport = new OpenAIRealtimeWebRTC({
      changePeerConnection(peerConnection) {
        pushDebugEvent('info', 'rtc_peer_created', peerDiagnosticSnapshot(peerConnection));
        peerConnection.addEventListener('connectionstatechange', () => {
          pushDebugEvent('warn', 'rtc_peer_connection_state_change', peerDiagnosticSnapshot(peerConnection));
        });
        peerConnection.addEventListener('iceconnectionstatechange', () => {
          pushDebugEvent('warn', 'rtc_ice_connection_state_change', peerDiagnosticSnapshot(peerConnection));
        });
        peerConnection.addEventListener('icegatheringstatechange', () => {
          pushDebugEvent('info', 'rtc_ice_gathering_state_change', peerDiagnosticSnapshot(peerConnection));
        });
        peerConnection.addEventListener('signalingstatechange', () => {
          pushDebugEvent('info', 'rtc_signaling_state_change', peerDiagnosticSnapshot(peerConnection));
        });
        peerConnection.addEventListener('icecandidateerror', (event) => {
          pushDebugEvent('error', 'rtc_ice_candidate_error', {
            url: event.url,
            errorCode: event.errorCode,
            errorText: event.errorText,
          });
        });
        return peerConnection;
      },
    });
    const session = new RealtimeSession(agent, {
      model: token.model,
      transport,
      config: {
        outputModalities: ['audio'],
        audio: {
          input: {
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turnDetection: {
              type: 'semantic_vad',
              // "low" waits longer between phrases — better for hands-free pauses.
              eagerness: 'low',
              createResponse: true,
              interruptResponse: true,
            },
          },
        },
      },
    });
    sessionRef.current = session;

    try {
      session.on('history_updated', () => {
        snapshotHistory();
      });
    } catch {
      /* optional */
    }

    try {
      session.transport.on('connection_change', (connStatus: string) => {
        if (sessionEpochRef.current !== sessionEpoch) return;
        if (intentionalCloseRef.current) return;
        pushDebugEvent('info', 'transport_connection_change', {
          status: connStatus,
          online: navigator.onLine,
          visibility: document.visibilityState,
          toolInFlight: toolInFlightRef.current,
          rtc: transportDiagnosticSnapshot(session),
        });

        if (connStatus === 'connected') {
          clearTimers();
          attemptsRef.current = 0;
          reconnectingRef.current = false;
          lastReconnectReasonRef.current = null;
          setStatus('live');
          setError(null);
          pushDebugEvent('info', 'transport_connected', {
            rtc: transportDiagnosticSnapshot(session),
          });
          return;
        }

        if (connStatus !== 'disconnected') return;
        if (!intentLiveRef.current) return;

        setSpeaking(false);
        setListening(false);
        snapshotHistory();
        scheduleRecoveryRef.current('transport_disconnected');
      });
    } catch {
      /* connection tracking is best-effort */
    }

    try {
      session.transport.on('turn_started', () => setSpeaking(true));
      session.transport.on('turn_done', () => {
        setSpeaking(false);
        snapshotHistory();
      });
      session.transport.on('audio_done', () => setSpeaking(false));
      session.transport.on('*', (event: { type?: string }) => {
        const t = event?.type ?? '';
        if (t === 'input_audio_buffer.speech_started') setListening(true);
        else if (t === 'input_audio_buffer.speech_stopped') setListening(false);
      });
    } catch {
      /* transport event wiring is best-effort for the wave UI */
    }

    try {
      session.on('audio_interrupted', () => setSpeaking(false));
    } catch {
      /* optional */
    }
    session.on('error', (err: unknown) => {
      if (sessionEpochRef.current !== sessionEpoch) return;
      const normalized = normalizeRealtimeError(err);
      const transportStatus = (() => {
        try {
          return session.transport.status;
        } catch {
          return 'unknown';
        }
      })();
      const key = `${normalized.message}|${normalized.detail ?? ''}|${transportStatus}`;
      const now = Date.now();
      const last = lastSessionErrorRef.current;
      if (last && last.key === key && now - last.at < SESSION_ERROR_DEDUPE_MS) {
        return;
      }
      lastSessionErrorRef.current = { key, at: now };

      // Connected+generic errors are usually transient transport noise right after reconnect.
      if (normalized.generic && (transportStatus === 'connected' || transportStatus === 'connecting')) {
        pushDebugEvent('warn', 'session_error_ignored_generic', {
          transportStatus,
          detail: normalized.detail,
          rtc: transportDiagnosticSnapshot(session),
        });
        return;
      }

      setError(normalized.message);
      pushDebugEvent('error', 'session_error', {
        message: normalized.message,
        transportStatus,
        detail: normalized.detail,
        rtc: transportDiagnosticSnapshot(session),
      });
      // Do not reconnect on every error — wait for a confirmed disconnect event.
    });

    await session.connect({ apiKey: token.value });
    pushDebugEvent('info', 'session_connected', {
      rtc: transportDiagnosticSnapshot(session),
    });

    if (historySnapshotRef.current.length > 0) {
      pushDebugEvent('info', 'history_restore_skipped_summary_used', {
        messageCount: historySnapshotRef.current.length,
      });
    }

    setStatus('live');
  }, [buildAgent, clearTimers, pushDebugEvent, snapshotHistory]);
  openSessionRef.current = openSession;

  const performReconnect = useCallback((reason = 'unspecified') => {
    if (!intentLiveRef.current || reconnectingRef.current || reconnectQueuedRef.current) return;

    lastReconnectReasonRef.current = reason;
    reconnectQueuedRef.current = true;
    setStatus('reconnecting');
    const nextAttempt = attemptsRef.current + 1;
    const delayMs = reconnectDelayMs(nextAttempt);
    pushDebugEvent('warn', 'reconnect_scheduled', {
      reason,
      attempt: nextAttempt,
      delayMs,
      rtc: transportDiagnosticSnapshot(sessionRef.current),
    });

    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = window.setTimeout(() => {
      void (async () => {
        reconnectQueuedRef.current = false;
        reconnectingRef.current = true;
        attemptsRef.current = nextAttempt;
        pushDebugEvent('warn', 'reconnect_attempt_started', {
          reason: lastReconnectReasonRef.current,
          attempt: nextAttempt,
          rtcBeforeClose: transportDiagnosticSnapshot(sessionRef.current),
        });
        intentionalCloseRef.current = true;
        closeSession();
        intentionalCloseRef.current = false;

        try {
          await openSessionRef.current();
          reconnectingRef.current = false;
          pushDebugEvent('info', 'reconnect_attempt_succeeded', {
            attempt: nextAttempt,
            rtc: transportDiagnosticSnapshot(sessionRef.current),
          });
        } catch (err) {
          reconnectingRef.current = false;
          if (isClosedPeerConnectionError(err)) {
            attemptsRef.current = 0;
          }
          setError(
            err instanceof Error
              ? `${err.message} (retrying…)`
              : 'Reconnect failed (retrying…)',
          );
          pushDebugEvent(
            'error',
            'reconnect_attempt_failed',
            {
              error: err instanceof Error ? err.message : String(err),
              closedPeerRace: isClosedPeerConnectionError(err),
            },
          );
          performReconnectRef.current(
            isClosedPeerConnectionError(err)
              ? 'closed_peer_retry_after_failure'
              : 'reconnect_retry_after_failure',
          );
        }
      })();
    }, delayMs);
  }, [closeSession, pushDebugEvent]);
  performReconnectRef.current = performReconnect;

  const scheduleRecovery = useCallback((reason = 'unknown_disconnect') => {
    if (!intentLiveRef.current || reconnectingRef.current) return;
    window.clearTimeout(disconnectGraceTimerRef.current);
    pushDebugEvent('warn', 'recovery_grace_started', { reason, graceMs: DISCONNECT_GRACE_MS });

    disconnectGraceTimerRef.current = window.setTimeout(() => {
      if (!intentLiveRef.current || reconnectingRef.current) return;
      if (!navigator.onLine) {
        pushDebugEvent('warn', 'recovery_paused_offline', { reason });
        scheduleRecoveryRef.current('offline_wait');
        return;
      }
      if (document.visibilityState !== 'visible') {
        pushDebugEvent('warn', 'recovery_paused_tab_hidden', { reason });
        scheduleRecoveryRef.current('tab_hidden_wait');
        return;
      }
      if (toolInFlightRef.current) {
        pushDebugEvent('warn', 'recovery_delayed_tool_in_flight', { reason });
        scheduleRecoveryRef.current('tool_in_flight');
        return;
      }
      const liveSession = sessionRef.current;
      if (liveSession) {
        try {
          const transportStatus = liveSession.transport.status;
          if (transportStatus === 'connected' || transportStatus === 'connecting') {
            pushDebugEvent('info', 'recovery_cancelled_transport_healthy', {
              reason,
              status: transportStatus,
            });
            return;
          }
        } catch {
          /* fall through to reconnect */
        }
      }
      performReconnectRef.current(reason);
    }, DISCONNECT_GRACE_MS);
  }, [pushDebugEvent]);
  scheduleRecoveryRef.current = scheduleRecovery;

  const disconnect = useCallback(() => {
    pushDebugEvent('info', 'manual_disconnect');
    intentLiveRef.current = false;
    reconnectingRef.current = false;
    attemptsRef.current = 0;
    clearTimers();
    window.clearTimeout(tokenRefreshTimerRef.current);
    tokenRefreshTimerRef.current = undefined;
    intentionalCloseRef.current = true;
    closeSession();
    intentionalCloseRef.current = false;
    setSpeaking(false);
    setListening(false);
    setMuted(false);
    setStatus('idle');
  }, [clearTimers, closeSession, pushDebugEvent]);

  const connect = useCallback(async () => {
    if (sessionRef.current || reconnectingRef.current) return;
    pushDebugEvent('info', 'manual_connect');
    intentLiveRef.current = true;
    attemptsRef.current = 0;
    setError(null);
    setStatus('connecting');
    try {
      await openSessionRef.current();
    } catch (err) {
      intentLiveRef.current = false;
      intentionalCloseRef.current = true;
      closeSession();
      intentionalCloseRef.current = false;
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Could not start live voice');
      pushDebugEvent(
        'error',
        'connect_failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }, [closeSession, pushDebugEvent]);

  const toggleMute = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    try {
      const next = !muted;
      session.mute(next);
      setMuted(next);
    } catch {
      /* transport may not support muting */
    }
  }, [muted]);

  const toggle = useCallback(() => {
    if (sessionRef.current || reconnectingRef.current) disconnect();
    else void connect();
  }, [connect, disconnect]);

  useEffect(() => () => disconnect(), [disconnect]);

  useEffect(() => {
    const onOnline = () => {
      setIsOnline(true);
      pushDebugEvent('info', 'browser_online');
      if (intentLiveRef.current && !sessionRef.current && !reconnectingRef.current) {
        performReconnectRef.current('browser_online');
      }
    };
    const onOffline = () => {
      setIsOnline(false);
      pushDebugEvent('warn', 'browser_offline');
    };
    const onVisibility = () => {
      const visible = document.visibilityState === 'visible';
      setIsVisible(visible);
      pushDebugEvent('info', visible ? 'tab_visible' : 'tab_hidden');
      if (visible && intentLiveRef.current && !sessionRef.current && !reconnectingRef.current) {
        performReconnectRef.current('tab_became_visible');
      }
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pushDebugEvent]);

  return {
    status,
    live: status === 'live' || status === 'reconnecting',
    connecting: status === 'connecting',
    reconnecting: status === 'reconnecting',
    error,
    speaking,
    listening,
    muted,
    connect,
    disconnect,
    toggle,
    toggleMute,
    debugEvents,
    lastReconnectReason: lastReconnectReasonRef.current,
    clearDebugEvents: () => setDebugEvents([]),
    isOnline,
    isVisible,
  };
}
