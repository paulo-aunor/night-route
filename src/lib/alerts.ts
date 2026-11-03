// Notifications for a shift: one ongoing notification showing the next house with Delivered and Navigate buttons, a
// short alert when the car comes near that house, and the nightly reminder.
//
// The Delivered button has to work with Night Route in the background or closed. On Android the library hands the
// press to a background task (registered below, at import) when the app isn't on screen, and to a listener when it
// is. Both end up in handleAction, and ticking a house twice is harmless.
//
// Importing this file registers the task and the handler, so app/_layout.tsx imports it at startup.

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { DEPOT_NOTES } from "@/data/depot-notes";
import type { ShiftState, Subscriber } from "@/types";
import { openInGoogleMaps } from "./navigation";
import { markDeliveredState, nearStep, nextStop, stopsLeft, houseLine, type NearState } from "./nextHouse";
import { loadNotes, noteKey } from "./notes";
import { haversineM } from "./optimizer-v2";
import { loadPaused } from "./paused";
import { REMINDER_PREFIX, reminderPlan, type ReminderSettings } from "./reminders";
import { allSubscribers, loadRegistry } from "./registry";
import { announceShiftChanged } from "./shiftEvents";
import { loadActiveShift, saveShift } from "./storage";

export const ACTION_TASK = "rr-notification-action";
export const NEXT_ID = "rr-next";
export const NEAR_ID = "rr-near";
export const ACTION_DONE = "delivered";
export const ACTION_NAV = "navigate";
const CATEGORY = "rr-house";
const CH_NEXT = "rr-next-house";
const CH_NEAR = "rr-near-house";
const CH_REMIND = "rr-reminder";
const NEAR_KEY = "@rr/alerts/near";
const LAST_ERROR = "@rr/alerts/error";
const HANDLED_KEY = "@rr/alerts/handled";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// What the phone does with a notification that arrives while Night Route is on screen.
Notifications.setNotificationHandler({
  handleNotification: async (n) => ({
    shouldShowBanner: n.request.identifier !== NEXT_ID,   // the ongoing one updates quietly
    shouldShowList: true,
    shouldPlaySound: n.request.identifier === NEAR_ID,
    shouldSetBadge: false,
  }),
});

let setup: Promise<void> | null = null;
// Channels (Android's sound and priority settings) and the buttons. Safe to call again.
function ensureSetup(): Promise<void> {
  setup ??= (async () => {
    await Notifications.setNotificationChannelAsync(CH_NEXT, { name: "Next house", importance: Notifications.AndroidImportance.LOW });
    await Notifications.setNotificationChannelAsync(CH_NEAR, { name: "Near the next house", importance: Notifications.AndroidImportance.HIGH });
    await Notifications.setNotificationChannelAsync(CH_REMIND, { name: "Nightly reminder", importance: Notifications.AndroidImportance.DEFAULT });
    await Notifications.setNotificationCategoryAsync(CATEGORY, [
      { identifier: ACTION_DONE, buttonTitle: "Delivered", options: { opensAppToForeground: false } },
      { identifier: ACTION_NAV, buttonTitle: "Navigate", options: { opensAppToForeground: true } },
    ]);
  })().catch((e) => { setup = null; throw e; });
  return setup;
}

// Whether notifications are allowed; with `ask`, shows the system prompt if it hasn't been answered.
export async function notificationsAllowed(ask: boolean): Promise<boolean> {
  const now = await Notifications.getPermissionsAsync();
  if (now.granted) return true;
  if (!ask || !now.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

export const NOTIFICATIONS_OFF = "Notifications are off for Night Route. Allow them in the phone's settings under Apps, Night Route, Notifications.";

async function houseMap(): Promise<Map<string, Subscriber>> {
  await loadRegistry();
  return new Map(allSubscribers().map((h) => [h.id, h]));
}

async function lineFor(h: Subscriber): Promise<string> {
  const notes = await loadNotes();
  return houseLine(h, DEPOT_NOTES[h.id] ?? h.note, notes[noteKey(h)]);
}

// The ongoing notification for the shift as it stands: the next house and how many are left. When nothing is left
// it says so, and Shift done removes it.
export async function showNextHouse(s: ShiftState, paused: Readonly<Record<string, true>>, houses: ReadonlyMap<string, Subscriber>): Promise<void> {
  if (s.startedAt === null) throw new Error("This shift never started.");
  await ensureSetup();
  const next = nextStop(s, paused, houses);
  const content: Notifications.NotificationContentInput = next
    ? {
        title: `Next: ${next.address}`,
        body: `${await lineFor(next)} · ${stopsLeft(s, paused, houses)} left`,
        categoryIdentifier: CATEGORY,
        data: { houseId: next.id, shift: s.startedAt },
        sticky: true,
        autoDismiss: false,
      }
    : { title: "All delivered", body: "Open Night Route and tap Shift done.", sticky: true, autoDismiss: false, data: { shift: s.startedAt } };
  await Notifications.scheduleNotificationAsync({ identifier: NEXT_ID, content, trigger: { channelId: CH_NEXT } });
}

// Keeps the ongoing notification in step with the shift on screen. Throws if notifications are off.
export async function syncNextHouse(s: ShiftState | null, paused: Readonly<Record<string, true>>, ask: boolean): Promise<void> {
  if (s === null || s.finishedAt !== null) { await clearHouseNotifications(); return; }
  if (!(await notificationsAllowed(ask))) throw new Error(NOTIFICATIONS_OFF);
  await showNextHouse(s, paused, await houseMap());
}

export async function clearHouseNotifications(): Promise<void> {
  await Notifications.dismissNotificationAsync(NEXT_ID);
  await Notifications.dismissNotificationAsync(NEAR_ID);
  await AsyncStorage.removeItem(NEAR_KEY);
}

async function showNearAlert(h: Subscriber, s: ShiftState, distM: number): Promise<void> {
  if (s.startedAt === null) throw new Error("This shift never started.");
  await ensureSetup();
  await Notifications.scheduleNotificationAsync({
    identifier: NEAR_ID,
    content: {
      title: `Near: ${h.address}`,
      body: `${Math.round(distM)} m away · ${await lineFor(h)}`,
      categoryIdentifier: CATEGORY,
      data: { houseId: h.id, shift: s.startedAt },
      sticky: false,
      autoDismiss: true,
    },
    trigger: { channelId: CH_NEAR },
  });
}

// Called with each GPS fix while a shift is recording. Alerts once when the car comes within NEAR_M of the next house.
export async function checkNearHouse(fix: { lat: number; lng: number }): Promise<void> {
  const s = await loadActiveShift();
  if (s === null || s.startedAt === null) return;
  if (!(await notificationsAllowed(false))) return;   // the shift screen says notifications are off
  const houses = await houseMap();
  const next = nextStop(s, await loadPaused(), houses);
  if (next === null) return;
  const raw = await AsyncStorage.getItem(NEAR_KEY);
  const step = nearStep(raw ? (JSON.parse(raw) as NearState) : null, s.startedAt, next.id, haversineM(fix, next));
  await AsyncStorage.setItem(NEAR_KEY, JSON.stringify(step.state));
  if (step.alert) await showNearAlert(next, s, haversineM(fix, next));
}

// Ticks a house from a notification button: the same change as ticking it in the app, saved, then the notification
// moves on to the next house. A button on a notification from an older shift does nothing.
async function deliverFromNotification(houseId: string, shiftId: number | undefined): Promise<void> {
  const s = await loadActiveShift();
  if (s === null || s.startedAt === null || (shiftId !== undefined && shiftId !== s.startedAt)) return;
  if (!s.orderedIds.includes(houseId)) return;
  const next = markDeliveredState(s, houseId, Date.now());
  if (next === s) return;
  await saveShift(next);
  announceShiftChanged();
  await showNextHouse(next, await loadPaused(), await houseMap());
  await Notifications.dismissNotificationAsync(NEAR_ID);
}

type ActionData = { houseId?: string; shift?: number };

export async function handleAction(response: Notifications.NotificationResponse): Promise<void> {
  const { houseId, shift } = response.notification.request.content.data as ActionData;
  if (response.actionIdentifier === ACTION_DONE) {
    if (!houseId) throw new Error("The notification has no house in it.");
    await deliverFromNotification(houseId, shift);
  } else if (response.actionIdentifier === ACTION_NAV) {
    if (!houseId) throw new Error("The notification has no house in it.");
    const house = (await houseMap()).get(houseId);
    if (!house) throw new Error("That house is no longer on a route.");
    await openInGoogleMaps(house);
  }
}

// A cold start from the Navigate button hands the response over as "last response". Handle it once.
export async function handleLaunchResponse(response: Notifications.NotificationResponse): Promise<void> {
  const key = `${response.notification.date}|${response.actionIdentifier}`;
  if ((await AsyncStorage.getItem(HANDLED_KEY)) === key) return;
  await AsyncStorage.setItem(HANDLED_KEY, key);
  await handleAction(response);
}

export async function lastAlertError(): Promise<string | null> {
  return AsyncStorage.getItem(LAST_ERROR);
}
export async function recordAlertError(e: unknown): Promise<void> {
  await AsyncStorage.setItem(LAST_ERROR, errText(e));
}
export async function clearAlertError(): Promise<void> {
  await AsyncStorage.removeItem(LAST_ERROR);
}

// The background task: a button pressed while the app isn't on screen. It has no screen to report to, so a failure
// is stored for the shift screen to show.
TaskManager.defineTask(ACTION_TASK, async ({ data, error }) => {
  try {
    if (error) throw new Error(error.message);
    const payload = data as Partial<Notifications.NotificationResponse> | undefined;
    if (payload && "actionIdentifier" in payload) await handleAction(payload as Notifications.NotificationResponse);
  } catch (e) {
    await recordAlertError(e);
  }
});
Notifications.registerTaskAsync(ACTION_TASK).catch((e: unknown) => recordAlertError(e));

// ---- the nightly reminder ----

// Replaces the scheduled reminders with the ones these settings describe.
export async function applyReminders(s: ReminderSettings): Promise<number> {
  const plan = reminderPlan(s);
  if (plan.length > 0 && !(await notificationsAllowed(true))) throw new Error(NOTIFICATIONS_OFF);
  await ensureSetup();
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const n of scheduled) {
    if (n.identifier.startsWith(REMINDER_PREFIX)) await Notifications.cancelScheduledNotificationAsync(n.identifier);
  }
  for (const r of plan) {
    await Notifications.scheduleNotificationAsync({
      identifier: r.identifier,
      content: { title: r.title, body: r.body },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.WEEKLY, weekday: r.weekday, hour: r.hour, minute: r.minute, channelId: CH_REMIND },
    });
  }
  return plan.length;
}
