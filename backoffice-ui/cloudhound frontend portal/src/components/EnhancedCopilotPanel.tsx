import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, Send, Sparkles, X, Bot, User } from 'lucide-react';
import { portalAiVoiceTurn } from '../api/giop-api';
import { useGiopVoiceSession } from '../hooks/useGiopVoiceSession';
import { playCopilotSpeech, stopCopilotSpeech } from '../lib/giopVoicePlayback';
import {
  COPILOT_SUGGESTIONS,
  describeCopilotUiAction,
  type GiopCopilotMessage,
  type GiopCopilotPortalContext,
  type GiopCopilotUiAction,
} from '../lib/giopCopilotTypes';
import { slideUp, staggerContainer, fadeUpItem } from '../lib/motion';

interface EnhancedCopilotPanelProps {
  isLightMode: boolean;
  portalContext: GiopCopilotPortalContext;
  onUiAction: (action: GiopCopilotUiAction) => void;
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Enhanced AI Copilot panel with premium animations:
 * - Smooth slide-up panel entrance
 * - Staggered message animations
 * - Typing indicator with pulsing dots
 * - Voice recording pulse effect
 * - Message bubble spring animations
 * - Gradient glow effects for AI messages
 */
export function EnhancedCopilotPanel({
  isLightMode,
  portalContext,
  onUiAction,
}: EnhancedCopilotPanelProps) {
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
      // Surface what the assistant actually did (map moves, tab switches) so
      // UI actions never happen silently.
      const actionLines = [
        ...(resp.actions ?? []),
        ...uiActions.map(describeCopilotUiAction),
      ];
      setMessages((prev) =>
        prev
          .filter((m) => m.id !== pendingId)
          .concat({
            id: newId(),
            role: 'assistant',
            content: resp.content,
            findings: resp.findings,
            actions: actionLines,
            uiActions,
          }),
      );
      for (const action of uiActions) {
        onUiAction(action);
      }
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
        // All turns use voice-turn: transcript normalization, fast-path map
        // commands (highlight/pan/count), then steward chat fallback — no LLM
        // required for simple commands even when typed.
        const resp = await portalAiVoiceTurn({
          text: trimmed,
          sessionId: voiceSessionIdRef.current,
          mrid: portalContext.focus_mrid ?? undefined,
          context: { ...portalContext } as Record<string, unknown>,
        });
        await applyResponse(resp, pendingId);
        if (opts?.voice) {
          const speak = resp.agent?.speak ?? resp.content;
          await playCopilotSpeech(speak);
        }
      } catch (e) {
        const err = e instanceof Error ? e.message : 'Failed to get response';
        setMessages((prev) =>
          prev
            .filter((m) => m.id !== pendingId)
            .concat({
              id: newId(),
              role: 'assistant',
              content: `Error: ${err}`,
            }),
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, portalContext, applyResponse],
  );

  const voice = useGiopVoiceSession({
    onUtterance: (text) => runTextTurn(text, { voice: true }),
    enabled: open && !busy,
  });
  const { recording, transcribing, error: voiceError, toggle: toggleVoice } = voice;

  // Closing the panel must silence the assistant: stop any in-progress
  // recording and cut TTS playback.
  const voiceStopRef = useRef(voice.stop);
  voiceStopRef.current = voice.stop;
  useEffect(() => {
    if (!open) {
      voiceStopRef.current();
      stopCopilotSpeech();
    }
  }, [open]);

  const suggestions = COPILOT_SUGGESTIONS;
  const handleSuggestion = (q: string) => runTextTurn(q);

  const bubbleBase = `max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed`;
  const userBubble = `${bubbleBase} ${isLightMode ? 'bg-indigo-600 text-white' : 'bg-indigo-500 text-white'}`;
  const aiBubble = `${bubbleBase} ${isLightMode ? 'bg-slate-100 border border-slate-200 text-slate-800' : 'bg-premium-hover border border-[#364258] text-premium-text'}`;

  return (
    <>
      {/* Floating Action Button */}
      <motion.button
        type="button"
        onClick={() => setOpen((s) => !s)}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        className={`fixed bottom-6 right-6 z-40 flex items-center gap-2 px-4 py-3 rounded-full shadow-2xl transition ${
          isLightMode
            ? 'bg-indigo-600 text-white shadow-indigo-500/30'
            : 'bg-indigo-500 text-white shadow-indigo-500/20'
        } ${open ? 'ring-2 ring-offset-2 ring-indigo-400' : ''}`}
      >
        <AnimatePresence mode="wait">
          {open ? (
            <motion.div key="close" initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: 90, opacity: 0 }}>
              <X className="h-5 w-5" />
            </motion.div>
          ) : (
            <motion.div key="open" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} className="flex items-center gap-2">
              <Sparkles className="h-5 w-5" />
              <span className="font-medium">AI Copilot</span>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.button>

      {/* Panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={slideUp}
            className={`fixed bottom-24 right-6 z-40 w-96 max-w-[calc(100vw-3rem)] rounded-2xl border shadow-2xl overflow-hidden ${
              isLightMode
                ? 'bg-white border-slate-200 shadow-slate-900/10'
                : 'bg-premium-sidebar border-[#283246] shadow-black/40'
            }`}
          >
            {/* Header with gradient */}
            <div className={`px-4 py-3 border-b ${isLightMode ? 'border-slate-200 bg-gradient-to-r from-indigo-50 to-white' : 'border-premium-border bg-gradient-to-r from-premium-accent-muted/40 to-premium-sidebar'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <motion.div
                    animate={{ rotate: [0, 5, -5, 0] }}
                    transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
                  >
                    <Bot className={`h-5 w-5 ${isLightMode ? 'text-indigo-600' : 'text-indigo-400'}`} />
                  </motion.div>
                  <div>
                    <span className={`font-medium ${isLightMode ? 'text-slate-800' : 'text-premium-text-secondary'}`}>Grid Copilot</span>
                    <p className={`text-[11px] ${isLightMode ? 'text-slate-500' : 'text-premium-muted'}`}>
                      {transcribing
                        ? 'Transcribing…'
                        : recording
                          ? 'Recording… tap mic to send (max 12s)'
                          : busy
                            ? 'Thinking…'
                            : 'Tap mic · speak · tap again to send'}
                    </p>
                  </div>
                </div>
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={() => setOpen(false)}
                  className={`p-1.5 rounded-full ${isLightMode ? 'hover:bg-slate-100' : 'hover:bg-premium-hover'}`}
                >
                  <X className="h-4 w-4" />
                </motion.button>
              </div>
            </div>

            {voiceError && (
              <p
                className={`px-4 py-2 text-xs ${
                  isLightMode ? 'text-amber-700 bg-amber-50' : 'text-amber-200 bg-amber-950/40'
                }`}
              >
                {voiceError}
              </p>
            )}

            {/* Messages */}
            <div
              ref={scrollRef}
              className="h-80 overflow-y-auto p-4 space-y-4"
              aria-live="polite"
              aria-relevant="additions"
            >
              <AnimatePresence initial={false}>
                {messages.map((m, i) => (
                  <motion.div
                    key={m.id}
                    initial={{ opacity: 0, y: 16, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ type: 'spring', stiffness: 300, damping: 25, delay: i * 0.05 }}
                    className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div className={`flex gap-2 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                      <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ delay: 0.1, type: 'spring', stiffness: 400 }}
                        className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                          m.role === 'user'
                            ? isLightMode ? 'bg-slate-200' : 'bg-slate-700'
                            : isLightMode ? 'bg-indigo-100' : 'bg-indigo-900/30'
                        }`}
                      >
                        {m.role === 'user' ? (
                          <User className="h-4 w-4" />
                        ) : (
                          <Sparkles className={`h-4 w-4 ${isLightMode ? 'text-indigo-600' : 'text-indigo-400'}`} />
                        )}
                      </motion.div>
                      <div className={m.role === 'user' ? userBubble : aiBubble}>
                        {m.pending ? (
                          <div className="flex items-center gap-1 py-1">
                            <motion.span
                              animate={{ opacity: [0.4, 1, 0.4] }}
                              transition={{ duration: 1, repeat: Infinity, delay: 0 }}
                              className="w-2 h-2 rounded-full bg-current"
                            />
                            <motion.span
                              animate={{ opacity: [0.4, 1, 0.4] }}
                              transition={{ duration: 1, repeat: Infinity, delay: 0.2 }}
                              className="w-2 h-2 rounded-full bg-current"
                            />
                            <motion.span
                              animate={{ opacity: [0.4, 1, 0.4] }}
                              transition={{ duration: 1, repeat: Infinity, delay: 0.4 }}
                              className="w-2 h-2 rounded-full bg-current"
                            />
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <p>{m.content}</p>
                            {m.findings && m.findings.length > 0 && (
                              <motion.ul
                                initial="hidden"
                                animate="visible"
                                variants={staggerContainer}
                                className="text-xs space-y-1 mt-2 opacity-80"
                              >
                                {m.findings.map((f, fi) => (
                                  <motion.li key={fi} variants={fadeUpItem} className="flex items-start gap-1">
                                    <span>•</span>
                                    <span>{f}</span>
                                  </motion.li>
                                ))}
                              </motion.ul>
                            )}
                            {m.actions && m.actions.length > 0 && (
                              <motion.ul
                                initial="hidden"
                                animate="visible"
                                variants={staggerContainer}
                                className={`text-xs space-y-1 mt-2 ${isLightMode ? 'text-indigo-600' : 'text-indigo-300'}`}
                              >
                                {m.actions.map((a, ai) => (
                                  <motion.li key={ai} variants={fadeUpItem} className="flex items-start gap-1">
                                    <span>→</span>
                                    <span>{a}</span>
                                  </motion.li>
                                ))}
                              </motion.ul>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>

            {/* Suggestions */}
            {messages.length <= 2 && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className={`px-4 pb-2 ${isLightMode ? 'border-t border-slate-100' : 'border-t border-slate-800'}`}
              >
                <p className={`text-xs mt-3 mb-2 ${isLightMode ? 'text-slate-500' : 'text-slate-500'}`}>Try asking:</p>
                <div className="flex flex-wrap gap-2">
                  {suggestions.slice(0, 3).map((s, i) => (
                    <motion.button
                      key={i}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.4 + i * 0.1 }}
                      whileHover={{ scale: 1.02, y: -1 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => handleSuggestion(s)}
                      className={`text-xs px-3 py-1.5 rounded-full border transition ${
                        isLightMode
                          ? 'border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 text-slate-600'
                          : 'border-slate-700 hover:border-indigo-600 hover:bg-indigo-950/30 text-slate-400'
                      }`}
                    >
                      {s}
                    </motion.button>
                  ))}
                </div>
              </motion.div>
            )}

            {/* Input */}
            <div className={`p-3 border-t ${isLightMode ? 'border-slate-200 bg-slate-50' : 'border-[#283246] bg-[#0b0f14]'}`}>
              <div className="flex items-center gap-2">
                <motion.button
                  type="button"
                  onClick={toggleVoice}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  disabled={busy || transcribing}
                  aria-label={recording ? 'Stop recording and send' : 'Start voice recording'}
                  className={`relative p-2.5 rounded-full transition ${
                    recording
                      ? 'bg-rose-500 text-white'
                      : transcribing
                        ? 'bg-amber-500 text-white'
                        : isLightMode
                          ? 'bg-slate-200 hover:bg-slate-300 text-slate-700'
                          : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                  } ${busy || transcribing ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {recording ? (
                    <>
                      <MicOff className="h-4 w-4" />
                      {/* Recording pulse effect */}
                      <motion.span
                        className="absolute inset-0 rounded-full bg-rose-500"
                        animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
                        transition={{ duration: 1, repeat: Infinity }}
                      />
                    </>
                  ) : (
                    <Mic className="h-4 w-4" />
                  )}
                </motion.button>
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void runTextTurn(input);
                    }
                  }}
                  placeholder="Ask about poles, districts, staging…"
                  className={`flex-1 px-3 py-2 rounded-lg text-sm outline-none transition ${
                    isLightMode
                      ? 'bg-white border border-slate-200 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100'
                      : 'bg-premium-hover border border-[#364258] focus:border-indigo-500 focus:ring-2 focus:ring-indigo-900/30'
                  }`}
                />
                <motion.button
                  type="button"
                  onClick={() => runTextTurn(input)}
                  disabled={!input.trim() || busy}
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  className={`p-2.5 rounded-full transition ${
                    input.trim() && !busy
                      ? 'bg-indigo-600 text-white'
                      : isLightMode
                        ? 'bg-slate-200 text-slate-400'
                        : 'bg-slate-800 text-slate-500'
                  }`}
                >
                  <Send className="h-4 w-4" />
                </motion.button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
