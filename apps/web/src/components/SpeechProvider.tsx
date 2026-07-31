import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  fetchSpeechClip,
  getSpeechStatus,
  loadSpeechPreferences,
  resolveSpeechPreferences,
  saveSpeechPreferences,
  type SpeechPreferences,
  type SpeechStatus,
} from "../lib/speechClient";
import {
  createBrowserAudio,
  idleSpeechPlaybackState,
  SpeechPlaybackMachine,
  type SpeechPlaybackAdapters,
  type SpeechPlaybackState,
  type SpeechRequest,
} from "../lib/speechPlayback";
import { splitSpeakableTextForPlayback } from "../lib/speechText";

export type SpeechContextValue = {
  status: SpeechStatus;
  preferences?: SpeechPreferences;
  playback: SpeechPlaybackState;
  speak(messageId: string, plainText: string): void;
  stop(): void;
  pause(): void;
  resume(): void;
  togglePaused(): void;
  seek(progress: number): void;
  skip(seconds: number): void;
  setPlaybackRate(rate: number): void;
  setVoice(voice: string): void;
  setStyle(style: string): void;
  refresh(): Promise<void>;
};

const PLAYBACK_RATE_KEY = "ocode.speech-playback-rate";

function loadPlaybackRate(): number {
  try {
    const stored = Number(localStorage.getItem(PLAYBACK_RATE_KEY));
    return [0.75, 1, 1.25, 1.5, 2].includes(stored) ? stored : 1;
  } catch {
    return 1;
  }
}

function savePlaybackRate(rate: number): void {
  try {
    localStorage.setItem(PLAYBACK_RATE_KEY, String(rate));
  } catch {
    // Playback still updates when device storage is unavailable.
  }
}

const IDLE_CONTEXT: SpeechContextValue = {
  status: { enabled: false },
  playback: idleSpeechPlaybackState(),
  speak: () => undefined,
  stop: () => undefined,
  pause: () => undefined,
  resume: () => undefined,
  togglePaused: () => undefined,
  seek: () => undefined,
  skip: () => undefined,
  setPlaybackRate: () => undefined,
  setVoice: () => undefined,
  setStyle: () => undefined,
  refresh: async () => undefined,
};

const SpeechContext = createContext<SpeechContextValue>(IDLE_CONTEXT);

const browserAdapters: SpeechPlaybackAdapters = {
  fetchClip: (request, signal) => fetchSpeechClip(request, signal),
  createObjectURL: (clip) => URL.createObjectURL(clip),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  createAudio: createBrowserAudio,
};

export function buildSpeechPlaybackRequest(
  messageId: string,
  plainText: string,
  maxChunkCharacters: number,
  preferences: SpeechPreferences,
): SpeechRequest | undefined {
  const chunks = splitSpeakableTextForPlayback(plainText, maxChunkCharacters);
  if (!chunks.length) return undefined;
  return { messageId, chunks, voice: preferences.voice, style: preferences.style };
}

export function SpeechProvider({
  children,
  loadStatus = getSpeechStatus,
  adapters = browserAdapters,
  initialStatus = { enabled: false },
}: {
  children: ReactNode;
  loadStatus?: () => Promise<SpeechStatus>;
  adapters?: SpeechPlaybackAdapters;
  initialStatus?: SpeechStatus;
}) {
  const storedPreferences = useRef(loadSpeechPreferences());
  const [status, setStatus] = useState<SpeechStatus>(initialStatus);
  const [preferences, setPreferences] = useState<SpeechPreferences | undefined>(() => (
    initialStatus.enabled ? resolveSpeechPreferences(initialStatus, storedPreferences.current) : undefined
  ));
  const machine = useMemo(() => new SpeechPlaybackMachine(adapters, undefined, loadPlaybackRate()), [adapters]);
  const playback = useSyncExternalStore(machine.subscribe, machine.getState, machine.getState);
  const lifecycle = useRef(0);
  const refreshGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const stored = loadSpeechPreferences();
    const next = await loadStatus();
    if (refreshGeneration.current !== generation) return;
    storedPreferences.current = stored;
    setStatus(next);
    setPreferences(next.enabled ? resolveSpeechPreferences(next, stored) : undefined);
  }, [loadStatus]);

  useEffect(() => {
    const token = ++lifecycle.current;
    void refresh();
    return () => {
      ++refreshGeneration.current;
      queueMicrotask(() => {
        if (lifecycle.current === token) machine.dispose();
      });
    };
  }, [machine, refresh]);

  const updatePreferences = useCallback((next: SpeechPreferences) => {
    storedPreferences.current = next;
    setPreferences(next);
    saveSpeechPreferences(next);
  }, []);

  const setVoice = useCallback((voice: string) => {
    if (!status.enabled || !preferences || !status.voices.some((option) => option.id === voice)) return;
    updatePreferences({ ...preferences, voice });
  }, [preferences, status, updatePreferences]);

  const setStyle = useCallback((style: string) => {
    if (!status.enabled || !preferences || !status.styles.some((option) => option.id === style)) return;
    updatePreferences({ ...preferences, style });
  }, [preferences, status, updatePreferences]);

  const speak = useCallback((messageId: string, plainText: string) => {
    if (!status.enabled || !preferences) return;
    const request = buildSpeechPlaybackRequest(messageId, plainText, status.maxChunkCharacters, preferences);
    if (request) machine.speak(request);
  }, [machine, preferences, status]);
  const stop = useCallback(() => machine.stop(), [machine]);
  const pause = useCallback(() => machine.pause(), [machine]);
  const resume = useCallback(() => machine.resume(), [machine]);
  const togglePaused = useCallback(() => machine.togglePaused(), [machine]);
  const seek = useCallback((progress: number) => machine.seek(progress), [machine]);
  const skip = useCallback((seconds: number) => machine.skip(seconds), [machine]);
  const setPlaybackRate = useCallback((rate: number) => {
    machine.setPlaybackRate(rate);
    savePlaybackRate(machine.getState().playbackRate);
  }, [machine]);

  const value = useMemo<SpeechContextValue>(() => ({
    status,
    preferences,
    playback,
    speak,
    stop,
    pause,
    resume,
    togglePaused,
    seek,
    skip,
    setPlaybackRate,
    setVoice,
    setStyle,
    refresh,
  }), [pause, playback, preferences, refresh, resume, seek, setPlaybackRate, setStyle, setVoice, skip, speak, status, stop, togglePaused]);

  return <SpeechContext.Provider value={value}>{children}</SpeechContext.Provider>;
}

export function useSpeech(): SpeechContextValue {
  return useContext(SpeechContext);
}
