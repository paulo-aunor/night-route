// Wording for the driving figures, shared by the Earnings screen and the shift review.

import { kmText } from "./history";

export function durationText(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

export const kmhText = (k: number | null): string => (k === null ? "n/a" : `${Math.round(k)} km/h`);

// "2.8 km (10%) more than planned": what the phone measured against the plan. Null when there is nothing to compare.
export function moreThanPlannedText(movedM: number, plannedM: number): string {
  if (plannedM <= 0) return "No plan to compare with.";
  const diff = movedM - plannedM;
  if (Math.abs(diff) < 50) return "About the same as planned.";
  const pct = Math.round((Math.abs(diff) / plannedM) * 100);
  return `${kmText(Math.abs(diff))} (${pct}%) ${diff > 0 ? "more" : "less"} than planned`;
}

export const clockText = (t: number): string => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
