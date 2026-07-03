import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useGiopVoiceSession } from '../hooks/useGiopVoiceSession';
import { stopCopilotSpeech, subscribeCopilotSpeech } from '../lib/giopVoicePlayback';

export type GiopVoiceUiMode = 'idle' | 'arming' | 'listening' | 'processing';

interface GiopVoiceModeContextValue {
  mode: GiopVoiceUiMode;
  /** True while map voice UI should hide copilot chrome. */
  overlayActive: boolean;
  mapVoiceActive: boolean;
  recording: boolean;
  transcribing: boolean;
  processing: boolean;
  /** Assistant TTS currently playing. */
  speaking: boolean;
  error: string | null;
  toggleMapVoice: () => void;
  cancelMapVoice: () => void;
  getAnalyser: () => AnalyserNode | null;
  togglePanelVoice: () => void;
  registerAudioTurnHandler: (
    handler: (
      blob: Blob,
      meta: { rearmMic?: () => void },
    ) => void | Promise<void>,
  ) => void;
  registerCopilotOpen: (opener: () => void) => void;
  setCopilotOpen: (open: boolean) => void;
}

const GiopVoiceModeContext = createContext<GiopVoiceModeContextValue | null>(null);

export function GiopVoiceModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<GiopVoiceUiMode>('idle');
  const [speaking, setSpeaking] = useState(false);
  const awaitingMicRef = useRef(false);
  const handsfreeActiveRef = useRef(false);
  const panelOpenRef = useRef(false);
  const audioTurnHandlerRef = useRef<
    (blob: Blob, meta: { rearmMic?: () => void }) => void | Promise<void>
  >(() => undefined);
  const openCopilotRef = useRef<(() => void) | null>(null);
  const voiceStartRef = useRef<() => void>(() => undefined);

  const rearmMicIfHandsfree = useCallback(() => {
    if (!handsfreeActiveRef.current) return;
    awaitingMicRef.current = true;
    setMode('arming');
    void voiceStartRef.current();
  }, []);

  const voice = useGiopVoiceSession({
    onAudioTurn: async (blob) => {
      await audioTurnHandlerRef.current(blob, { rearmMic: rearmMicIfHandsfree });
    },
    enabled: true,
    keepStreamBetweenTurns: true,
  });
  voiceStartRef.current = () => {
    void voice.start();
  };

  useEffect(() => subscribeCopilotSpeech(setSpeaking), []);

  const cancelMapVoice = useCallback(() => {
    handsfreeActiveRef.current = false;
    awaitingMicRef.current = false;
    stopCopilotSpeech();
    voice.release();
    setMode('idle');
  }, [voice.release]);

  const toggleMapVoice = useCallback(() => {
    stopCopilotSpeech();
    if (voice.processing) return;
    if (voice.recording || mode === 'listening' || mode === 'arming') {
      handsfreeActiveRef.current = false;
      awaitingMicRef.current = false;
      voice.release();
      setMode('idle');
      return;
    }
    handsfreeActiveRef.current = true;
    setMode('arming');
    awaitingMicRef.current = true;
    void voice.start();
  }, [mode, voice]);

  const togglePanelVoice = useCallback(() => {
    if (voice.recording) voice.stop();
    else void voice.start();
  }, [voice]);

  useEffect(() => {
    if (voice.processing) {
      awaitingMicRef.current = false;
      setMode('processing');
      return;
    }
    if (voice.recording) {
      awaitingMicRef.current = false;
      setMode('listening');
      return;
    }
    if (voice.error) {
      awaitingMicRef.current = false;
      if (mode === 'arming' || mode === 'listening') {
        setMode('idle');
      }
    }
    if ((mode === 'listening' || mode === 'processing') && !awaitingMicRef.current) {
      setMode('idle');
    }
  }, [mode, voice.error, voice.recording, voice.processing]);

  const voiceReleaseRef = useRef(voice.release);
  voiceReleaseRef.current = voice.release;

  useEffect(() => () => {
    voiceReleaseRef.current();
  }, []);

  const registerAudioTurnHandler = useCallback(
    (
      handler: (
        blob: Blob,
        meta: { rearmMic?: () => void },
      ) => void | Promise<void>,
    ) => {
      audioTurnHandlerRef.current = handler;
    },
    [],
  );

  const registerCopilotOpen = useCallback((opener: () => void) => {
    openCopilotRef.current = opener;
  }, []);

  const setCopilotOpen = useCallback(
    (open: boolean) => {
      const wasOpen = panelOpenRef.current;
      panelOpenRef.current = open;
      if (wasOpen && !open) {
        handsfreeActiveRef.current = false;
        awaitingMicRef.current = false;
        voice.release();
        setMode('idle');
      }
    },
    [voice.release],
  );

  const overlayActive =
    mode === 'arming' || mode === 'listening' || mode === 'processing' || speaking;
  const mapVoiceActive = mode === 'arming' || mode === 'listening' || speaking;

  const value = useMemo(
    (): GiopVoiceModeContextValue => ({
      mode,
      overlayActive,
      mapVoiceActive,
      recording: voice.recording,
      transcribing: voice.transcribing,
      processing: voice.processing,
      speaking,
      error: voice.error,
      toggleMapVoice,
      cancelMapVoice,
      getAnalyser: voice.getAnalyser,
      togglePanelVoice,
      registerAudioTurnHandler,
      registerCopilotOpen,
      setCopilotOpen,
    }),
    [
      mode,
      overlayActive,
      mapVoiceActive,
      speaking,
      voice,
      toggleMapVoice,
      cancelMapVoice,
      togglePanelVoice,
      registerAudioTurnHandler,
      registerCopilotOpen,
      setCopilotOpen,
    ],
  );

  return (
    <GiopVoiceModeContext.Provider value={value}>
      {children}
    </GiopVoiceModeContext.Provider>
  );
}

export function useGiopVoiceMode(): GiopVoiceModeContextValue {
  const ctx = useContext(GiopVoiceModeContext);
  if (!ctx) {
    throw new Error('useGiopVoiceMode must be used within GiopVoiceModeProvider');
  }
  return ctx;
}

/** Optional hook for components that may render outside the provider. */
export function useGiopVoiceModeOptional(): GiopVoiceModeContextValue | null {
  return useContext(GiopVoiceModeContext);
}
