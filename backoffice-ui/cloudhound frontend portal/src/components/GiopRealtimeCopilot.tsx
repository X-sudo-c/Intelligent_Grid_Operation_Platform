import { useCallback, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bug, Loader2, Mic, MicOff, Radio, X } from 'lucide-react';
import { useGiopRealtimeSession } from '../hooks/useGiopRealtimeSession';
import { useGiopMapOverlay } from '../context/GiopMapOverlayContext';
import { useGiopVoiceMode } from '../context/GiopVoiceModeContext';
import { buildCopilotContext } from '../lib/giopMapViewport';
import type { GiopCopilotPortalContext, GiopCopilotUiAction } from '../lib/giopCopilotTypes';

interface GiopRealtimeCopilotProps {
  isLightMode: boolean;
  portalContext: GiopCopilotPortalContext;
  onUiAction: (action: GiopCopilotUiAction) => void;
}

function isFirefoxBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /firefox/i.test(navigator.userAgent);
}

/**
 * Live speech-to-speech copilot (PoC, opt-in via VITE_GIOP_REALTIME=1).
 * Sits bottom-left so it never collides with the chained-voice FAB.
 */
export function GiopRealtimeCopilot({
  isLightMode,
  portalContext,
  onUiAction,
}: GiopRealtimeCopilotProps) {
  const { getLiveMapViewport } = useGiopMapOverlay();
  const getPortalContext = useCallback(
    () => buildCopilotContext(portalContext, getLiveMapViewport),
    [portalContext, getLiveMapViewport],
  );
  const firefoxFallback = isFirefoxBrowser();
  const voiceMode = useGiopVoiceMode();

  const {
    live,
    connecting,
    reconnecting,
    error,
    speaking,
    listening,
    muted,
    toggle,
    toggleMute,
    debugEvents,
    lastReconnectReason,
    clearDebugEvents,
    isOnline,
    isVisible,
  } = useGiopRealtimeSession({ getPortalContext, onUiAction });
  const [debugOpen, setDebugOpen] = useState(false);

  const fallbackLive = firefoxFallback && voiceMode.mapVoiceActive;
  const fallbackBusy = firefoxFallback && voiceMode.processing;
  const busy = firefoxFallback ? fallbackBusy : connecting || reconnecting;
  const stateLabel = firefoxFallback
    ? voiceMode.processing
      ? 'Processing…'
      : voiceMode.recording
        ? 'Listening…'
        : voiceMode.speaking
          ? 'Speaking…'
          : voiceMode.mapVoiceActive
            ? 'Hands-free · say a command'
            : 'Hands-free voice'
    : reconnecting
      ? 'Reconnecting…'
      : connecting
        ? 'Connecting…'
        : speaking
          ? 'Speaking…'
          : listening
            ? 'Listening…'
            : live
              ? 'Live · say a command'
              : 'Live voice (beta)';
  const recentDebugEvents = useMemo(() => debugEvents.slice(-12).reverse(), [debugEvents]);
  const active = firefoxFallback ? fallbackLive : live;
  const currentError = firefoxFallback ? voiceMode.error : error;
  const toggleVoice = firefoxFallback ? voiceMode.toggleMapVoice : toggle;

  return (
    <div className="fixed bottom-6 left-6 z-40 flex flex-col items-start gap-2">
      {debugOpen && (
        <div
          className={`w-[420px] max-w-[92vw] rounded-xl border p-3 shadow-xl ${
            isLightMode
              ? 'bg-white/95 border-slate-200 text-slate-700'
              : 'bg-slate-950/95 border-slate-700 text-slate-200'
          }`}
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold tracking-wide uppercase">
              Live voice debug timeline
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={clearDebugEvents}
                className={`text-[11px] px-2 py-1 rounded ${
                  isLightMode ? 'bg-slate-100 hover:bg-slate-200' : 'bg-slate-800 hover:bg-slate-700'
                }`}
              >
                Clear
              </button>
              <button
                type="button"
                onClick={() => setDebugOpen(false)}
                className={`text-[11px] px-2 py-1 rounded ${
                  isLightMode ? 'bg-slate-100 hover:bg-slate-200' : 'bg-slate-800 hover:bg-slate-700'
                }`}
              >
                Close
              </button>
            </div>
          </div>
          {lastReconnectReason && (
            <div className="mb-2 text-[11px]">
              Last reconnect reason: <span className="font-mono">{lastReconnectReason}</span>
            </div>
          )}
          <div className="mb-2 text-[11px]">
            Browser: <span className="font-mono">{isOnline ? 'online' : 'offline'}</span> · Tab:{' '}
            <span className="font-mono">{isVisible ? 'visible' : 'hidden'}</span>
          </div>
          <div className="max-h-64 overflow-auto space-y-1 text-[11px]">
            {recentDebugEvents.length === 0 ? (
              <div className="opacity-70">No events yet.</div>
            ) : (
              recentDebugEvents.map((evt, idx) => (
                <div
                  key={`${evt.at}-${evt.event}-${idx}`}
                  className={`rounded px-2 py-1 ${
                    evt.level === 'error'
                      ? isLightMode
                        ? 'bg-rose-50'
                        : 'bg-rose-950/40'
                      : evt.level === 'warn'
                        ? isLightMode
                          ? 'bg-amber-50'
                          : 'bg-amber-950/40'
                        : isLightMode
                          ? 'bg-slate-50'
                          : 'bg-slate-900/60'
                  }`}
                >
                  <div className="font-mono">
                    {new Date(evt.at).toLocaleTimeString()} · {evt.event}
                  </div>
                  {evt.detail && <div className="font-mono opacity-80 break-all">{evt.detail}</div>}
                </div>
              ))
            )}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
      <AnimatePresence>
        {active && !firefoxFallback && (
          <motion.button
            key="mute"
            type="button"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            onClick={toggleMute}
            aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
            className={`p-2.5 rounded-full shadow-lg transition ${
              muted
                ? 'bg-rose-500 text-white'
                : isLightMode
                  ? 'bg-white text-slate-700 hover:bg-slate-100'
                  : 'bg-premium-hover text-premium-text hover:bg-premium-sidebar'
            }`}
          >
            {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </motion.button>
        )}
      </AnimatePresence>

      <motion.button
        type="button"
        onClick={toggleVoice}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.96 }}
        aria-label={active ? 'End live voice' : 'Start live voice'}
        aria-pressed={active}
        className={`flex items-center gap-2 px-4 py-3 rounded-full shadow-2xl transition ${
          active
            ? 'bg-emerald-600 text-white shadow-emerald-500/30'
            : isLightMode
              ? 'bg-slate-900 text-white shadow-slate-900/20'
              : 'bg-premium-accent text-white shadow-black/40'
        }`}
      >
        {busy ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : active ? (
          <span className="relative flex h-5 w-5 items-center justify-center">
            <Radio className="h-5 w-5" />
            {(firefoxFallback
              ? voiceMode.recording || voiceMode.speaking
              : speaking || listening) && (
              <motion.span
                className="absolute inset-0 rounded-full bg-white/40"
                animate={{ scale: [1, 1.6, 1], opacity: [0.5, 0, 0.5] }}
                transition={{ duration: 1.1, repeat: Infinity }}
              />
            )}
          </span>
        ) : (
          <Radio className="h-5 w-5" />
        )}
        <span className="font-medium text-sm">{stateLabel}</span>
        {active && <X className="h-4 w-4 opacity-70" />}
      </motion.button>

      {currentError && (
        <span
          className={`max-w-[240px] text-xs px-2 py-1 rounded ${
            isLightMode ? 'bg-amber-50 text-amber-700' : 'bg-amber-950/50 text-amber-200'
          }`}
        >
          {currentError}
        </span>
      )}
      {!firefoxFallback && (live || error) && (
        <button
          type="button"
          onClick={() => setDebugOpen((v) => !v)}
          className={`p-2 rounded-full shadow transition ${
            isLightMode
              ? 'bg-white text-slate-700 hover:bg-slate-100'
              : 'bg-premium-hover text-premium-text hover:bg-premium-sidebar'
          }`}
          title="Open live voice debug timeline"
          aria-label="Open live voice debug timeline"
        >
          <Bug className="h-4 w-4" />
        </button>
      )}
      {firefoxFallback && (
        <span
          className={`max-w-[260px] text-[11px] px-2 py-1 rounded ${
            isLightMode ? 'bg-sky-50 text-sky-700' : 'bg-sky-950/50 text-sky-200'
          }`}
        >
          Firefox uses stable hands-free mode; Realtime WebRTC is disabled here.
        </span>
      )}
      </div>
    </div>
  );
}
