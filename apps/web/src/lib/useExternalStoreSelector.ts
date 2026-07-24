import { useCallback, useRef, useSyncExternalStore } from "react";

export function useExternalStoreSelector<TSnapshot, TSelection>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => TSnapshot,
  selector: (snapshot: TSnapshot) => TSelection,
  isEqual: (left: TSelection, right: TSelection) => boolean = Object.is,
): TSelection {
  const cache = useRef<{ snapshot: TSnapshot; selection: TSelection } | undefined>(undefined);
  const getSelection = useCallback(() => {
    const snapshot = getSnapshot();
    const previous = cache.current;
    if (previous?.snapshot === snapshot) return previous.selection;

    const selection = selector(snapshot);
    if (previous && isEqual(previous.selection, selection)) {
      cache.current = { snapshot, selection: previous.selection };
      return previous.selection;
    }

    cache.current = { snapshot, selection };
    return selection;
  }, [getSnapshot, isEqual, selector]);

  return useSyncExternalStore(subscribe, getSelection, getSelection);
}
