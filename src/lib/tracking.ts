// Records where the phone goes during a shift, so the distance driven is measured rather than estimated.
//
// Google Maps is on screen for most of the drive, so this runs as an Android foreground service (a
// notification stays up while it records) and keeps working with Night Route in the background. Points are
// appended to storage by a background task; the distance is worked out from them when asked.
//
// Importing this file registers the background task, so app/_layout.tsx imports it at startup.

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { checkNearHouse, recordAlertError } from "./alerts";

export const TRACK_TASK = "rr-shift-track";
const POINTS = "@rr/track/points/";   // + shift id (its start time)
const ACTIVE = "@rr/track/active";    // id of the shift being recorded
const LAST_ERROR = "@rr/track/error";

export type TrackPoint = {
  t: number; lat: number; lng: number; acc: number | null;
  // Compass degrees from north, from the fix when the phone is moving (Android reports -1 when standing still).
  // Null when the fix didn't carry one, or a device that doesn't supply it. Used at Re-route to tell which way
  // the car was pointing at the last tick, without having to infer it from the tick order (src/lib/shift.ts).
  hd?: number | null;
};

const MAX_ACCURACY_M = 50;     // fixes less accurate than this are ignored
const MAX_SPEED_MS = 45;       // 162 km/h; a faster jump between fixes is a GPS glitch
const MIN_MOVE_M = 5;          // movement below this, or below the fixes' own error, is the phone standing still

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000, r = (x: number) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Distance along a recorded track. A fix has to move further than the noise before it counts, and the
// reference point only advances when it does, so slow real movement still adds up while a phone resting on
// the seat adds nothing. Walking to a door counts too: this is distance moved, not distance driven by road.
export function trackDistance(points: readonly TrackPoint[]): { meters: number; used: number; dropped: number } {
  const { profile, dropped } = trackProfile(points);
  return { meters: profile.length === 0 ? 0 : profile[profile.length - 1].m, used: profile.length, dropped };
}

// The distance moved so far at each fix that counted: [{ t, m }, ...] with m running up from 0.
export function trackProfile(points: readonly TrackPoint[]): { profile: { t: number; m: number }[]; dropped: number } {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const profile: { t: number; m: number }[] = [];
  let ref: TrackPoint | null = null;
  let meters = 0, dropped = 0;
  for (const p of sorted) {
    if (p.acc !== null && p.acc > MAX_ACCURACY_M) { dropped++; continue; }
    if (ref === null) { ref = p; profile.push({ t: p.t, m: 0 }); continue; }
    const d = haversineM(ref, p);
    const noise = Math.max(MIN_MOVE_M, 0.5 * ((ref.acc ?? 0) + (p.acc ?? 0)));
    if (d < noise) continue;
    const seconds = (p.t - ref.t) / 1000;
    if (seconds <= 0 || d / seconds > MAX_SPEED_MS) { dropped++; continue; }
    meters += d; ref = p;
    profile.push({ t: p.t, m: meters });
  }
  return { profile, dropped };
}

// The most recent compass heading recorded at or before `t` (compass degrees, 0-360). Fixes without a
// heading (the phone was standing still) are skipped. Returns null when nothing in the last `withinMs` ms
// carried one, so a tick after a long pause doesn't get stamped with a stale direction.
export function headingBefore(points: readonly TrackPoint[], t: number, withinMs = 60_000): number | null {
  let best: TrackPoint | null = null;
  for (const p of points) {
    if (p.t > t) continue;
    if (p.hd == null) continue;
    if (p.acc !== null && p.acc > 50) continue;
    if (best === null || p.t > best.t) best = p;
  }
  if (best === null || t - best.t > withinMs) return null;
  return best.hd as number;
}

// Metres moved by time `t`, from a profile: the figure at the last fix at or before it.
export function metersAt(profile: readonly { t: number; m: number }[], t: number): number {
  let lo = 0, hi = profile.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (profile[mid].t <= t) { best = profile[mid].m; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// ---- storage ----

async function loadPoints(id: number): Promise<TrackPoint[]> {
  const raw = await AsyncStorage.getItem(POINTS + id);
  if (!raw) return [];
  const v = JSON.parse(raw) as unknown;
  if (!Array.isArray(v)) throw new Error("The saved GPS track isn't in the expected shape.");
  return v as TrackPoint[];
}

let writing: Promise<unknown> = Promise.resolve();
// Appends in order, one write at a time, so batches from the background task can't overwrite each other.
function appendPoints(id: number, add: TrackPoint[]): Promise<void> {
  const run = writing.then(async () => {
    const all = await loadPoints(id);
    await AsyncStorage.setItem(POINTS + id, JSON.stringify(all.concat(add)));
  });
  writing = run.catch(() => undefined);
  return run;
}

// The background task. It has no screen to report to, so a failure is stored for the shift screen to show.
TaskManager.defineTask(TRACK_TASK, async ({ data, error }) => {
  try {
    if (error) throw new Error(error.message);
    const active = await AsyncStorage.getItem(ACTIVE);
    if (active === null) return;
    const { locations } = data as { locations: Location.LocationObject[] };
    await appendPoints(Number(active), locations.map((l) => ({
      t: l.timestamp, lat: l.coords.latitude, lng: l.coords.longitude, acc: l.coords.accuracy,
      // Android returns -1 when the phone isn't moving fast enough to tell; store that as null.
      hd: l.coords.heading == null || l.coords.heading < 0 ? null : l.coords.heading,
    })));
    // Each fix is also a chance to tell the driver they are near the next house. A failure there is not a GPS failure.
    const last = locations[locations.length - 1];
    if (last) await checkNearHouse({ lat: last.coords.latitude, lng: last.coords.longitude }).catch(recordAlertError);
  } catch (e) {
    await AsyncStorage.setItem(LAST_ERROR, e instanceof Error ? e.message : String(e));
  }
});

// ---- control ----

export async function startTracking(shiftId: number): Promise<void> {
  if (!(await Location.hasServicesEnabledAsync())) throw new Error("Location is switched off on the phone.");
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") throw new Error("Location permission wasn't granted.");
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== "granted") {
    throw new Error("Background location ('Allow all the time') wasn't granted, so the distance can't be recorded while Google Maps is open. Change it in the phone's app settings for Night Route.");
  }
  await AsyncStorage.removeItem(LAST_ERROR);
  await AsyncStorage.setItem(ACTIVE, String(shiftId));
  if (!(await Location.hasStartedLocationUpdatesAsync(TRACK_TASK))) {
    await Location.startLocationUpdatesAsync(TRACK_TASK, {
      accuracy: Location.Accuracy.High,
      distanceInterval: 10,
      timeInterval: 5000,
      pausesUpdatesAutomatically: false,
      foregroundService: {
        notificationTitle: "Night Route",
        notificationBody: "Recording tonight's distance",
        notificationColor: "#4ade80",
      },
    });
  }
}

export async function isTracking(shiftId: number): Promise<boolean> {
  return (await AsyncStorage.getItem(ACTIVE)) === String(shiftId) && (await Location.hasStartedLocationUpdatesAsync(TRACK_TASK));
}

export async function trackedPoints(shiftId: number): Promise<TrackPoint[]> {
  return loadPoints(shiftId);
}

// Metres moved so far in this shift's recording; null when it was never recorded.
export async function trackedMeters(shiftId: number): Promise<number | null> {
  const points = await loadPoints(shiftId);
  return points.length === 0 ? null : trackDistance(points).meters;
}

export async function lastTrackError(): Promise<string | null> {
  return AsyncStorage.getItem(LAST_ERROR);
}

// Ends the recording and deletes the points, unless `keepPoints`: a shift that has just ended keeps them so it can be
// reopened (see reopen.ts); discardTrack deletes them later.
export async function stopTracking(shiftId: number, keepPoints = false): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(TRACK_TASK)) await Location.stopLocationUpdatesAsync(TRACK_TASK);
  if ((await AsyncStorage.getItem(ACTIVE)) === String(shiftId)) await AsyncStorage.removeItem(ACTIVE);
  if (!keepPoints) await discardTrack(shiftId);
}

export async function discardTrack(shiftId: number): Promise<void> {
  await AsyncStorage.removeItem(POINTS + shiftId);
}
