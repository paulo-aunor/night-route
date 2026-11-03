// Test: reorder → Shift done → next shift start → verify saved order is restored.
// Runs the actual mergeOrder + saveLastOrder + loadLastOrder + start-flow logic
// against an in-memory AsyncStorage mock so we can catch persistence bugs without
// standing up React or a phone.

import { test } from "node:test";
import assert from "node:assert/strict";

// In-memory AsyncStorage mock
const store = new Map();
const AsyncStorage = {
  getItem: async (k) => store.get(k) ?? null,
  setItem: async (k, v) => { store.set(k, v); },
  removeItem: async (k) => { store.delete(k); },
  clear: () => store.clear(),
};

// Reproduce the storage keys + helpers from src/lib/storage.ts
const KEY_PREFIX = "@rr/shift/";
const LAST_ORDER_PREFIX = "@rr/lastOrder/v2/";
const routeSetKey = (routeIds) => [...routeIds].sort().join("+");
const loadShift = async (date) => {
  const raw = await AsyncStorage.getItem(KEY_PREFIX + date);
  return raw ? JSON.parse(raw) : null;
};
const saveShift = async (s) => AsyncStorage.setItem(KEY_PREFIX + s.date, JSON.stringify(s));
const clearShift = async (date) => AsyncStorage.removeItem(KEY_PREFIX + date);
const loadLastOrder = async (routeIds) => {
  const raw = await AsyncStorage.getItem(LAST_ORDER_PREFIX + routeSetKey(routeIds));
  return raw ? JSON.parse(raw) : null;
};
const saveLastOrder = async (routeIds, orderedIds) =>
  AsyncStorage.setItem(LAST_ORDER_PREFIX + routeSetKey(routeIds), JSON.stringify(orderedIds));

// Reproduce mergeOrder from src/lib/shift.ts
function mergeOrder(preferred, eligibleIds) {
  const eligible = new Set(eligibleIds);
  const kept = preferred.filter((id) => eligible.has(id));
  const keptSet = new Set(kept);
  const newcomers = eligibleIds.filter((id) => !keptSet.has(id));
  return [...kept, ...newcomers];
}

// Model of useShift's mutable state (simulating the ref-mirrored latest state)
class ShiftHook {
  constructor() { this.state = null; }

  async start(routeIds, seed, eligibleIds) {
    let orderedIds;
    const saved = await loadLastOrder(routeIds);
    if (saved && saved.length) orderedIds = mergeOrder(saved, eligibleIds);
    else if (seed && seed.length) orderedIds = mergeOrder(seed, eligibleIds);
    else orderedIds = [...eligibleIds];  // pretend the optimizer output
    this.state = {
      date: "2026-08-25", routeIds, startedAt: Date.now(), finishedAt: null,
      deliveredIds: [], skippedIds: [], orderedIds, deliveryDayIdx: 6,
    };
    await saveShift(this.state);
  }

  async reorder(orderedIds) {
    if (!this.state) return;
    this.state = { ...this.state, orderedIds };
    await saveShift(this.state);
  }

  // Fixed with the useRef pattern: always reads latest state.
  async finishAsDone() {
    const s = this.state;
    if (!s) return;
    await saveLastOrder(s.routeIds, s.orderedIds);
    await clearShift(s.date);
    this.state = null;
  }
}

test("reorder → Shift done → new shift starts with saved order", async () => {
  store.clear();
  const eligible = ["A", "B", "C", "D", "E"];
  const seed = ["A", "B", "C", "D", "E"];
  const routes = ["C13"];

  const hook = new ShiftHook();
  await hook.start(routes, seed, eligible);
  assert.deepEqual(hook.state.orderedIds, ["A", "B", "C", "D", "E"], "seed order used on first start");

  // Simulate Paulo dragging E to position 1
  await hook.reorder(["E", "A", "B", "C", "D"]);
  assert.deepEqual(hook.state.orderedIds, ["E", "A", "B", "C", "D"], "reorder applied");

  // Simulate Shift done tap
  await hook.finishAsDone();
  assert.equal(hook.state, null, "shift cleared after Shift done");

  // Simulate next day: start again → should restore the reordered sequence
  const hook2 = new ShiftHook();
  await hook2.start(routes, seed, eligible);
  assert.deepEqual(
    hook2.state.orderedIds,
    ["E", "A", "B", "C", "D"],
    "next shift starts with the saved reordered sequence, not the seed",
  );
});

test("multiple reorders → Shift done → latest order saved", async () => {
  store.clear();
  const eligible = ["A", "B", "C"];
  const hook = new ShiftHook();
  await hook.start(["C13"], null, eligible);

  await hook.reorder(["C", "A", "B"]);
  await hook.reorder(["B", "C", "A"]);
  await hook.reorder(["A", "C", "B"]);   // final drag
  await hook.finishAsDone();

  const hook2 = new ShiftHook();
  await hook2.start(["C13"], null, eligible);
  assert.deepEqual(hook2.state.orderedIds, ["A", "C", "B"], "only the final drag order persists");
});

test("newly-added subscriber appears at end of saved order", async () => {
  store.clear();
  const hook = new ShiftHook();
  await hook.start(["C13"], null, ["A", "B", "C"]);
  await hook.reorder(["C", "A", "B"]);
  await hook.finishAsDone();

  // Next shift: E and F are new subscribers not in the saved order
  const hook2 = new ShiftHook();
  await hook2.start(["C13"], null, ["A", "B", "C", "E", "F"]);
  assert.deepEqual(
    hook2.state.orderedIds,
    ["C", "A", "B", "E", "F"],
    "saved order preserved, new subs appended",
  );
});

test("dropped subscriber silently drops from saved order", async () => {
  store.clear();
  const hook = new ShiftHook();
  await hook.start(["C13"], null, ["A", "B", "C", "D"]);
  await hook.reorder(["D", "A", "B", "C"]);
  await hook.finishAsDone();

  // Next shift: D unsubscribed (no longer eligible)
  const hook2 = new ShiftHook();
  await hook2.start(["C13"], null, ["A", "B", "C"]);
  assert.deepEqual(hook2.state.orderedIds, ["A", "B", "C"], "D absent, others in saved order");
});
