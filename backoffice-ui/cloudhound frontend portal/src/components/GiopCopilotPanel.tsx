import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare, Mic, MicOff, Send, Sparkles, X } from 'lucide-react';
import { portalAiChat, portalAiVoiceAudioTurn, portalAiVoiceTurn } from '../api/giop-api';
import { useGiopVoiceSession } from '../hooks/useGiopVoiceSession';
import { playCopilotSpeech, stopCopilotSpeech } from '../lib/giopVoicePlayback';
import {
  COPILOT_SUGGESTIONS,
  type GiopCopilotMessage,
  type GiopCopilotPortalContext,
  type GiopCopilotUiAction,
} from '../lib/giopCopilotTypes';
import type { GiopPortalTab } from '../lib/giopPortalRouting';

interface GiopCopilotPanelProps {
  isLightMode: boolean;
  portalContext: GiopCopilotPortalContext;
  onUiAction: (action: GiopCopilotUiAction) => void;
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function GiopCopilotPanel({
  isLightMode,
  portalContext,
  onUiAction,
}: GiopCopilotPanelProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const voiceSessionIdRef = useRef<string | undefined>(undefined);
  const [messages, setMessages] = useState<GiopCopilotMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'I can count poles and assets by district or map view, review staging captures, ' +
        'highlight territories on the map, and answer by voice. Tap the mic, speak your question, ' +
        'tap again to send (local Whisper — no Google). Example: "How many poles in Accra?"',
    },
  ]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, open]);

  const applyResponse = useCallback(
    async (
      resp: {
        content: string;
        findings?: string[];
        actions?: string[];
        ui_actions?: Array<Record<string, unknown>>;
        agent?: Record<string, unknown> & { speak?: string; session_id?: string };
      },
      pendingId: string,
    ) => {
      const uiActions = (resp.ui_actions ?? []) as GiopCopilotUiAction[];
      if (resp.agent?.session_id) {
        voiceSessionIdRef.current = String(resp.agent.session_id);
      }
      setMessages((prev) =>
        prev
          .filter((m) => m.id !== pendingId)
          .concat({
            id: newId(),
            role: 'assistant',
            content: resp.content,
            findings: resp.findings,
            actions: resp.actions,
            uiActions,
          }),
      );
      for (const action of uiActions) {
        onUiAction(action);
      }
      const speak = resp.agent?.speak ?? resp.content;
      await playCopilotSpeech(speak);
    },
    [onUiAction],
  );

  const runTextTurn = useCallback(
    async (text: string, opts?: { voice?: boolean }) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setInput('');
      setBusy(true);
      const userMsg: GiopCopilotMessage = { id: newId(), role: 'user', content: trimmed };
      const pendingId = newId();
      setMessages((prev) => [
        ...prev,
        userMsg,
        {
          id: pendingId,
          role: 'assistant',
          content: 'Thinking…',
          pending: true,
        },
      ]);
      try {
        if (opts?.voice) {
          void playCopilotSpeech('One moment.');
        }
        const resp = opts?.voice
          ? await portalAiVoiceTurn({
              text: trimmed,
              sessionId: voiceSessionIdRef.current,
              mrid: portalContext.focus_mrid ?? undefined,
              context: { ...portalContext },
            })
          : await portalAiChat({
              message: trimmed,
              mrid: portalContext.focus_mrid ?? undefined,
              context: { ...portalContext },
            });
        await applyResponse(resp, pendingId);
      } catch (err) {
        setMessages((prev) =>
          prev
            .filter((m) => m.id !== pendingId)
            .concat({
              id: newId(),
              role: 'assistant',
              content: err instanceof Error ? err.message : 'Copilot request failed',
            }),
        );
      } finally {
        setBusy(false);
      }
    },
    [applyResponse, busy, portalContext],
  );

  const send = useCallback((text: string) => runTextTurn(text), [runTextTurn]);

  const onVoiceAudioTurn = useCallback(
    async (blob: Blob) => {
      if (busy) return;
      setBusy(true);
      const pendingId = newId();
      setMessages((prev) => [
        ...prev,
        { id: pendingId, role: 'assistant', content: 'Processing…', pending: true },
      ]);
      try {
        const resp = await portalAiVoiceAudioTurn({
          audio: blob,
          sessionId: voiceSessionIdRef.current,
          mrid: portalContext.focus_mrid ?? undefined,
          context: { ...portalContext },
        });
        const transcript = String(resp.agent?.transcript ?? '').trim();
        if (transcript) {
          setMessages((prev) => [
            ...prev.filter((m) => m.id !== pendingId),
            { id: newId(), role: 'user', content: transcript },
            { id: pendingId, role: 'assistant', content: 'Thinking…', pending: true },
          ]);
        }
        await applyResponse(resp, pendingId);
        void playCopilotSpeech(resp.agent?.speak ?? resp.content);
      } catch (err) {
        setMessages((prev) =>
          prev
            .filter((m) => m.id !== pendingId)
            .concat({
              id: newId(),
              role: 'assistant',
              content: err instanceof Error ? err.message : 'Copilot request failed',
            }),
        );
      } finally {
        setBusy(false);
      }
    },
    [applyResponse, busy, portalContext],
  );

  const voice = useGiopVoiceSession({
    onAudioTurn: onVoiceAudioTurn,
    enabled: open && !busy,
  });

  const voiceStopRef = useRef(voice.stop);
  voiceStopRef.current = voice.stop;

  useEffect(() => {
    if (!open) {
      voiceStopRef.current();
      stopCopilotSpeech();
    }
  }, [open]);

  const shell = isLightMode
    ? 'border-slate-200 bg-white text-slate-900 shadow-xl'
    : 'border-[#283246] bg-premium-sidebar text-premium-text shadow-2xl';
  const muted = isLightMode ? 'text-slate-500' : 'text-premium-muted';
  const userBubble = isLightMode ? 'bg-cyan-700 text-white' : 'bg-cyan-800 text-white';
  const assistantBubble = isLightMode ? 'bg-slate-100 text-slate-900' : 'bg-premium-hover text-premium-text';

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-full bg-cyan-700 hover:bg-cyan-600 text-white px-4 py-2.5 shadow-lg"
          aria-label="Open GIOP copilot"
        >
          <Sparkles className="h-4 w-4" />
          <span className="text-sm font-medium">Copilot</span>
        </button>
      )}

      {open && (
        <div
          className={`fixed bottom-5 right-5 z-50 flex flex-col w-[min(420px,calc(100vw-2rem))] h-[min(560px,calc(100vh-6rem))] rounded-xl border ${shell}`}
        >
          <div className={`flex items-center justify-between px-4 py-3 border-b ${isLightMode ? 'border-slate-200' : 'border-[#283246]'}`}>
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-cyan-500" />
              <div>
                <p className="text-sm font-semibold">GIOP Copilot</p>
                <p className={`text-xs ${muted}`}>
                  {voice.transcribing
                    ? 'Transcribing…'
                    : voice.recording
                      ? 'Recording… tap mic when done (max 12s)'
                      : voice.pendingUtterance
                        ? 'Edit transcript, then Send'
                        : 'Tap mic · speak · tap again to review'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={`p-1 rounded ${isLightMode ? 'hover:bg-slate-100' : 'hover:bg-premium-hover'}`}
              aria-label="Close copilot"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {voice.error && (
            <p className={`px-4 py-2 text-xs ${isLightMode ? 'text-amber-700 bg-amber-50' : 'text-amber-200 bg-amber-950/40'}`}>
              {voice.error}
            </p>
          )}

          {voice.pendingUtterance && (
            <div
              className={`mx-3 mt-2 rounded-lg border px-3 py-2 space-y-2 ${
                isLightMode ? 'border-cyan-200 bg-cyan-50/80' : 'border-cyan-900/40 bg-cyan-950/30'
              }`}
            >
              <p className={`text-xs font-medium ${isLightMode ? 'text-cyan-900' : 'text-cyan-200'}`}>
                I heard:
              </p>
              <textarea
                value={voice.pendingUtterance.text}
                onChange={(e) => voice.updatePendingText(e.target.value)}
                rows={2}
                className={`w-full rounded border px-2 py-1.5 text-sm resize-none ${
                  isLightMode
                    ? 'border-slate-300 bg-white text-slate-900'
                    : 'border-[#283246] bg-premium-card text-premium-text'
                }`}
              />
              {voice.pendingUtterance.fixes && voice.pendingUtterance.fixes.length > 0 && (
                <p className={`text-[10px] ${muted}`}>
                  Auto-corrected: {voice.pendingUtterance.fixes.join(', ')}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy || !voice.pendingUtterance.text.trim()}
                  onClick={() => void voice.confirmPending()}
                  className="flex-1 rounded bg-cyan-700 hover:bg-cyan-600 text-white text-xs py-1.5 disabled:opacity-50"
                >
                  Send
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={voice.discardPending}
                  className={`rounded px-3 text-xs py-1.5 border ${
                    isLightMode
                      ? 'border-slate-300 text-slate-600 hover:bg-slate-50'
                      : 'border-[#283246] text-premium-muted hover:bg-premium-hover'
                  }`}
                >
                  Discard
                </button>
              </div>
            </div>
          )}

          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[92%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                    msg.role === 'user' ? userBubble : assistantBubble
                  } ${msg.pending ? 'opacity-70 animate-pulse' : ''}`}
                >
                  {msg.content}
                  {msg.findings && msg.findings.length > 0 && (
                    <ul className={`mt-2 text-xs space-y-0.5 ${muted}`}>
                      {msg.findings.map((f) => (
                        <li key={f}>• {f}</li>
                      ))}
                    </ul>
                  )}
                  {msg.actions && msg.actions.length > 0 && (
                    <ul className="mt-2 text-xs text-cyan-600 dark:text-cyan-300 space-y-0.5">
                      {msg.actions.map((a) => (
                        <li key={a}>→ {a}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className={`px-3 pb-2 flex flex-wrap gap-1.5 border-t pt-2 ${isLightMode ? 'border-slate-100' : 'border-[#283246]/60'}`}>
            {COPILOT_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy || voice.recording || voice.transcribing || Boolean(voice.pendingUtterance)}
                onClick={() => void send(s)}
                className={`text-[11px] px-2 py-0.5 rounded-full border disabled:opacity-50 ${
                  isLightMode
                    ? 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    : 'border-[#283246] text-premium-muted hover:bg-premium-hover'
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          <form
            className={`p-3 border-t flex gap-2 ${isLightMode ? 'border-slate-200' : 'border-[#283246]'}`}
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <button
              type="button"
              disabled={busy || voice.recording || voice.transcribing || Boolean(voice.pendingUtterance)}
              onClick={() => voice.toggle()}
              title="Tap to record, speak, tap again to send (local Whisper STT)"
              className={`rounded-lg px-3 py-2 disabled:opacity-40 ${
                voice.recording
                  ? 'bg-rose-600 hover:bg-rose-500 text-white animate-pulse'
                  : voice.transcribing
                    ? 'bg-amber-600 text-white'
                    : isLightMode
                      ? 'border border-slate-300 text-slate-700 hover:bg-slate-50'
                      : 'border border-[#283246] text-premium-text hover:bg-premium-hover'
              }`}
              aria-label={voice.recording ? 'Stop recording and send' : 'Start voice recording'}
            >
              {voice.recording ? (
                <MicOff className="h-4 w-4" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </button>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask or use the mic…"
              disabled={busy}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm disabled:opacity-50 ${
                isLightMode
                  ? 'bg-white border-slate-300 text-slate-900'
                  : 'bg-premium-bg border-[#283246] text-premium-text'
              }`}
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-white px-3 py-2"
              aria-label="Send"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </div>
      )}
    </>
  );
}

export function isGiopPortalTab(value: string): value is GiopPortalTab {
  return [
    'operations',
    'map',
    'topology',
    'combined',
    'data-quality',
    'exports',
    'references',
    'migration',
    'ocr',
    'insights',
    'schematic',
    'dlq',
    'audit',
    'cases',
    'tickets',
    'work-orders',
    'outages',
    'reports',
  ].includes(value);
}
