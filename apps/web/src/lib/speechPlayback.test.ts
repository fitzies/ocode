import { describe, expect, it, vi } from "vitest";
import {
  SpeechPlaybackMachine,
  type PlaybackAudio,
  type SpeechPlaybackAdapters,
} from "./speechPlayback";

type Clip = { size: number; name: string };
type FetchCall = {
  text: string;
  signal: AbortSignal;
  resolve: (clip: Clip) => void;
  reject: (error: unknown) => void;
};

class TestAudio implements PlaybackAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  ondurationchange: (() => void) | null = null;
  currentTime = 0;
  duration = 20;
  playbackRate = 1;
  paused = false;
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });

  time(time: number, duration = this.duration) {
    this.duration = duration;
    this.currentTime = time;
    this.ontimeupdate?.();
  }
}

function harness(limits?: { clips: number; bytes: number }) {
  const calls: FetchCall[] = [];
  const audios: TestAudio[] = [];
  const created: string[] = [];
  const revoked: string[] = [];
  let nextPlayError: Error | undefined;
  const adapters: SpeechPlaybackAdapters<Clip> = {
    fetchClip: ({ text }, signal) => new Promise((resolve, reject) => calls.push({ text, signal, resolve, reject })),
    createObjectURL: (clip) => {
      const url = `blob:${clip.name}:${created.length}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url) => revoked.push(url),
    createAudio: () => {
      const audio = new TestAudio();
      if (nextPlayError) {
        audio.play.mockRejectedValueOnce(nextPlayError);
        nextPlayError = undefined;
      }
      audios.push(audio);
      return audio;
    },
  };
  return {
    machine: new SpeechPlaybackMachine(adapters, limits),
    calls,
    audios,
    created,
    revoked,
    rejectNextPlay: (error: Error) => { nextPlayError = error; },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const request = (messageId: string, chunks = [messageId]) => ({ messageId, chunks, voice: "voice-default", style: "style-default" });

function activeState(status: "loading" | "playing" | "paused", overrides: Record<string, unknown> = {}) {
  return expect.objectContaining({ status, messageId: "one", playbackRate: 1, ...overrides });
}

describe("SpeechPlaybackMachine", () => {
  it("is visible only from the first attempt through natural completion", async () => {
    const h = harness();
    expect(h.machine.getState()).toEqual({ status: "idle", playbackRate: 1, progress: 0, currentTime: 0, duration: 0, desiredPaused: false });
    h.machine.speak(request("one"));
    expect(h.machine.getState()).toEqual(activeState("loading", { progress: 0 }));
    expect(h.audios).toHaveLength(0);

    h.calls[0]!.resolve({ size: 10, name: "one" });
    await flush();
    expect(h.audios[0]!.play).toHaveBeenCalledOnce();
    expect(h.machine.getState()).toEqual(activeState("playing"));

    h.audios[0]!.onended?.();
    await flush();
    expect(h.machine.getState()).toEqual({ status: "idle", playbackRate: 1, progress: 0, currentTime: 0, duration: 0, desiredPaused: false });
  });

  it("pauses, resumes, applies rate immediately, and publishes time updates", async () => {
    const h = harness();
    h.machine.speak(request("one"));
    h.calls[0]!.resolve({ size: 10, name: "one" });
    await flush();

    h.audios[0]!.time(5, 20);
    expect(h.machine.getState()).toEqual(activeState("playing", {
      currentTime: 5,
      duration: 20,
      progress: 0.25,
    }));

    h.machine.pause();
    expect(h.audios[0]!.pause).toHaveBeenCalledOnce();
    expect(h.machine.getState()).toEqual(activeState("paused"));
    h.machine.setPlaybackRate(1.5);
    expect(h.audios[0]!.playbackRate).toBe(1.5);
    expect(h.machine.getState().playbackRate).toBe(1.5);

    h.machine.resume();
    await flush();
    expect(h.audios[0]!.play).toHaveBeenCalledTimes(2);
    expect(h.machine.getState().status).toBe("playing");
  });

  it("honors pause intent during the initial load and starts only after resume", async () => {
    const h = harness();
    h.machine.speak(request("one"));

    h.machine.togglePaused();
    expect(h.machine.getState()).toEqual(activeState("loading", { desiredPaused: true }));
    h.calls[0]!.resolve({ size: 10, name: "one" });
    await flush();

    expect(h.machine.getState()).toEqual(activeState("paused", { desiredPaused: true }));
    expect(h.audios[0]!.play).not.toHaveBeenCalled();

    h.machine.togglePaused();
    await flush();
    expect(h.audios[0]!.play).toHaveBeenCalledOnce();
    expect(h.machine.getState()).toEqual(activeState("playing", { desiredPaused: false }));
  });

  it("can toggle pause intent back before initial audio is ready", async () => {
    const h = harness();
    h.machine.speak(request("one"));
    h.machine.togglePaused();
    h.machine.togglePaused();
    expect(h.machine.getState()).toEqual(activeState("loading", { desiredPaused: false }));

    h.calls[0]!.resolve({ size: 10, name: "one" });
    await flush();
    expect(h.audios[0]!.play).toHaveBeenCalledOnce();
    expect(h.machine.getState()).toEqual(activeState("playing", { desiredPaused: false }));
  });

  it("preserves pause intent while a next chunk is loading", async () => {
    const h = harness();
    h.machine.speak(request("one", ["a", "b"]));
    h.calls[0]!.resolve({ size: 10, name: "a" });
    await flush();

    h.audios[0]!.onended?.();
    await flush();
    expect(h.machine.getState()).toEqual(activeState("loading", { chunkIndex: 1 }));
    h.machine.togglePaused();
    expect(h.machine.getState()).toEqual(activeState("loading", { chunkIndex: 1, desiredPaused: true }));

    h.calls[1]!.resolve({ size: 10, name: "b" });
    await flush();
    expect(h.audios[1]!.play).not.toHaveBeenCalled();
    expect(h.machine.getState()).toEqual(activeState("paused", { chunkIndex: 1, desiredPaused: true }));

    h.machine.togglePaused();
    await flush();
    expect(h.audios[1]!.play).toHaveBeenCalledOnce();
    expect(h.machine.getState()).toEqual(activeState("playing", { chunkIndex: 1, desiredPaused: false }));
  });

  it("does not duplicate a pending resume and honors a rapid pause", async () => {
    const h = harness();
    h.machine.speak(request("one"));
    h.calls[0]!.resolve({ size: 10, name: "one" });
    await flush();
    h.machine.pause();

    let resolvePlay!: () => void;
    const pendingPlay = new Promise<void>((resolve) => { resolvePlay = resolve; });
    h.audios[0]!.play.mockImplementationOnce(() => pendingPlay);

    h.machine.resume();
    h.machine.resume();
    expect(h.audios[0]!.play).toHaveBeenCalledTimes(2);
    expect(h.machine.getState()).toEqual(activeState("playing", { desiredPaused: false }));

    h.machine.togglePaused();
    expect(h.machine.getState()).toEqual(activeState("paused", { desiredPaused: true }));
    resolvePlay();
    await flush();

    expect(h.audios[0]!.play).toHaveBeenCalledTimes(2);
    expect(h.audios[0]!.paused).toBe(true);
    expect(h.machine.getState()).toEqual(activeState("paused", { desiredPaused: true }));
  });

  it("keeps weighted overall progress continuous at chunk boundaries", async () => {
    const h = harness();
    h.machine.speak(request("one", ["a", "bbb"]));
    h.calls[0]!.resolve({ size: 10, name: "a" });
    await flush();
    expect(h.calls.map((call) => call.text)).toEqual(["a", "bbb"]);

    h.audios[0]!.time(10, 20);
    expect(h.machine.getState().progress).toBeCloseTo(0.125);
    h.audios[0]!.onended?.();
    await flush();
    expect(h.machine.getState()).toEqual(activeState("loading", { progress: 0.25, chunkIndex: 1 }));

    h.calls[1]!.resolve({ size: 10, name: "bbb" });
    await flush();
    h.audios[1]!.time(10, 20);
    expect(h.machine.getState().progress).toBeCloseTo(0.625);
  });

  it("seeks within and across chunks without restarting overall progress", async () => {
    const h = harness();
    h.machine.speak(request("one", ["aa", "bb"]));
    h.calls[0]!.resolve({ size: 10, name: "aa" });
    await flush();

    h.machine.seek(0.25);
    expect(h.audios[0]!.currentTime).toBe(10);
    expect(h.machine.getState().progress).toBeCloseTo(0.25);

    h.machine.seek(0.75);
    expect(h.machine.getState()).toEqual(activeState("loading", { progress: 0.75, chunkIndex: 1 }));
    expect(h.calls.filter((call) => call.text === "bb")).toHaveLength(1);
    h.calls[1]!.resolve({ size: 10, name: "bb" });
    await flush();
    expect(h.audios[1]!.currentTime).toBe(10);
    expect(h.machine.getState().progress).toBeCloseTo(0.75);
  });

  it("skips ten seconds within a clip and sensibly across boundaries", async () => {
    const h = harness();
    h.machine.speak(request("one", ["a", "b"]));
    h.calls[0]!.resolve({ size: 10, name: "a" });
    await flush();
    h.audios[0]!.time(5, 20);
    h.machine.skip(10);
    expect(h.audios[0]!.currentTime).toBe(15);

    h.machine.skip(10);
    expect(h.machine.getState()).toEqual(activeState("loading", { chunkIndex: 1 }));
    h.calls[1]!.resolve({ size: 10, name: "b" });
    await flush();
    expect(h.audios[1]!.currentTime).toBe(5);

    h.audios[1]!.time(3, 20);
    h.machine.skip(-10);
    await flush();
    expect(h.audios[2]!.currentTime).toBe(13);
  });

  it("ignores skip until the active clip has playable metadata", async () => {
    const h = harness();
    h.machine.speak(request("one"));
    h.calls[0]!.resolve({ size: 10, name: "one" });
    await flush();
    h.audios[0]!.duration = Number.NaN;

    h.machine.skip(10);
    expect(h.audios[0]!.currentTime).toBe(0);
    expect(h.machine.getState().progress).toBe(0);
  });

  it("does not stop when a consumer simulates changing threads", async () => {
    const h = harness();
    h.machine.speak(request("one"));
    h.calls[0]!.resolve({ size: 10, name: "one" });
    await flush();

    const viewedThread = { current: "thread-a" };
    viewedThread.current = "thread-b";
    expect(viewedThread.current).toBe("thread-b");
    expect(h.machine.getState().status).toBe("playing");
    expect(h.audios[0]!.pause).not.toHaveBeenCalled();
  });

  it("aborts and replaces a message while ignoring stale fetch completion", async () => {
    const h = harness();
    h.machine.speak(request("first"));
    h.machine.speak(request("second"));
    expect(h.calls[0]!.signal.aborted).toBe(true);
    expect(h.machine.getState()).toEqual(expect.objectContaining({ status: "loading", messageId: "second" }));

    h.calls[0]!.resolve({ size: 10, name: "stale" });
    h.calls[1]!.resolve({ size: 10, name: "second" });
    await flush();
    expect(h.created).toEqual(["blob:second:0"]);
    expect(h.machine.getState()).toEqual(expect.objectContaining({ status: "playing", messageId: "second" }));
  });

  it("treats activating the current response, including while paused, as stop", async () => {
    const h = harness();
    h.machine.speak(request("one"));
    h.calls[0]!.resolve({ size: 10, name: "one" });
    await flush();
    h.machine.pause();
    h.machine.speak(request("one"));
    expect(h.machine.getState().status).toBe("idle");
  });

  it("prefetches only the next clip after playback starts and consumes it", async () => {
    const h = harness();
    h.machine.speak(request("one", ["a", "b", "c"]));
    expect(h.calls.map((call) => call.text)).toEqual(["a"]);
    h.calls[0]!.resolve({ size: 10, name: "a" });
    await flush();
    expect(h.calls.map((call) => call.text)).toEqual(["a", "b"]);

    h.calls[1]!.resolve({ size: 10, name: "b" });
    await flush();
    h.audios[0]!.onended?.();
    await flush();
    expect(h.audios).toHaveLength(2);
    expect(h.calls.map((call) => call.text)).toEqual(["a", "b", "c"]);
  });

  it("retains a failed prefetch and surfaces it on advance without retry", async () => {
    const h = harness();
    h.machine.speak(request("one", ["a", "b"]));
    h.calls[0]!.resolve({ size: 10, name: "a" });
    await flush();
    h.calls[1]!.reject(new Error("Speech service unavailable"));
    await flush();
    expect(h.machine.getState().status).toBe("playing");

    h.audios[0]!.onended?.();
    await flush();
    expect(h.calls.filter((call) => call.text === "b")).toHaveLength(1);
    expect(h.machine.getState()).toEqual(expect.objectContaining({
      status: "error",
      messageId: "one",
      error: "Speech service unavailable",
    }));
  });

  it("recovers from rejected play and hides transport state after audio errors", async () => {
    const h = harness();
    h.machine.speak(request("one"));
    h.rejectNextPlay(new Error("Playback permission denied"));
    h.calls[0]!.resolve({ size: 10, name: "one" });
    await flush();
    expect(h.machine.getState()).toEqual(expect.objectContaining({ status: "error", messageId: "one", error: "Playback permission denied" }));

    h.machine.speak(request("two"));
    h.calls[1]!.resolve({ size: 10, name: "two" });
    await flush();
    h.audios[1]!.onerror?.();
    expect(h.machine.getState()).toEqual(expect.objectContaining({ status: "error", messageId: "two", error: "Audio playback failed" }));
  });

  it("aborts current and prefetched requests and revokes every URL exactly once", async () => {
    const loading = harness();
    loading.machine.speak(request("one", ["a", "b"]));
    loading.machine.stop();
    expect(loading.calls[0]!.signal.aborted).toBe(true);
    expect(loading.machine.getState()).toEqual({ status: "idle", playbackRate: 1, progress: 0, currentTime: 0, duration: 0, desiredPaused: false });

    const h = harness({ clips: 2, bytes: 20 });
    h.machine.speak(request("one", ["a", "b"]));
    h.calls[0]!.resolve({ size: 10, name: "a" });
    await flush();
    expect(h.calls[1]!.signal.aborted).toBe(false);
    h.machine.stop();
    expect(h.machine.getState()).toEqual({ status: "idle", playbackRate: 1, progress: 0, currentTime: 0, duration: 0, desiredPaused: false });
    expect(h.calls[1]!.signal.aborted).toBe(true);
    expect(h.audios[0]!.pause).toHaveBeenCalled();
    expect(h.audios[0]!.onended).toBeNull();
    expect(h.audios[0]!.ontimeupdate).toBeNull();

    h.machine.speak(request("two"));
    h.calls[2]!.resolve({ size: 10, name: "two" });
    await flush();
    h.audios[1]!.onended?.();
    await flush();
    h.machine.dispose();
    expect(h.revoked).toEqual(["blob:a:0", "blob:two:1"]);
    expect(new Set(h.revoked).size).toBe(h.revoked.length);
  });
});
