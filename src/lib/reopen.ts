// Undo for a shift ended by mistake. When a shift ends, its state just before the end is kept (one shift only,
// the latest) together with its GPS points. Reopening puts it back as tonight's shift and takes it out of the
// history. The next shift that ends replaces the kept one.

import type { ShiftState } from "@/types";
import { deleteRecord } from "./history";
import { loadShift, saveShift } from "./storage";
import { discardTrack } from "./tracking";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "@rr/lastClosed/v1";
export const REOPEN_WINDOW_MS = 12 * 3_600_000;

export type ClosedShift = { recordId: string; closedAt: number; state: ShiftState };

export async function loadClosed(): Promise<ClosedShift | null> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return null;
  const v = JSON.parse(raw) as ClosedShift;
  if (!v || typeof v.recordId !== "string" || typeof v.closedAt !== "number" || !v.state) {
    throw new Error("The saved ended shift isn't in the expected shape.");
  }
  return v;
}

// Keeps `s` as the shift that can be reopened, and deletes the GPS points of the one it replaces.
export async function saveClosed(s: ShiftState, closedAt: number): Promise<void> {
  if (s.startedAt === null) throw new Error("This shift never started.");
  const previous = await loadClosed();
  await AsyncStorage.setItem(KEY, JSON.stringify({ recordId: String(s.startedAt), closedAt, state: s } satisfies ClosedShift));
  if (previous && previous.state.startedAt !== null && previous.state.startedAt !== s.startedAt) await discardTrack(previous.state.startedAt);
}

export async function clearClosed(): Promise<void> {
  const previous = await loadClosed();
  await AsyncStorage.removeItem(KEY);
  if (previous && previous.state.startedAt !== null) await discardTrack(previous.state.startedAt);
}

// Called when a shift is removed from the reports: it can't be reopened after that.
export async function forgetClosed(recordId: string): Promise<void> {
  const closed = await loadClosed();
  if (closed && closed.recordId === recordId) await clearClosed();
}

export const canReopen = (c: ClosedShift | null, now: number): c is ClosedShift => c !== null && now - c.closedAt <= REOPEN_WINDOW_MS;

// Restores the shift as `today`'s. Saved before the history entry is removed, so a failure part-way leaves the shift
// open and its record in place; finishing it again replaces that record rather than doubling it.
export async function reopenShift(today: string, now: number): Promise<ShiftState> {
  const closed = await loadClosed();
  if (!closed) throw new Error("There is no ended shift to reopen.");
  if (!canReopen(closed, now)) throw new Error("That shift ended too long ago to reopen. Remove it from Earnings instead.");
  if (await loadShift(today)) throw new Error("A shift is already open. Finish or reset it first.");
  const state: ShiftState = { ...closed.state, date: today, finishedAt: null };
  await saveShift(state);
  await deleteRecord(closed.recordId);
  await AsyncStorage.removeItem(KEY);   // the points stay: they belong to the shift that is open again
  return state;
}
