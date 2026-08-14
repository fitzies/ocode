import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  TouchEvent as ReactTouchEvent,
  UIEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

export const TIMELINE_FOLLOW_THRESHOLD_PX = 40;
const JUMP_ANIMATION_MS = 180;
const MAX_REMEMBERED_TIMELINES = 100;
const RESTORE_STABILITY_MS = 120;

type TimelineScrollMode = "following" | "restoring" | "detached";

export interface TimelineScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface TimelineScrollAnchor {
  key: string;
  offset: number;
}

interface RememberedTimelinePosition {
  scrollTop: number;
  following: boolean;
  anchor?: TimelineScrollAnchor;
}

// View state is intentionally tab-local: revisiting a thread restores it, while a fresh app session opens at latest.
const rememberedTimelinePositions = new Map<string, RememberedTimelinePosition>();

export function timelineDistanceFromEnd({ scrollTop, scrollHeight, clientHeight }: TimelineScrollGeometry): number {
  return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

export function timelineIsAtEnd(
  geometry: TimelineScrollGeometry,
  threshold = TIMELINE_FOLLOW_THRESHOLD_PX,
): boolean {
  return timelineDistanceFromEnd(geometry) <= threshold;
}

export function clampTimelineScrollTop(scrollTop: number, scrollHeight: number, clientHeight: number): number {
  return Math.max(0, Math.min(scrollTop, Math.max(0, scrollHeight - clientHeight)));
}

export function isTimelineNavigationKey(key: string): boolean {
  return key === "ArrowUp" || key === "ArrowDown" || key === "PageUp" ||
    key === "PageDown" || key === "Home" || key === "End" || key === " ";
}

export function timelineRearmDecision(canRearm: boolean, atEnd: boolean): {
  canRearm: boolean;
  shouldFollow: boolean;
} {
  if (!atEnd) return { canRearm: true, shouldFollow: false };
  return { canRearm, shouldFollow: canRearm };
}

export function nextTimelineJumpScrollTop({
  start,
  target,
  elapsed,
  active,
}: {
  start: number;
  target: number;
  elapsed: number;
  active: boolean;
}): number | undefined {
  if (!active) return undefined;
  const progress = Math.min(1, Math.max(0, elapsed) / JUMP_ANIMATION_MS);
  const eased = 1 - Math.pow(1 - progress, 3);
  return start + (target - start) * eased;
}

function rememberTimelinePosition(sessionId: string, position: RememberedTimelinePosition): void {
  rememberedTimelinePositions.delete(sessionId);
  rememberedTimelinePositions.set(sessionId, position);
  while (rememberedTimelinePositions.size > MAX_REMEMBERED_TIMELINES) {
    const oldest = rememberedTimelinePositions.keys().next().value;
    if (oldest === undefined) break;
    rememberedTimelinePositions.delete(oldest);
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Keeps live output pinned without treating layout growth as user navigation. */
export function useTimelineScroll({
  sessionId,
  hasEntries,
  loading,
  scrollRef,
  contentRef,
  getAnchor,
  restoreAnchor,
}: {
  sessionId: string;
  hasEntries: boolean;
  loading: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  getAnchor?: () => TimelineScrollAnchor | undefined;
  restoreAnchor?: (anchor: TimelineScrollAnchor) => boolean;
}) {
  const remembered = useMemo(() => rememberedTimelinePositions.get(sessionId), [sessionId]);
  const initialMode: TimelineScrollMode = remembered && !remembered.following ? "restoring" : "following";
  const modeRef = useRef<TimelineScrollMode>(initialMode);
  const restoreScrollTopRef = useRef(initialMode === "restoring" ? remembered?.scrollTop ?? 0 : null);
  const restoreAnchorRef = useRef(initialMode === "restoring" ? remembered?.anchor : undefined);
  const getAnchorRef = useRef(getAnchor);
  getAnchorRef.current = getAnchor;
  const restoreAnchorAdapterRef = useRef(restoreAnchor);
  restoreAnchorAdapterRef.current = restoreAnchor;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const navigationGenerationRef = useRef(0);
  const scrollFrameRef = useRef<number | undefined>(undefined);
  const restoreTimerRef = useRef<number | undefined>(undefined);
  const jumpAnimatingRef = useRef(false);
  const canRearmRef = useRef(true);
  const touchNavigatingRef = useRef(false);
  const pointerNavigatingRef = useRef(false);
  const isFollowingRef = useRef(initialMode === "following");
  const [following, setFollowing] = useState(initialMode === "following");

  const saveCurrentPosition = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || !hasEntries || modeRef.current === "restoring") return;
    const anchor = modeRef.current === "detached" ? getAnchorRef.current?.() : undefined;
    rememberTimelinePosition(sessionId, {
      scrollTop: scroller.scrollTop,
      following: modeRef.current === "following",
      ...(anchor ? { anchor } : {}),
    });
  }, [hasEntries, scrollRef, sessionId]);

  const setMode = useCallback((mode: Exclude<TimelineScrollMode, "restoring">) => {
    modeRef.current = mode;
    isFollowingRef.current = mode === "following";
    if (mode === "following") canRearmRef.current = true;
    restoreScrollTopRef.current = null;
    restoreAnchorRef.current = undefined;
    setFollowing(mode === "following");
  }, []);

  const cancelScheduledScroll = useCallback(() => {
    if (scrollFrameRef.current !== undefined) cancelAnimationFrame(scrollFrameRef.current);
    if (restoreTimerRef.current !== undefined) clearTimeout(restoreTimerRef.current);
    scrollFrameRef.current = undefined;
    restoreTimerRef.current = undefined;
    jumpAnimatingRef.current = false;
  }, []);

  const scheduleScrollToLatest = useCallback(() => {
    if (scrollFrameRef.current !== undefined) return;
    const generation = navigationGenerationRef.current;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = undefined;
      const scroller = scrollRef.current;
      if (!scroller || modeRef.current !== "following" || generation !== navigationGenerationRef.current) return;
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      saveCurrentPosition();
    });
  }, [saveCurrentPosition, scrollRef]);

  const animateScrollToLatest = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || scrollFrameRef.current !== undefined) return;
    const generation = navigationGenerationRef.current;
    jumpAnimatingRef.current = true;
    const startScrollTop = scroller.scrollTop;
    const startedAt = typeof performance === "undefined" ? Date.now() : performance.now();
    const step = (now: number) => {
      scrollFrameRef.current = undefined;
      const target = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const elapsed = Math.max(0, now - startedAt);
      const nextScrollTop = nextTimelineJumpScrollTop({
        start: startScrollTop,
        target,
        elapsed,
        active: modeRef.current === "following" && generation === navigationGenerationRef.current,
      });
      if (nextScrollTop === undefined) {
        jumpAnimatingRef.current = false;
        return;
      }
      scroller.scrollTop = nextScrollTop;
      if (elapsed < JUMP_ANIMATION_MS) {
        scrollFrameRef.current = requestAnimationFrame(step);
      } else {
        jumpAnimatingRef.current = false;
        saveCurrentPosition();
      }
    };
    scrollFrameRef.current = requestAnimationFrame(step);
  }, [saveCurrentPosition, scrollRef]);

  const applyRestoredPosition = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || modeRef.current !== "restoring") return;
    const anchor = restoreAnchorRef.current;
    if (anchor && restoreAnchorAdapterRef.current?.(anchor)) return;
    const target = restoreScrollTopRef.current;
    if (target === null) return;
    scroller.scrollTop = clampTimelineScrollTop(target, scroller.scrollHeight, scroller.clientHeight);
  }, [scrollRef]);

  const scheduleRestoreCompletion = useCallback(() => {
    if (modeRef.current !== "restoring" || loadingRef.current) return;
    if (restoreTimerRef.current !== undefined) clearTimeout(restoreTimerRef.current);
    const generation = navigationGenerationRef.current;
    restoreTimerRef.current = window.setTimeout(() => {
      restoreTimerRef.current = undefined;
      if (
        generation !== navigationGenerationRef.current ||
        modeRef.current !== "restoring" ||
        loadingRef.current
      ) return;
      applyRestoredPosition();
      setMode("detached");
      saveCurrentPosition();
    }, RESTORE_STABILITY_MS);
  }, [applyRestoredPosition, saveCurrentPosition, setMode]);

  const detachForUserNavigation = useCallback((requireEndBandDeparture = false) => {
    const scroller = scrollRef.current;
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return;
    navigationGenerationRef.current += 1;
    cancelScheduledScroll();
    if (requireEndBandDeparture) canRearmRef.current = false;
    else if (!timelineIsAtEnd(scroller)) canRearmRef.current = true;
    setMode("detached");
    saveCurrentPosition();
  }, [cancelScheduledScroll, saveCurrentPosition, scrollRef, setMode]);

  const followLatest = useCallback((animated = true) => {
    navigationGenerationRef.current += 1;
    cancelScheduledScroll();
    setMode("following");
    if (animated && !prefersReducedMotion()) animateScrollToLatest();
    else scheduleScrollToLatest();
  }, [animateScrollToLatest, cancelScheduledScroll, scheduleScrollToLatest, setMode]);

  useLayoutEffect(() => {
    if (!hasEntries) return;
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;

    const maintainPosition = () => {
      // Immediate adjustments are steadier than queueing animations for every streamed layout change.
      if (modeRef.current === "following") scheduleScrollToLatest();
      else if (modeRef.current === "restoring") {
        applyRestoredPosition();
        scheduleRestoreCompletion();
      }
    };

    maintainPosition();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(maintainPosition);
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [
    applyRestoredPosition,
    contentRef,
    hasEntries,
    loading,
    scheduleRestoreCompletion,
    scheduleScrollToLatest,
    scrollRef,
  ]);

  useLayoutEffect(() => () => {
    saveCurrentPosition();
    cancelScheduledScroll();
  }, [cancelScheduledScroll, saveCurrentPosition]);

  const handlers = useMemo(() => ({
    onScroll: (event: UIEvent<HTMLDivElement>) => {
      const scroller = event.currentTarget;
      const atEnd = timelineIsAtEnd(scroller);
      if (modeRef.current === "restoring") {
        if ((touchNavigatingRef.current || pointerNavigatingRef.current) && !atEnd) detachForUserNavigation();
        return;
      }
      if (modeRef.current === "following" && (touchNavigatingRef.current || pointerNavigatingRef.current) && !atEnd) {
        detachForUserNavigation();
        return;
      }
      if (modeRef.current === "detached") {
        const decision = timelineRearmDecision(canRearmRef.current, atEnd);
        canRearmRef.current = decision.canRearm;
        if (decision.shouldFollow) {
          setMode("following");
          scheduleScrollToLatest();
        }
      }
      saveCurrentPosition();
    },
    onWheel: (event: ReactWheelEvent<HTMLDivElement>) => {
      if (jumpAnimatingRef.current || modeRef.current === "restoring" || event.deltaY < 0) {
        detachForUserNavigation(event.deltaY < 0);
      } else if (modeRef.current === "detached" && event.deltaY > 0) {
        canRearmRef.current = true;
      }
    },
    onTouchStart: () => {
      touchNavigatingRef.current = true;
      if (jumpAnimatingRef.current) detachForUserNavigation(true);
    },
    onTouchMove: (event: ReactTouchEvent<HTMLDivElement>) => {
      if (!timelineIsAtEnd(event.currentTarget)) detachForUserNavigation();
    },
    onTouchEnd: () => {
      touchNavigatingRef.current = false;
    },
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      pointerNavigatingRef.current = event.target === event.currentTarget;
      if (jumpAnimatingRef.current && pointerNavigatingRef.current) detachForUserNavigation(true);
    },
    onPointerUp: () => {
      pointerNavigatingRef.current = false;
    },
    onPointerCancel: () => {
      pointerNavigatingRef.current = false;
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const navigationKey = isTimelineNavigationKey(event.key);
      const navigatingUp = event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home";
      if (
        (jumpAnimatingRef.current && navigationKey) ||
        (modeRef.current === "restoring" && navigationKey) ||
        navigatingUp
      ) {
        detachForUserNavigation(navigatingUp);
      } else if (modeRef.current === "detached" && navigationKey) {
        canRearmRef.current = true;
      }
    },
  }), [detachForUserNavigation, saveCurrentPosition, scheduleScrollToLatest, setMode]);

  return { following, isFollowingRef, followLatest, handlers };
}
