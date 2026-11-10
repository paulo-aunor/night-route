// Measures finished shifts along real roads. A shift's distance moved is first the sum of straight segments between
// GPS fixes (known the moment the shift ends, with no signal needed); this goes back over the kept tracks when there
// is signal, has the routing server match each to the road network, and stores the distance along those roads.
//
// Runs from the screens that show distances. Shifts are done one at a time, and the first failure (no signal, a server
// error) stops the run and is kept for the screen to show; the next run tries again.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { decodeTrack, listArchives, loadArchive, saveArchive } from "./archive";
import { setRoadDistance } from "./history";
import { matchTrack, type RoadDeps } from "./roads";

const ERROR_KEY = "@rr/roads/error";

export type SnapReport = { measured: number; failed: boolean; waiting: number; error: string | null };

let running: Promise<SnapReport> | null = null;

// Shifts whose track hasn't been matched yet.
export async function shiftsWaitingForRoads(): Promise<number> {
  let n = 0;
  for (const id of await listArchives()) {
    const a = await loadArchive(id);
    if (a && !a.road) n++;
  }
  return n;
}

export function snapPendingShifts(deps?: RoadDeps, onProgress?: (shift: number, of: number) => void): Promise<SnapReport> {
  running ??= run(deps, onProgress).finally(() => { running = null; });
  return running;
}

// Never throws: whatever goes wrong comes back as `error`, so a screen can start it without handling anything.
async function run(deps?: RoadDeps, onProgress?: (shift: number, of: number) => void): Promise<SnapReport> {
  const waiting: string[] = [];
  let measured = 0, error: string | null = null;
  try {
    for (const id of await listArchives()) {
      const a = await loadArchive(id);
      if (a && !a.road) waiting.push(id);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  for (let i = 0; i < waiting.length && error === null; i++) {
    onProgress?.(i + 1, waiting.length);
    try {
      const a = await loadArchive(waiting[i]);
      if (!a) continue;
      const r = await matchTrack(decodeTrack(a.track), deps);
      await saveArchive({ ...a, road: { meters: r.meters, coverage: r.coverage, at: Date.now() } });
      await setRoadDistance(a.id, r.meters, r.coverage);
      measured++;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      break;
    }
  }
  try {
    if (error === null) await AsyncStorage.removeItem(ERROR_KEY);
    else await AsyncStorage.setItem(ERROR_KEY, error);
  } catch (e) {
    error ??= e instanceof Error ? e.message : String(e);
  }
  return { measured, failed: error !== null, waiting: waiting.length - measured, error };
}

export async function lastRoadError(): Promise<string | null> {
  return AsyncStorage.getItem(ERROR_KEY);
}
