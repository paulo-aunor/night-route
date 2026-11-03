// The nightly "start your shift" reminder: its settings, and the weekly notifications they turn into.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { DAY_NAMES, NIGHT_INDEXES, paperDayOfNight } from "./schedule";

const KEY = "@rr/reminders/v1";

export type ReminderSettings = {
  on: boolean;
  hour: number;       // 12 to 23: the evening of the night
  minute: number;
  nights: number[];   // 0 = Sunday night ... 5 = Friday night
};

export const DEFAULT_REMINDERS: ReminderSettings = { on: false, hour: 20, minute: 0, nights: [...NIGHT_INDEXES] };

export const REMINDER_PREFIX = "rr-remind-";

// "20:30" or "8:30 pm" -> hour and minute. Throws a message fit to show.
export function parseTime(text: string): { hour: number; minute: number } {
  const m = text.trim().toLowerCase().match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (!m) throw new Error("Type the time like 20:30 or 8:30 pm.");
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  if (m[3]) {
    if (hour < 1 || hour > 12) throw new Error("With am or pm the hour is 1 to 12.");
    hour = (hour % 12) + (m[3] === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) throw new Error("That isn't a time of day.");
  if (hour < 12) throw new Error("Pick a time from 12:00 to 23:59, so the reminder lands on the evening of that night.");
  return { hour, minute };
}

export const timeText = (hour: number, minute: number): string =>
  `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "pm" : "am"}`;

export type PlannedReminder = { identifier: string; weekday: number; hour: number; minute: number; title: string; body: string };

// One weekly notification per night picked. Weekdays count from 1 = Sunday, as the notification library does.
export function reminderPlan(s: ReminderSettings): PlannedReminder[] {
  if (!s.on) return [];
  return [...new Set(s.nights)].sort((a, b) => a - b).map((night) => {
    if (!NIGHT_INDEXES.includes(night)) throw new Error(`${night} isn't a night worked.`);
    return {
      identifier: REMINDER_PREFIX + night,
      weekday: night + 1,
      hour: s.hour,
      minute: s.minute,
      title: `${DAY_NAMES[night]} night: time to start`,
      body: `${DAY_NAMES[paperDayOfNight(night)]} paper. Open Night Route and pick tonight's routes.`,
    };
  });
}

export async function loadReminders(): Promise<ReminderSettings> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return { ...DEFAULT_REMINDERS, nights: [...DEFAULT_REMINDERS.nights] };
  const v = JSON.parse(raw) as Partial<ReminderSettings>;
  if (typeof v.on !== "boolean" || !Number.isInteger(v.hour) || !Number.isInteger(v.minute) || !Array.isArray(v.nights)) {
    throw new Error("The saved reminder settings aren't in the expected shape.");
  }
  return v as ReminderSettings;
}

export async function saveReminders(s: ReminderSettings): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(s));
}
