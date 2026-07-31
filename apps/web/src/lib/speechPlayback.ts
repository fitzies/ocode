export type SpeechPlaybackStatus = "idle" | "loading" | "playing" | "paused" | "error";

export type SpeechPlaybackState = {
  status: SpeechPlaybackStatus;
  playbackRate: number;
  /** Progress across the complete response, from 0 to 1. */
  progress: number;
  /** Time metadata for the active synthesized chunk. */
  currentTime: number;
  duration: number;
  /** The user's pause intent, including while a chunk is still loading. */
  desiredPaused: boolean;
  messageId?: string;
  chunkIndex?: number;
  chunkCount?: number;
  error?: string;
};

export type SpeechRequest = {
  messageId: string;
  chunks: string[];
  voice: string;
  style: string;
};

export interface ClipData { readonly size: number }

export interface PlaybackAudio {
  play(): Promise<void>;
  pause(): void;
  currentTime: number;
  duration: number;
  playbackRate: number;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  ontimeupdate: (() => void) | null;
  onloadedmetadata: (() => void) | null;
  ondurationchange: (() => void) | null;
}

export type SpeechPlaybackAdapters<TClip extends ClipData = Blob> = {
  fetchClip(request: { text: string; voice: string; style: string }, signal: AbortSignal): Promise<TClip>;
  createObjectURL(clip: TClip): string;
  revokeObjectURL(url: string): void;
  createAudio(url: string): PlaybackAudio;
};

type CacheEntry = { url: string; bytes: number; used: number; revoked: boolean };
type PendingClip = { key: string; run: number; index: number; controller: AbortController; promise: Promise<CacheEntry> };
type ClipResult = { ok: true; entry: CacheEntry } | { ok: false; error: unknown };
type PrefetchedClip = Omit<PendingClip, "promise"> & { promise: Promise<ClipResult> };
type PendingPlay = { run: number; audio: PlaybackAudio; interrupted: boolean };
type PlayResult = { ok: true } | { ok: false; error: unknown };
type PendingSeek =
  | { kind: "fraction"; value: number }
  | { kind: "start"; seconds: number }
  | { kind: "end"; secondsBeforeEnd: number };

const abortError = () => new DOMException("Speech request aborted", "AbortError");
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

function requestKey(text: string, voice: string, style: string): string {
  return JSON.stringify([voice, style, text]);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "Could not read this response aloud";
}

function finiteTime(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeRate(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0.25, 4) : 1;
}

export function idleSpeechPlaybackState(playbackRate = 1): SpeechPlaybackState {
  return {
    status: "idle",
    playbackRate: normalizeRate(playbackRate),
    progress: 0,
    currentTime: 0,
    duration: 0,
    desiredPaused: false,
  };
}

/** Framework-independent, single-speaker playback and bounded object-URL cache. */
export class SpeechPlaybackMachine<TClip extends ClipData = Blob> {
  private state: SpeechPlaybackState;
  private readonly listeners = new Set<(state: SpeechPlaybackState) => void>();
  private readonly cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  private clock = 0;
  private run = 0;
  private active?: SpeechRequest;
  private chunkWeights: number[] = [];
  private totalWeight = 0;
  private currentIndex = 0;
  private currentAudio?: PlaybackAudio;
  private currentKey?: string;
  private currentLoad?: PendingClip;
  private prefetch?: PrefetchedClip;
  private pendingPlay?: PendingPlay;
  private pendingSeek?: PendingSeek;
  private desiredPaused = false;
  private disposed = false;

  constructor(
    private readonly adapters: SpeechPlaybackAdapters<TClip>,
    private readonly limits = { clips: 8, bytes: 32 * 1024 * 1024 },
    initialPlaybackRate = 1,
  ) {
    this.state = idleSpeechPlaybackState(initialPlaybackRate);
  }

  getState = (): SpeechPlaybackState => this.state;

  subscribe = (listener: (state: SpeechPlaybackState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  speak(request: SpeechRequest): void {
    if (this.disposed || request.chunks.length === 0) return;
    if (
      this.state.messageId === request.messageId &&
      (this.state.status === "loading" || this.state.status === "playing" || this.state.status === "paused")
    ) {
      this.stop();
      return;
    }
    this.cancelActive();
    const run = ++this.run;
    this.active = request;
    this.chunkWeights = request.chunks.map((chunk) => Math.max(1, Array.from(chunk).length));
    this.totalWeight = this.chunkWeights.reduce((sum, weight) => sum + weight, 0);
    this.currentIndex = 0;
    this.desiredPaused = false;
    this.setActiveState("loading", 0, 0, 0);
    void this.playIndex(run, 0);
  }

  stop(): void {
    if (this.disposed) return;
    this.cancelActive();
    this.setState(idleSpeechPlaybackState(this.state.playbackRate));
  }

  pause(): void {
    if (this.disposed || this.desiredPaused || !this.active) return;
    this.setDesiredPaused(true);
  }

  resume(): void {
    if (this.disposed || !this.desiredPaused || !this.active) return;
    this.setDesiredPaused(false);
  }

  togglePaused(): void {
    if (this.disposed || !this.active) return;
    this.setDesiredPaused(!this.desiredPaused);
  }

  setPlaybackRate(playbackRate: number): void {
    if (this.disposed) return;
    const next = normalizeRate(playbackRate);
    if (this.currentAudio) this.currentAudio.playbackRate = next;
    this.setState({ ...this.state, playbackRate: next });
  }

  /** Seeks using overall response progress rather than per-clip progress. */
  seek(progress: number): void {
    const request = this.active;
    if (this.disposed || !request || this.totalWeight <= 0) return;
    const target = this.locateProgress(clamp(progress, 0, 1));
    if (target.index === this.currentIndex && this.currentAudio) {
      this.pendingSeek = { kind: "fraction", value: target.fraction };
      this.applyPendingSeek(this.currentAudio);
      this.updateTiming();
      return;
    }
    if (target.index === this.currentIndex && this.currentLoad) {
      this.pendingSeek = { kind: "fraction", value: target.fraction };
      this.setActiveState("loading", target.fraction, 0, 0);
      return;
    }
    this.jumpTo(target.index, { kind: "fraction", value: target.fraction });
  }

  skip(seconds: number): void {
    const audio = this.currentAudio;
    const request = this.active;
    if (this.disposed || !audio || !request || !Number.isFinite(seconds) || seconds === 0) return;
    const duration = finiteTime(audio.duration);
    if (!duration) return;
    const currentTime = clamp(Number.isFinite(audio.currentTime) ? audio.currentTime : 0, 0, duration);
    const target = currentTime + seconds;
    if (target >= 0 && target <= duration) {
      audio.currentTime = Math.max(0, target);
      this.updateTiming();
      return;
    }

    if (target > duration && this.currentIndex < request.chunks.length - 1) {
      this.jumpTo(this.currentIndex + 1, { kind: "start", seconds: target - duration });
    } else if (target < 0 && this.currentIndex > 0) {
      this.jumpTo(this.currentIndex - 1, { kind: "end", secondsBeforeEnd: -target });
    } else {
      audio.currentTime = target < 0 ? 0 : duration;
      this.updateTiming();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelActive();
    this.disposed = true;
    for (const key of [...this.cache.keys()]) this.release(key);
    this.listeners.clear();
    this.state = idleSpeechPlaybackState(this.state.playbackRate);
  }

  private setState(state: SpeechPlaybackState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private setActiveState(
    status: "loading" | "playing" | "paused",
    chunkFraction: number,
    currentTime: number,
    duration: number,
  ): void {
    const request = this.active;
    if (!request) return;
    this.setState({
      status,
      playbackRate: this.state.playbackRate,
      progress: this.progressAt(this.currentIndex, chunkFraction),
      currentTime,
      duration,
      desiredPaused: this.desiredPaused,
      messageId: request.messageId,
      chunkIndex: this.currentIndex,
      chunkCount: request.chunks.length,
    });
  }

  private cancelActive(): void {
    this.run += 1;
    this.currentLoad?.controller.abort();
    this.currentLoad = undefined;
    this.prefetch?.controller.abort();
    this.prefetch = undefined;
    this.pendingPlay = undefined;
    this.detachAudio();
    this.active = undefined;
    this.chunkWeights = [];
    this.totalWeight = 0;
    this.currentKey = undefined;
    this.pendingSeek = undefined;
    this.desiredPaused = false;
    this.evict();
  }

  private detachAudio(pause = true): void {
    const audio = this.currentAudio;
    this.currentAudio = undefined;
    if (!audio) return;
    audio.onended = null;
    audio.onerror = null;
    audio.ontimeupdate = null;
    audio.onloadedmetadata = null;
    audio.ondurationchange = null;
    if (pause) audio.pause();
  }

  private setDesiredPaused(desiredPaused: boolean): void {
    this.desiredPaused = desiredPaused;
    const audio = this.currentAudio;
    if (!audio) {
      this.setState({ ...this.state, desiredPaused });
      return;
    }
    if (desiredPaused) {
      if (this.pendingPlay?.audio === audio) this.pendingPlay.interrupted = true;
      audio.pause();
      this.updateTiming("paused");
      return;
    }
    this.startPlayback(this.run, audio);
  }

  private startPlayback(run: number, audio: PlaybackAudio): void {
    if (this.disposed || run !== this.run || audio !== this.currentAudio || this.desiredPaused) return;
    if (this.pendingPlay?.audio === audio) {
      this.updateTiming("playing");
      return;
    }

    const pending: PendingPlay = { run, audio, interrupted: false };
    this.pendingPlay = pending;
    this.updateTiming("playing");

    let playPromise: Promise<void>;
    try {
      playPromise = audio.play();
    } catch (error) {
      this.finishPlaybackAttempt(pending, { ok: false, error });
      return;
    }
    void playPromise.then(
      () => this.finishPlaybackAttempt(pending, { ok: true }),
      (error) => this.finishPlaybackAttempt(pending, { ok: false, error }),
    );
  }

  private finishPlaybackAttempt(pending: PendingPlay, result: PlayResult): void {
    const { run, audio, interrupted } = pending;
    if (this.pendingPlay === pending) this.pendingPlay = undefined;
    if (run !== this.run || audio !== this.currentAudio) {
      audio.pause();
      return;
    }
    if (this.desiredPaused) {
      audio.pause();
      this.updateTiming("paused");
      return;
    }
    if (interrupted) {
      this.startPlayback(run, audio);
      return;
    }
    if (!result.ok) {
      this.fail(run, result.error);
      return;
    }
    this.updateTiming("playing");
  }

  private jumpTo(index: number, pendingSeek: PendingSeek): void {
    const request = this.active;
    if (!request || index < 0 || index >= request.chunks.length) return;
    this.currentLoad?.controller.abort();
    this.currentLoad = undefined;
    if (this.prefetch?.index !== index) {
      this.prefetch?.controller.abort();
      this.prefetch = undefined;
    }
    this.detachAudio();
    this.currentKey = undefined;
    this.currentIndex = index;
    this.pendingSeek = pendingSeek;
    const fraction = pendingSeek.kind === "fraction" ? pendingSeek.value : pendingSeek.kind === "end" ? 1 : 0;
    this.setActiveState("loading", fraction, 0, 0);
    void this.playIndex(this.run, index);
  }

  private async playIndex(run: number, index: number): Promise<void> {
    const request = this.active;
    if (!request || run !== this.run || index !== this.currentIndex) return;
    try {
      const clip = await this.loadClip(run, index);
      if (run !== this.run || request !== this.active || index !== this.currentIndex) return;
      const text = request.chunks[index]!;
      const key = requestKey(text, request.voice, request.style);
      this.currentKey = key;
      this.touch(key);
      this.evict(this.protectedKeys());

      const audio = this.adapters.createAudio(clip.url);
      this.currentAudio = audio;
      audio.playbackRate = this.state.playbackRate;
      audio.onended = () => {
        if (run !== this.run || this.currentAudio !== audio) return;
        this.updateTiming();
        this.detachAudio(false);
        void this.advance(run, index + 1);
      };
      audio.onerror = () => this.fail(run, new Error("Audio playback failed"));
      audio.ontimeupdate = () => {
        if (run === this.run && this.currentAudio === audio) this.updateTiming();
      };
      audio.onloadedmetadata = () => {
        if (run !== this.run || this.currentAudio !== audio) return;
        this.applyPendingSeek(audio);
        this.updateTiming();
      };
      audio.ondurationchange = audio.onloadedmetadata;
      this.applyPendingSeek(audio);

      this.startPrefetch(run, index + 1);
      if (this.desiredPaused) {
        this.updateTiming("paused");
        return;
      }
      this.startPlayback(run, audio);
    } catch (error) {
      if (run === this.run && !(error instanceof DOMException && error.name === "AbortError")) {
        this.fail(run, error);
      }
    }
  }

  private async advance(run: number, index: number): Promise<void> {
    const request = this.active;
    if (!request || run !== this.run) return;
    this.currentKey = undefined;
    this.pendingSeek = undefined;
    if (index >= request.chunks.length) {
      this.active = undefined;
      this.chunkWeights = [];
      this.totalWeight = 0;
      this.setState(idleSpeechPlaybackState(this.state.playbackRate));
      this.evict();
      return;
    }
    this.currentIndex = index;
    this.setActiveState("loading", 0, 0, 0);
    await this.playIndex(run, index);
  }

  private fail(run: number, error: unknown): void {
    if (run !== this.run) return;
    const messageId = this.active?.messageId;
    const playbackRate = this.state.playbackRate;
    this.cancelActive();
    this.setState({
      ...idleSpeechPlaybackState(playbackRate),
      status: "error",
      messageId,
      error: errorMessage(error),
    });
  }

  private loadClip(run: number, index: number): Promise<CacheEntry> {
    const request = this.active;
    if (!request || run !== this.run) return Promise.reject(abortError());
    const text = request.chunks[index];
    if (text === undefined) return Promise.reject(new Error("Speech chunk is missing"));
    const key = requestKey(text, request.voice, request.style);

    if (this.prefetch?.run === run && this.prefetch.index === index && this.prefetch.key === key) {
      const prefetched = this.prefetch;
      this.prefetch = undefined;
      const pending: PendingClip = {
        ...prefetched,
        promise: Promise.resolve(undefined as never),
      };
      pending.promise = prefetched.promise.then((result) => {
        if (result.ok) return result.entry;
        throw result.error;
      }).finally(() => {
        if (this.currentLoad === pending) this.currentLoad = undefined;
      });
      this.currentLoad = pending;
      return pending.promise;
    }

    const cached = this.cache.get(key);
    if (cached) {
      this.touch(key);
      return Promise.resolve(cached);
    }
    if (this.currentLoad?.key === key && this.currentLoad.run === run && this.currentLoad.index === index) {
      return this.currentLoad.promise;
    }

    const controller = new AbortController();
    const pending: PendingClip = {
      key,
      run,
      index,
      controller,
      promise: Promise.resolve(undefined as never),
    };
    pending.promise = this.fetchEntry(request, run, index, key, controller)
      .finally(() => {
        if (this.currentLoad === pending) this.currentLoad = undefined;
      });
    this.currentLoad = pending;
    return pending.promise;
  }

  private startPrefetch(run: number, index: number): void {
    const request = this.active;
    if (!request || run !== this.run || index >= request.chunks.length || this.prefetch) return;
    const text = request.chunks[index]!;
    const key = requestKey(text, request.voice, request.style);
    if (this.cache.has(key)) return;
    const controller = new AbortController();
    const pending: PrefetchedClip = {
      key,
      run,
      index,
      controller,
      promise: Promise.resolve(undefined as never),
    };
    pending.promise = this.fetchEntry(request, run, index, key, controller).then(
      (entry): ClipResult => ({ ok: true, entry }),
      (error): ClipResult => ({ ok: false, error }),
    );
    this.prefetch = pending;
  }

  private async fetchEntry(
    request: SpeechRequest,
    run: number,
    index: number,
    key: string,
    controller: AbortController,
  ): Promise<CacheEntry> {
    const cached = this.cache.get(key);
    if (cached) return cached;
    const text = request.chunks[index];
    if (text === undefined) throw new Error("Speech chunk is missing");
    const data = await this.adapters.fetchClip({ text, voice: request.voice, style: request.style }, controller.signal);
    if (controller.signal.aborted || run !== this.run || request !== this.active) throw abortError();
    const existing = this.cache.get(key);
    if (existing) return existing;
    const entry: CacheEntry = {
      url: this.adapters.createObjectURL(data),
      bytes: Math.max(0, data.size),
      used: ++this.clock,
      revoked: false,
    };
    this.cache.set(key, entry);
    this.cacheBytes += entry.bytes;
    this.evict(this.protectedKeys(key));
    return entry;
  }

  private applyPendingSeek(audio: PlaybackAudio): void {
    const pending = this.pendingSeek;
    const duration = finiteTime(audio.duration);
    if (!pending || !duration) return;
    if (pending.kind === "fraction") audio.currentTime = duration * clamp(pending.value, 0, 1);
    else if (pending.kind === "start") audio.currentTime = clamp(pending.seconds, 0, duration);
    else audio.currentTime = clamp(duration - pending.secondsBeforeEnd, 0, duration);
    this.pendingSeek = undefined;
  }

  private updateTiming(status?: "playing" | "paused"): void {
    const audio = this.currentAudio;
    if (!audio || !this.active) return;
    const duration = finiteTime(audio.duration);
    const currentTime = duration
      ? clamp(Number.isFinite(audio.currentTime) ? audio.currentTime : 0, 0, duration)
      : Math.max(0, Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
    const fraction = duration ? currentTime / duration : 0;
    const nextStatus = status ?? (this.desiredPaused ? "paused" : "playing");
    this.setActiveState(nextStatus, fraction, currentTime, duration);
  }

  private locateProgress(progress: number): { index: number; fraction: number } {
    const targetWeight = progress * this.totalWeight;
    let consumed = 0;
    for (let index = 0; index < this.chunkWeights.length; index += 1) {
      const weight = this.chunkWeights[index]!;
      if (targetWeight < consumed + weight || index === this.chunkWeights.length - 1) {
        return { index, fraction: clamp((targetWeight - consumed) / weight, 0, 1) };
      }
      consumed += weight;
    }
    return { index: 0, fraction: 0 };
  }

  private progressAt(index: number, chunkFraction: number): number {
    if (this.totalWeight <= 0) return 0;
    const completed = this.chunkWeights.slice(0, index).reduce((sum, weight) => sum + weight, 0);
    return clamp((completed + (this.chunkWeights[index] ?? 0) * clamp(chunkFraction, 0, 1)) / this.totalWeight, 0, 1);
  }

  private protectedKeys(additional?: string): Set<string> {
    return new Set([
      ...(this.currentKey ? [this.currentKey] : []),
      ...(this.prefetch?.key ? [this.prefetch.key] : []),
      ...(additional ? [additional] : []),
    ]);
  }

  private touch(key: string): void {
    const entry = this.cache.get(key);
    if (entry) entry.used = ++this.clock;
  }

  private evict(protectedKeys = new Set<string>()): void {
    while (this.cache.size > this.limits.clips || this.cacheBytes > this.limits.bytes) {
      const candidate = [...this.cache.entries()]
        .filter(([key]) => !protectedKeys.has(key))
        .sort((left, right) => left[1].used - right[1].used)[0];
      if (!candidate) return;
      this.release(candidate[0]);
    }
  }

  private release(key: string): void {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    this.cacheBytes -= entry.bytes;
    if (!entry.revoked) {
      entry.revoked = true;
      this.adapters.revokeObjectURL(entry.url);
    }
  }
}

export function createBrowserAudio(url: string): PlaybackAudio {
  const audio = new Audio(url);
  const adapter: PlaybackAudio = {
    play: () => audio.play(),
    pause: () => audio.pause(),
    get currentTime() { return audio.currentTime; },
    set currentTime(value) { audio.currentTime = value; },
    get duration() { return audio.duration; },
    get playbackRate() { return audio.playbackRate; },
    set playbackRate(value) { audio.playbackRate = value; },
    onended: null,
    onerror: null,
    ontimeupdate: null,
    onloadedmetadata: null,
    ondurationchange: null,
  };
  audio.onended = () => adapter.onended?.();
  audio.onerror = () => adapter.onerror?.();
  audio.ontimeupdate = () => adapter.ontimeupdate?.();
  audio.onloadedmetadata = () => adapter.onloadedmetadata?.();
  audio.ondurationchange = () => adapter.ondurationchange?.();
  return adapter;
}
