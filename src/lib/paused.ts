import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Persisted set of subscriber IDs that are "stopped" — Paulo paused their
// delivery (vacation, moved out, requested a hold). Stays off until he toggles
// them back on. Independent of per-shift orderedIds and saved orders.
const PAUSED_KEY = "@rr/pausedSubs/v1";

export type PausedMap = Record<string, true>;

export async function loadPaused(): Promise<PausedMap> {
  const raw = await AsyncStorage.getItem(PAUSED_KEY);
  return raw ? (JSON.parse(raw) as PausedMap) : {};
}

// A route update gives surviving houses new ids (built-in houses have numbered
// ids, imported ones are named by address). Copies each stopped house's flag to
// its new id so it stays stopped. The old flag is left alone in case the old
// route is ever restored.
export async function carryPausedTo(idMap: ReadonlyMap<string, string>): Promise<number> {
  const raw = await AsyncStorage.getItem(PAUSED_KEY);
  const paused = raw ? (JSON.parse(raw) as PausedMap) : {};
  let carried = 0;
  for (const [oldId, newId] of idMap) {
    if (paused[oldId] && !paused[newId]) { paused[newId] = true; carried++; }
  }
  if (carried > 0) await AsyncStorage.setItem(PAUSED_KEY, JSON.stringify(paused));
  return carried;
}

export function usePaused() {
  const [paused, setPaused] = useState<PausedMap>({});
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(PAUSED_KEY).then((raw) => {
      setPaused(raw ? (JSON.parse(raw) as PausedMap) : {});
      setReady(true);
    });
  }, []);

  const togglePaused = useCallback(async (id: string) => {
    setPaused((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = true;
      void AsyncStorage.setItem(PAUSED_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const isPaused = useCallback((id: string) => !!paused[id], [paused]);

  return { paused, ready, togglePaused, isPaused };
}
