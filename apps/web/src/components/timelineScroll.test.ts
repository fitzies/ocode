import { describe, expect, it } from "vitest";
import {
  clampTimelineScrollTop,
  isTimelineNavigationKey,
  nextTimelineJumpScrollTop,
  timelineRearmDecision,
  TIMELINE_FOLLOW_THRESHOLD_PX,
  timelineDistanceFromEnd,
  timelineIsAtEnd,
} from "./timelineScroll";

describe("timeline scroll geometry", () => {
  it("measures distance from the real content bottom", () => {
    expect(timelineDistanceFromEnd({ scrollTop: 1_160, scrollHeight: 2_000, clientHeight: 800 })).toBe(40);
  });

  it("re-arms follow only inside the small bottom band", () => {
    expect(timelineIsAtEnd({ scrollTop: 1_160, scrollHeight: 2_000, clientHeight: 800 })).toBe(true);
    expect(timelineIsAtEnd({ scrollTop: 1_159, scrollHeight: 2_000, clientHeight: 800 })).toBe(false);
    expect(TIMELINE_FOLLOW_THRESHOLD_PX).toBe(40);
  });

  it("treats content shorter than the viewport as already at the end", () => {
    expect(timelineIsAtEnd({ scrollTop: 0, scrollHeight: 500, clientHeight: 800 })).toBe(true);
  });

  it("clamps remembered positions to the currently available scroll range", () => {
    expect(clampTimelineScrollTop(900, 1_500, 800)).toBe(700);
    expect(clampTimelineScrollTop(-20, 1_500, 800)).toBe(0);
  });

  it("does not rearm inside the bottom band immediately after explicit upward navigation", () => {
    expect(timelineRearmDecision(false, true)).toEqual({ canRearm: false, shouldFollow: false });
    expect(timelineRearmDecision(false, false)).toEqual({ canRearm: true, shouldFollow: false });
    expect(timelineRearmDecision(true, true)).toEqual({ canRearm: true, shouldFollow: true });
  });

  it("recognizes upward and downward keyboard navigation that must cancel a jump", () => {
    for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]) {
      expect(isTimelineNavigationKey(key)).toBe(true);
    }
    expect(isTimelineNavigationKey("Enter")).toBe(false);
  });

  it("stops a jump animation as soon as user navigation invalidates it", () => {
    expect(nextTimelineJumpScrollTop({ start: 100, target: 900, elapsed: 90, active: true })).toBeGreaterThan(100);
    expect(nextTimelineJumpScrollTop({ start: 100, target: 900, elapsed: 90, active: false })).toBeUndefined();
  });

  it("finishes an active jump at its latest target", () => {
    expect(nextTimelineJumpScrollTop({ start: 100, target: 940, elapsed: 500, active: true })).toBe(940);
  });
});
