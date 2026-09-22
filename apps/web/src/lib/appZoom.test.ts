import { afterEach, describe, expect, it, vi } from "vitest";

import { applyZoom, clampZoom, handleZoomKey, readZoom, type ZoomKeyEvent } from "./appZoom";

function installDomStubs() {
  const store = new Map<string, string>();
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const styleValues = new Map<string, string>();
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.get(type)?.delete(listener);
    },
  };
  (globalThis as Record<string, unknown>).document = {
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => {
          styleValues.set(name, value);
        },
        getPropertyValue: (name: string) => styleValues.get(name) ?? "",
      },
    },
  };
  return { store, listeners, styleValues };
}

function keyEvent(overrides: Partial<ZoomKeyEvent> = {}): ZoomKeyEvent {
  return {
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    key: "=",
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
});

describe("appZoom", () => {
  it("clamps zoom factors into range", () => {
    expect(clampZoom(0)).toBe(0.5);
    expect(clampZoom(10)).toBe(2);
    expect(clampZoom(1.15)).toBe(1.2);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("zooms in, out, and resets through the keyboard handler", async () => {
    const { store, styleValues } = installDomStubs();
    expect(handleZoomKey(keyEvent({ key: "=" }))).toBe(true);
    await flush();
    expect(store.get("ocode.ui-zoom")).toBe("1.1");
    expect(styleValues.get("zoom")).toBe("1.1");

    expect(handleZoomKey(keyEvent({ key: "-" }))).toBe(true);
    await flush();
    expect(store.get("ocode.ui-zoom")).toBe("1");

    expect(handleZoomKey(keyEvent({ key: "0" }))).toBe(true);
    await flush();
    expect(styleValues.get("zoom")).toBe("1");
    expect(readZoom()).toBe(1);
  });

  it("ignores keys without the command modifier", () => {
    installDomStubs();
    expect(handleZoomKey(keyEvent({ metaKey: false, ctrlKey: false }))).toBe(false);
    expect(handleZoomKey(keyEvent({ key: "a" }))).toBe(false);
    expect(handleZoomKey(keyEvent({ key: "-", altKey: true }))).toBe(false);
  });

  it("persists zoom through applyZoom", async () => {
    const { store } = installDomStubs();
    await applyZoom(1.5);
    expect(store.get("ocode.ui-zoom")).toBe("1.5");
    expect(readZoom()).toBe(1.5);
  });
});
