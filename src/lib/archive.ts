// Everything about a finished shift that a later review or analysis needs, kept as one self-contained file per shift:
// the GPS track, the houses with their coordinates, the order planned at the start, and when each house was ticked.
// Files rather than AsyncStorage: a year of tracks would pass what Android's key-value store holds.

import * as FileSystem from "expo-file-system/legacy";
import type { Optimization, ShiftState } from "@/types";
import { analyzeShift, type ShiftAnalysis } from "./driving";
import type { TrackPoint } from "./tracking";

export type ArchivedHouse = { id: string; routeId: string; address: string; lat: number; lng: number };

// A track as flat numbers, six per point: time since the previous point in ms (the first: since `t0`), then changes
// in latitude and longitude (millionths of a degree, about 0.1 m), accuracy in metres, heading in degrees and speed
// in tenths of m/s (-1 where unknown). About 30 bytes a point.
export type EncodedTrack = { t0: number; n: number; d: number[] };

export type ShiftArchive = {
  v: 1;
  id: string;
  startedAt: number;
  finishedAt: number;
  routeIds: string[];
  paperDay: number;
  startMode: string;
  startCoord?: { lat: number; lng: number };
  houses: ArchivedHouse[];
  plannedOrder: string[] | null;     // the order the shift started with; null for a shift begun before it was kept
  orderedIds: string[];              // the order at the end, after re-routes and drags
  tickOrder: string[];
  tickAt: Record<string, number>;
  headingAt: Record<string, number>;
  stoppedIds: string[];
  optimizations: Optimization[];
  track: EncodedTrack;
  road?: { meters: number; coverage: number; at: number };   // the track matched to roads (roadSnap.ts); absent until it has run
};

const round = (x: number) => Math.round(x);

export function encodeTrack(points: readonly TrackPoint[], t0: number): EncodedTrack {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const d: number[] = [];
  let pt = t0, plat = 0, plng = 0;
  for (const p of sorted) {
    const lat = round(p.lat * 1e6), lng = round(p.lng * 1e6);
    d.push(p.t - pt, lat - plat, lng - plng, p.acc == null ? -1 : round(p.acc), p.hd == null ? -1 : round(p.hd), p.sp == null ? -1 : round(p.sp * 10));
    pt = p.t; plat = lat; plng = lng;
  }
  return { t0, n: sorted.length, d };
}

export function decodeTrack(e: EncodedTrack): TrackPoint[] {
  if (e.d.length !== e.n * 6) throw new Error("The saved GPS track is damaged: its length doesn't match its point count.");
  const out: TrackPoint[] = [];
  let t = e.t0, lat = 0, lng = 0;
  for (let i = 0; i < e.n; i++) {
    const [dt, dlat, dlng, acc, hd, sp] = e.d.slice(i * 6, i * 6 + 6);
    t += dt; lat += dlat; lng += dlng;
    out.push({ t, lat: lat / 1e6, lng: lng / 1e6, acc: acc < 0 ? null : acc, hd: hd < 0 ? null : hd, sp: sp < 0 ? null : sp / 10 });
  }
  return out;
}

export function buildArchive(s: ShiftState, ctx: { points: readonly TrackPoint[]; houses: readonly ArchivedHouse[]; stoppedIds: readonly string[]; finishedAt: number }): ShiftArchive {
  if (s.startedAt === null) throw new Error("This shift never started, so there is nothing to keep.");
  if (s.deliveryDayIdx === undefined) throw new Error("This shift has no paper day recorded.");
  return {
    v: 1,
    id: String(s.startedAt),
    startedAt: s.startedAt,
    finishedAt: ctx.finishedAt,
    routeIds: [...s.routeIds],
    paperDay: s.deliveryDayIdx,
    startMode: s.startMode ?? "library",
    ...(s.startCoord ? { startCoord: s.startCoord } : {}),
    houses: [...ctx.houses],
    plannedOrder: s.startOrder ? [...s.startOrder] : null,
    orderedIds: [...s.orderedIds],
    tickOrder: s.deliveredIds.filter((id) => s.deliveredAt?.[id] !== undefined),
    tickAt: { ...s.deliveredAt },
    headingAt: { ...s.headingAt },
    stoppedIds: [...ctx.stoppedIds],
    optimizations: [...(s.optimizations ?? [])],
    track: encodeTrack(ctx.points, s.startedAt),
  };
}

export function analyzeArchive(a: ShiftArchive): ShiftAnalysis {
  return analyzeShift({
    points: decodeTrack(a.track),
    houses: a.houses,
    tickAt: a.tickAt,
    tickOrder: a.tickOrder,
    plannedOrder: a.plannedOrder,
    startedAt: a.startedAt,
  });
}

// ---- files ----

function dir(): string {
  if (!FileSystem.documentDirectory) throw new Error("The phone gave the app no folder to keep shift records in.");
  return `${FileSystem.documentDirectory}shift-archive/`;
}
const fileOf = (id: string) => `${dir()}${id}.json`;

export async function saveArchive(a: ShiftArchive): Promise<void> {
  const d = dir();
  if (!(await FileSystem.getInfoAsync(d)).exists) await FileSystem.makeDirectoryAsync(d, { intermediates: true });
  await FileSystem.writeAsStringAsync(fileOf(a.id), JSON.stringify(a));
}

export async function loadArchive(id: string): Promise<ShiftArchive | null> {
  const f = fileOf(id);
  if (!(await FileSystem.getInfoAsync(f)).exists) return null;
  const v = JSON.parse(await FileSystem.readAsStringAsync(f)) as ShiftArchive;
  if (v.v !== 1 || v.id !== id || !v.track) throw new Error(`The saved record for shift ${id} isn't in the expected shape.`);
  return v;
}

// Ids of the kept shifts, newest first.
export async function listArchives(): Promise<string[]> {
  const d = dir();
  if (!(await FileSystem.getInfoAsync(d)).exists) return [];
  return (await FileSystem.readDirectoryAsync(d)).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort((a, b) => Number(b) - Number(a));
}

export async function deleteArchive(id: string): Promise<void> {
  await FileSystem.deleteAsync(fileOf(id), { idempotent: true });
}

// Every kept shift in one file, for sharing out of the app. Returns the file's address and how many shifts it holds.
export async function exportArchives(now: number): Promise<{ uri: string; shifts: number }> {
  if (!FileSystem.cacheDirectory) throw new Error("The phone gave the app no folder to write the export in.");
  const ids = await listArchives();
  const shifts: ShiftArchive[] = [];
  for (const id of ids) {
    const a = await loadArchive(id);
    if (a) shifts.push(a);
  }
  const uri = `${FileSystem.cacheDirectory}night-route-driving-data-${new Date(now).toISOString().slice(0, 10)}.json`;
  await FileSystem.writeAsStringAsync(uri, JSON.stringify({ app: "night-route", format: 1, exportedAt: now, shifts }));
  return { uri, shifts: shifts.length };
}
