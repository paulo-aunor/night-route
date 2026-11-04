// Checks the app's logic against the real source: compiles src/ with tsc into a temp folder and runs the
// functions with React Native's storage and location swapped for in-memory stand-ins.
//
// usage: node scripts/test-logic.mjs        (no network; takes about 30 s because the order search is timed)

import assert from "assert";
import { loadApp } from "./lib/load-app.mjs";

const { store, loc, tasks, notif, rn, lib, data, cleanup } = loadApp();

const sch = lib("schedule"), H = lib("history"), St = lib("settings"), HD = lib("headingData"), HS = lib("headingSearch");
const Shift = lib("shift"), Imp = lib("importRoute"), Trk = lib("tracking");
const { SUBSCRIBERS } = data("subscribers");
const { SEED_ORDERS } = data("seed-orders");
const { CUT_THROUGH } = data("cut-through");
const { matrixIdFor, matrixIdOfHouse } = lib("matrixAlias");
const { anchorIdsFor } = data("anchors");

// ---- helpers ----

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok   ", name); }
  catch (e) { failed++; console.log("FAIL ", name, "\n     ", e.message); }
}
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi);   // local time, so results don't depend on the time zone
const by = new Map(SUBSCRIBERS.map((s) => [s.id, s]));
const coordOf = (id) => (by.has(id) ? { lat: by.get(id).lat, lng: by.get(id).lng } : undefined);
const matrixIdOf = (id) => (by.has(id) ? matrixIdFor(by.get(id).address, by.get(id).city) : undefined);
const routeOf = (id) => by.get(id)?.routeId;
const subsOf = (r) => SUBSCRIBERS.filter((s) => s.routeId === r);
function shuffled(arr, seed) {   // deterministic
  const a = arr.slice(); let x = seed;
  for (let i = a.length - 1; i > 0; i--) { x = (x * 1664525 + 1013904223) % 4294967296; const j = x % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---- nights, paper days, pay, history ----

await test("calendar sanity: 2026-10-25 is a Sunday", () => assert.strictEqual(at(2026, 10, 25, 12).getDay(), 0));
await test("Sunday night is Monday's paper, Friday night is Saturday's", () => {
  assert.deepStrictEqual([at(2026, 10, 25, 23), at(2026, 10, 26, 21), at(2026, 10, 29, 20), at(2026, 10, 30, 23)].map((d) => sch.paperDayIndex(d)), [1, 2, 5, 6]);
});
await test("a shift past midnight keeps its paper; Saturday evening and Sunday morning point at Monday", () => {
  assert.deepStrictEqual([at(2026, 10, 26, 1), at(2026, 10, 31, 1), at(2026, 10, 31, 20), at(2026, 10, 25, 9)].map((d) => sch.paperDayIndex(d)), [1, 6, 1, 1]);
});
await test("a Sunday-night shift finds Monday's houses; FriSat houses start Thursday night", () => {
  assert.strictEqual(sch.deliversOn("Mon-Sat", sch.paperDayOfNight(0)), true);
  assert.strictEqual(sch.deliversOn("Mon-Sat", 0), false);
  assert.strictEqual(sch.deliversOn("FriSat", sch.paperDayOfNight(4)), true);
  assert.strictEqual(sch.deliversOn("FriSat", sch.paperDayOfNight(3)), false);
  assert.deepStrictEqual(sch.NIGHT_INDEXES.map(sch.paperDayOfNight), [1, 2, 3, 4, 5, 6]);
});
await test("nightOf and weekStart follow Sunday-night weeks", () => {
  assert.strictEqual(H.nightOf(at(2026, 10, 25, 21).getTime()), "2026-10-25");
  assert.strictEqual(H.nightOf(at(2026, 10, 26, 0, 30).getTime()), "2026-10-25");
  assert.deepStrictEqual(["2026-10-25", "2026-10-30", "2026-10-31", "2026-11-01"].map(H.weekStart), ["2026-10-25", "2026-10-25", "2026-10-25", "2026-11-01"]);
  assert.strictEqual(H.weekLabel("2026-10-25"), "Sun night Oct 25 to Fri night Oct 30");
  assert.throws(() => H.parseDate("Oct 25"), /isn't a date/);
});
await test("money format and parse", () => {
  assert.deepStrictEqual([St.formatMoney(245), St.formatMoney(-5)], ["$2.45", "-$0.05"]);
  assert.deepStrictEqual(["0.35", ".35", "1", "$2.5", "12.05"].map(St.parseDollars), [35, 35, 100, 250, 1205]);
  assert.deepStrictEqual(["", "abc", "0.355", "-1", "."].map(St.parseDollars), [null, null, null, null, null]);
});
await test("saving text: saves, or says there is no shorter order", () => {
  assert.strictEqual(H.savingText(4400, 3600), "4.4 km to 3.6 km: saves 0.8 km, about 2 min.");
  assert.match(H.savingText(3000, 2990), /no shorter order/);
  assert.match(H.savingText(3000, 3200), /no shorter order/);
});

const ids = subsOf("C3").slice(0, 10).map((s) => s.id);
const shiftState = (over = {}) => ({
  date: "2026-10-26", routeIds: ["C3"], startedAt: at(2026, 10, 25, 22).getTime(), finishedAt: null,
  deliveredIds: ids.slice(2, 7), skippedIds: [ids[7]], orderedIds: ids, deliveryDayIdx: 1, startMode: "library", ...over,
});
await test("buildRecord: due, ticked, counted, skipped, stopped, pay, saving", () => {
  const s = shiftState({ optimizations: [{ at: 1, kind: "reroute", houses: 5, beforeM: 4000, afterM: 3000 }, { at: 2, kind: "reroute", houses: 3, beforeM: 900, afterM: 1000 }] });
  const r = H.buildRecord(s, { stoppedIds: [ids[0], ids[1]], rateCents: 35, plannedM: 4200, coveredM: 3900, drivenM: 4100, finishedAt: at(2026, 10, 26, 0, 10).getTime(), routeOf });
  assert.deepStrictEqual([r.due, r.ticked, r.skipped, r.counted, r.stopped], [8, 5, 1, 2, 2]);
  assert.deepStrictEqual([H.delivered(r), H.payCents(r), H.duePayCents(r)], [7, 245, 280]);
  assert.deepStrictEqual([r.coveredM, r.drivenM, r.savedM, r.optimizations, r.night, r.paperDay], [3900, 4100, 1000, 2, "2026-10-25", 1]);
  assert.throws(() => H.buildRecord({ ...s, startedAt: null }, { stoppedIds: [], rateCents: 35, plannedM: null, coveredM: null, drivenM: null, finishedAt: 1, routeOf }), /never started/);
  assert.throws(() => H.buildRecord(s, { stoppedIds: [], rateCents: 35, plannedM: null, coveredM: null, drivenM: null, finishedAt: 1, routeOf: () => undefined }), /no route/);
});
const mk = (startedAt, o = {}) => ({
  id: String(startedAt), startedAt, finishedAt: startedAt + 2 * 3_600_000, night: H.nightOf(startedAt), paperDay: (new Date(startedAt).getDay() + 1) % 7,
  routeIds: ["C3"], due: 50, ticked: 40, counted: 5, skipped: 0, stopped: 1, rateCents: 35, plannedM: 9000, coveredM: 8000, drivenM: 9500, savedM: 1200, optimizations: 2, startMode: "library", byRoute: {}, ...o,
});
const all = [mk(at(2026, 10, 25, 21).getTime()), mk(at(2026, 10, 30, 22).getTime(), { ticked: 50, counted: 0, plannedM: null, coveredM: null, drivenM: null, savedM: 0, optimizations: 0 }), mk(at(2026, 11, 1, 21).getTime())];
await test("totalsOf: pay, hours, per-hour, distance covered, per house, saved", () => {
  const t = H.totalsOf([all[0], all[1]]);
  assert.deepStrictEqual([t.shifts, t.delivered, t.payCents, t.duePayCents, t.hours], [2, 95, 95 * 35, 100 * 35, 4]);
  assert.deepStrictEqual([t.housesPerHour, t.centsPerHour], [95 / 4, (95 * 35) / 4]);
  assert.deepStrictEqual([t.plannedM, t.plannedPartial, t.coveredM, t.coveredPartial, t.drivenM, t.drivenPartial, t.savedM, t.optimizations], [9000, true, 8000, true, 9500, true, 1200, 2]);
  assert.strictEqual(t.kmPerHouse, 8 / 45);
  assert.deepStrictEqual([H.totalsOf([]).housesPerHour, H.totalsOf([]).coveredM, H.totalsOf([]).kmPerHouse], [null, null, null]);
});
await test("weekReport groups by Sunday-night week and night", () => {
  const w = H.weekReport(all, "2026-10-25");
  assert.deepStrictEqual(w.nights.map((n) => n.night), ["2026-10-25", "2026-10-30"]);
  assert.deepStrictEqual([H.weekReport(all, "2026-11-01").totals.shifts, H.weekReport(all, "2026-10-18").totals.shifts], [1, 0]);
});
await test("history storage: append once, replace on repeat, old records get the new fields, bad data raises", async () => {
  delete store["@rr/history/v1"];
  await H.appendRecord(all[1]); await H.appendRecord(all[0]); await H.appendRecord(all[1]);
  assert.deepStrictEqual((await H.loadHistory()).map((r) => r.id), [all[0].id, all[1].id]);
  const { coveredM, drivenM, savedM, optimizations, ...old } = all[0];
  store["@rr/history/v1"] = JSON.stringify([old]);
  const [loaded] = await H.loadHistory();
  assert.deepStrictEqual([loaded.coveredM, loaded.drivenM, loaded.savedM, loaded.optimizations], [null, null, 0, 0]);
  store["@rr/history/v1"] = JSON.stringify({ not: "a list" });
  await assert.rejects(H.loadHistory(), /expected shape/);
  delete store["@rr/history/v1"];
});
await test("rate: default 35, saved, rejects bad values", async () => {
  delete store["@rr/settings/v1"];
  assert.strictEqual(await St.loadRateCents(), 35);
  await St.saveRateCents(40);
  assert.strictEqual(await St.loadRateCents(), 40);
  await assert.rejects(St.saveRateCents(0.5), /whole number/);
  store["@rr/settings/v1"] = JSON.stringify({ rateCents: "x" });
  await assert.rejects(St.loadRateCents(), /expected shape/);
  delete store["@rr/settings/v1"];
});

// ---- road data, penalties ----

await test("base64 decoder matches Node on the shipped road data", () => {
  const { HEADING_DATA_B64 } = data("heading-matrix");
  assert.strictEqual(Buffer.compare(Buffer.from(HD.decodeBase64(HEADING_DATA_B64)), Buffer.from(HEADING_DATA_B64, "base64")), 0);
  assert.throws(() => HD.decodeBase64("abc"), /multiple of 4/);
});
await (CUT_THROUGH.length ? test : (name) => console.log("skip  " + name + " (the demo's synthetic streets have no audited cut-through pairs)"))("cut-through penalties raise a pair's cost when ordering, and are left out of a distance that will be driven", () => {
  assert.ok(CUT_THROUGH.length > 0, "the audit found no cut-through pairs");
  const [a, b, m] = CUT_THROUGH[0];
  const input = { stopIds: [a, b], coordOf, matrixIdOf, start: { kind: "library" } };
  const withPen = HD.buildProblem(input), without = HD.buildProblem({ ...input, withPenalties: false });
  const ia = withPen.index.get(a), ib = withPen.index.get(b);
  for (let q = 0; q < 4; q++) {
    const plain = without.problem.c[q][ia * 2 + ib], pen = withPen.problem.c[q][ia * 2 + ib], back = withPen.problem.c[q][ib * 2 + ia] - without.problem.c[q][ib * 2 + ia];
    assert.ok(Math.abs(pen - plain - m) < 1 || plain === Infinity, `forward ${pen - plain} vs ${m}`);
    assert.ok(Math.abs(back - m) < 1 || without.problem.c[q][ib * 2 + ia] === Infinity, `back ${back} vs ${m}`);
  }
  assert.strictEqual(HD.plannedMeters({ ...input, order: [a, b] }), HS.legsGreedy(without.problem, [ia, ib]).reduce((t, x) => t + x, 0));
});

// ---- re-route, GPS start, distances ----

const seed = SEED_ORDERS["A11+A7+B21"];
await test("planReroute: delivered on top, stopped at the bottom, every house once, and a scrambled order is shown as a saving", () => {
  const delivered = seed.slice(0, 60), rest = seed.slice(60);
  const stopped = [rest[3], rest[40]];
  const scrambled = [...delivered, ...shuffled(rest, 7)];
  const c = coordOf(delivered[59]);
  const here = { lat: c.lat + 0.0003, lng: c.lng + 0.0003 };
  const plan = Shift.planReroute(scrambled, delivered, stopped, here, coordOf, matrixIdOf);
  assert.strictEqual(new Set(plan.orderedIds).size, seed.length);
  assert.deepStrictEqual(plan.orderedIds.slice(0, 60), delivered);
  assert.deepStrictEqual(plan.orderedIds.slice(-2), scrambled.filter((id) => stopped.includes(id)));
  assert.strictEqual(plan.stops, rest.length - 2);
  assert.ok(plan.beforeM > 0 && plan.afterM > 0);
  assert.ok(plan.afterM < plan.beforeM * 0.6, `a scrambled order should shrink a lot: ${plan.beforeM} -> ${plan.afterM}`);
  assert.throws(() => Shift.planReroute(seed, seed, [], here, coordOf, matrixIdOf), /Nothing left/);
});
await test("re-route leaves a good order alone, and fixes one the driver has skipped ahead in", () => {
  for (const [set, f] of [["A11", 0.5], ["C3", 0.25], ["A11+A7+B21", 0.5]]) {
    const order = SEED_ORDERS[set], k = Math.round(order.length * f), delivered = order.slice(0, k);
    const c = coordOf(delivered[k - 1]), here = { lat: c.lat + 0.0003, lng: c.lng - 0.0003 };
    const plan = Shift.planReroute(order, delivered, [], here, coordOf, matrixIdOf);
    assert.deepStrictEqual(plan.orderedIds, order, `${set}: a well ordered shift keeps its order`);
    assert.strictEqual(plan.beforeM, plan.afterM);
  }
  const order = SEED_ORDERS.C3, k = 12, j = 32;
  const delivered = [...order.slice(0, k), ...order.slice(j, j + 8)], done = new Set(delivered);
  const remaining = order.filter((id) => !done.has(id));
  const c = coordOf(delivered[delivered.length - 1]), here = { lat: c.lat + 0.0003, lng: c.lng - 0.0003 };
  const plan = Shift.planReroute([...delivered, ...remaining], delivered, [], here, coordOf, matrixIdOf);
  assert.ok(plan.afterM < plan.beforeM * 0.95, `skipping ahead should be repaired: ${plan.beforeM} -> ${plan.afterM}`);
  assert.deepStrictEqual([...plan.orderedIds.slice(delivered.length)].sort(), [...remaining].sort());
});
await test("a start from a live location keeps the usual order when nothing is clearly shorter", () => {
  const set = SEED_ORDERS.C3, c = coordOf(set[0]), here = { lat: c.lat + 0.0003, lng: c.lng - 0.0003 };
  const r = Shift.planFromGps(set, set, here, coordOf, matrixIdOf);
  assert.deepStrictEqual(r.orderedIds, set);
});
await test("standing at the house just delivered, the first leg costs what it really costs from that house", () => {
  const [h, a, b] = [SEED_ORDERS.C3[10], SEED_ORDERS.C3[11], SEED_ORDERS.C3[12]];
  const here = { lat: coordOf(h).lat + 0.0002, lng: coordOf(h).lng };
  for (const facing of [0, 1]) {
    const withHouse = HD.buildProblem({ stopIds: [h, a, b], coordOf, matrixIdOf, start: { kind: "library" }, withPenalties: false });
    const at = HD.buildProblem({ stopIds: [a, b], coordOf, matrixIdOf, start: { kind: "gps", coord: here, at: { houseId: h, facing } }, withPenalties: false });
    const offset = lib("optimizer-v2").haversineM(here, coordOf(h)) * lib("optimizer-v2").CIRCUITY;
    for (const [i, id] of [a, b].entries()) for (const t of [0, 1]) {
      const expected = offset + withHouse.problem.c[facing * 2 + t][withHouse.index.get(h) * 3 + withHouse.index.get(id)];
      assert.ok(Math.abs(at.problem.start[t][i] - expected) < 1, `facing ${facing}, ${id}, state ${t}: ${at.problem.start[t][i]} vs ${expected}`);
    }
  }
});
await test("facingAfter: a direction for a known order, null for nothing", () => {
  const order = SEED_ORDERS.C3.slice(0, 15);
  assert.ok([0, 1].includes(HD.facingAfter({ stopIds: order, order, coordOf, matrixIdOf, start: { kind: "library" } })));
  assert.strictEqual(HD.facingAfter({ stopIds: [], order: [], coordOf, matrixIdOf, start: { kind: "library" } }), null);
});
await test("markDeliveredState: a heading is stored alongside the tick; null leaves headingAt alone", () => {
  const s0 = { date: "d", routeIds: ["C3"], startedAt: 1, finishedAt: null, deliveredIds: [], deliveredAt: {}, skippedIds: [], orderedIds: ids, startMode: "library" };
  const next = lib("nextHouse").markDeliveredState(s0, ids[0], 100, 170);
  assert.strictEqual(next.headingAt[ids[0]], 170);
  const again = lib("nextHouse").markDeliveredState(next, ids[1], 200, null);
  assert.strictEqual(again.headingAt[ids[1]], undefined);
  assert.strictEqual(again.headingAt[ids[0]], 170);
});
await test("headingBefore: the latest fix with a heading inside the window, otherwise null", () => {
  const points = [
    { t: 1000, lat: 0, lng: 0, acc: 10, hd: 90 },
    { t: 2000, lat: 0, lng: 0, acc: 10, hd: null },
    { t: 3000, lat: 0, lng: 0, acc: 10, hd: 180 },
    { t: 4000, lat: 0, lng: 0, acc: 200, hd: 200 }, // too inaccurate
  ];
  assert.strictEqual(Trk.headingBefore(points, 3500), 180);
  assert.strictEqual(Trk.headingBefore(points, 1500), 90);
  assert.strictEqual(Trk.headingBefore(points, 70000, 60000), null, "stale fix");
  assert.strictEqual(Trk.headingBefore([], 1000), null);
});
await test("planReroute: a live heading opposite the delivery flow flips the inferred facing", () => {
  // The planner's facing choice shows up as `at.facing` being passed to buildProblem; we check indirectly by
  // confirming that a disagreeing heading makes the plan differ from the no-heading case on a harder scenario.
  const order = SEED_ORDERS.C3, k = 12, j = 32;
  const delivered = [...order.slice(0, k), ...order.slice(j, j + 8)];
  const c = coordOf(delivered[delivered.length - 1]), here = { lat: c.lat + 0.0003, lng: c.lng - 0.0003 };
  const base = Shift.planReroute([...delivered, ...order.filter((id) => !delivered.includes(id))], delivered, [], here, coordOf, matrixIdOf);
  // Heading that strongly disagrees with the prev→last bearing
  const prevC = coordOf(delivered[delivered.length - 2]), lastC = c;
  const flowBearing = (Math.atan2(
    Math.sin((lastC.lng - prevC.lng) * Math.PI / 180) * Math.cos(lastC.lat * Math.PI / 180),
    Math.cos(prevC.lat * Math.PI / 180) * Math.sin(lastC.lat * Math.PI / 180) - Math.sin(prevC.lat * Math.PI / 180) * Math.cos(lastC.lat * Math.PI / 180) * Math.cos((lastC.lng - prevC.lng) * Math.PI / 180)
  ) * 180 / Math.PI + 360) % 360;
  const headingAt = { [delivered[delivered.length - 1]]: (flowBearing + 180) % 360 };
  const flipped = Shift.planReroute([...delivered, ...order.filter((id) => !delivered.includes(id))], delivered, [], here, coordOf, matrixIdOf, undefined, headingAt);
  // The gate may or may not accept a new order, but the reported beforeM should reflect the opposite facing.
  // (Without a recorded heading the beforeM uses the max of both facings; with one it uses the single flipped
  // facing, so beforeM here is NOT greater than the no-heading baseline.)
  assert.ok(flipped.beforeM <= base.beforeM + 1, `heading-pinned beforeM ${flipped.beforeM} should not exceed both-facings worst ${base.beforeM}`);
});
await test("planFromGps: every house once, a before figure only when there is a usual order", () => {
  const set = SEED_ORDERS.C3, here = { lat: coordOf(set[30]).lat + 0.0004, lng: coordOf(set[30]).lng };
  const solvable = set.filter((id) => id !== set[5]);
  const withBase = Shift.planFromGps(solvable, set, here, coordOf, matrixIdOf);
  assert.deepStrictEqual([...withBase.orderedIds].sort(), [...solvable].sort());
  assert.ok(withBase.beforeM > 0 && withBase.afterM > 0 && withBase.afterM <= withBase.beforeM * 1.02);
  assert.strictEqual(Shift.planFromGps(solvable, null, here, coordOf, matrixIdOf).beforeM, null);
  assert.deepStrictEqual(Shift.planFromGps([], null, here, coordOf, matrixIdOf).orderedIds, []);
});
await test("shiftDistances: covered follows the order houses were ticked; in order it equals the plan, scrambled it is longer", () => {
  const order = SEED_ORDERS.C3;
  const inOrder = { ...shiftState({ orderedIds: order }), deliveredIds: order };
  const a = Shift.shiftDistances(inOrder, [], true);
  assert.ok(Math.abs(a.coveredM - a.plannedM) < 1, `${a.coveredM} vs ${a.plannedM}`);
  const scrambled = { ...inOrder, deliveredIds: shuffled(order, 3) };
  assert.ok(Shift.shiftDistances(scrambled, [], true).coveredM > a.plannedM * 1.3);
  const half = Shift.shiftDistances({ ...inOrder, deliveredIds: order.slice(0, 20) }, [], false);
  assert.ok(half.coveredM > 0 && half.coveredM < a.plannedM, "partway through, less than the plan");
  assert.ok(Shift.shiftDistances({ ...inOrder, deliveredIds: order.slice(0, 20) }, [], true).coveredM > half.coveredM - 1, "Shift done adds the houses it counts");
  const gps = Shift.shiftDistances({ ...inOrder, startCoord: { lat: coordOf(order[40]).lat, lng: coordOf(order[40]).lng } }, [], false);
  assert.notStrictEqual(Math.round(gps.plannedM), Math.round(a.plannedM), "a live start point changes the plan");
});
await test("recordShift (the real end-of-shift path): stopped houses, pay at the saved rate, distances, saving", async () => {
  store["@rr/pausedSubs/v1"] = JSON.stringify({ [ids[0]]: true, [ids[1]]: true });
  store["@rr/settings/v1"] = JSON.stringify({ rateCents: 40 });
  delete store["@rr/history/v1"];
  await Shift.recordShift(shiftState({ optimizations: [{ at: 1, kind: "start", houses: 8, beforeM: 5000, afterM: 4200 }] }));
  const [r] = await H.loadHistory();
  assert.deepStrictEqual([r.due, r.stopped, r.ticked, r.skipped, r.counted, r.rateCents, r.savedM, r.optimizations], [8, 2, 5, 1, 2, 40, 800, 1]);
  assert.strictEqual(H.payCents(r), 7 * 40);
  assert.ok(r.plannedM > 500 && r.plannedM < 15000 && r.coveredM > 500 && r.coveredM < 15000, `planned ${r.plannedM}, covered ${r.coveredM}`);
  // a shift that started from a live location is measured from there
  await Shift.recordShift(shiftState({ startedAt: at(2026, 10, 26, 22).getTime(), startMode: "gps", startCoord: coordOf(ids[5]) }));
  const two = await H.loadHistory();
  assert.strictEqual(two.length, 2);
  assert.ok(two[1].plannedM > 0);
  await Shift.recordShift(shiftState());   // the same shift again must not count twice
  assert.strictEqual((await H.loadHistory()).length, 2);
});

// ---- GPS recording ----

const here0 = { lat: 43.4643, lng: -80.5204 };
const metresNorth = (m) => m / 111320;   // degrees of latitude per metre
const fix = (t, northM, acc = 5, eastM = 0) => ({ t, lat: here0.lat + metresNorth(northM), lng: here0.lng + eastM / (111320 * Math.cos(here0.lat * Math.PI / 180)), acc });
await test("trackDistance: a straight 1 km drive adds up; a phone standing still adds almost nothing", () => {
  const drive = Array.from({ length: 11 }, (_, i) => fix(i * 10_000, i * 100));
  assert.ok(Math.abs(Trk.trackDistance(drive).meters - 1000) < 15, String(Trk.trackDistance(drive).meters));
  const still = Array.from({ length: 300 }, (_, i) => fix(i * 1000, (i % 3) * 2 - 2, 6, (i % 4) - 1.5));   // wanders a few metres
  assert.ok(Trk.trackDistance(still).meters < 20, String(Trk.trackDistance(still).meters));
  assert.strictEqual(Trk.trackDistance([]).meters, 0);
});
await test("trackDistance: a glitch jump, poor fixes and out-of-order fixes are handled", () => {
  const good = Array.from({ length: 11 }, (_, i) => fix(i * 10_000, i * 100));
  const glitch = [...good.slice(0, 5), fix(50_500, 5000), ...good.slice(5)];   // 5 km away for one fix
  assert.ok(Math.abs(Trk.trackDistance(glitch).meters - 1000) < 20, String(Trk.trackDistance(glitch).meters));
  assert.strictEqual(Trk.trackDistance(glitch).dropped, 1);
  const poor = [...good.slice(0, 5), { ...fix(45_000, 3000), acc: 200 }, ...good.slice(5)];
  assert.ok(Math.abs(Trk.trackDistance(poor).meters - 1000) < 20);
  assert.ok(Math.abs(Trk.trackDistance([...good].reverse()).meters - Trk.trackDistance(good).meters) < 1e-9);
});
await test("the background task appends points in order, ignores a shift nobody is recording, and stores its own errors", async () => {
  const task = tasks[Trk.TRACK_TASK];
  assert.strictEqual(typeof task, "function", "the task is registered when the module loads");
  const batch = (n, base) => ({ locations: Array.from({ length: n }, (_, i) => ({ timestamp: base + i * 10_000, coords: { latitude: here0.lat + metresNorth((base / 1000 + i * 10) * 10), longitude: here0.lng, accuracy: 5 } })) });
  delete store["@rr/track/active"]; delete store["@rr/track/points/123"]; delete store["@rr/track/error"];
  await task({ data: batch(3, 0), error: null });
  assert.strictEqual(store["@rr/track/points/123"], undefined, "nothing is written while no shift is being recorded");
  store["@rr/track/active"] = "123";
  await task({ data: batch(3, 0), error: null }); await task({ data: batch(2, 100_000), error: null });
  assert.strictEqual(JSON.parse(store["@rr/track/points/123"]).length, 5);
  await task({ data: null, error: { message: "location task failed" } });
  assert.strictEqual(await Trk.lastTrackError(), "location task failed");
  assert.strictEqual(JSON.parse(store["@rr/track/points/123"]).length, 5, "an error doesn't touch the saved points");
});
await test("startTracking asks for each permission, says which one is missing, and starts the service once", async () => {
  const reset = () => { Object.assign(loc, { servicesOn: true, foreground: "granted", background: "granted", started: false, startedWith: null, startCalls: 0, stopCalls: 0 }); delete store["@rr/track/active"]; };
  reset(); loc.servicesOn = false;
  await assert.rejects(Trk.startTracking(7), /switched off/);
  reset(); loc.foreground = "denied";
  await assert.rejects(Trk.startTracking(7), /permission wasn't granted/);
  reset(); loc.background = "denied";
  await assert.rejects(Trk.startTracking(7), /Allow all the time/);
  assert.strictEqual(loc.startCalls, 0, "nothing starts without the permission");
  reset();
  await Trk.startTracking(7);
  assert.deepStrictEqual([loc.startCalls, loc.startedWith.name, store["@rr/track/active"]], [1, Trk.TRACK_TASK, "7"]);
  assert.ok(loc.startedWith.options.foregroundService.notificationTitle, "a visible notification is part of the service");
  assert.strictEqual(await Trk.isTracking(7), true);
  assert.strictEqual(await Trk.isTracking(8), false);
  await Trk.startTracking(7);
  assert.strictEqual(loc.startCalls, 1, "asking again doesn't start a second service");
  await Trk.stopTracking(7);
  assert.deepStrictEqual([loc.started, loc.stopCalls, store["@rr/track/active"], store["@rr/track/points/7"]], [false, 1, undefined, undefined]);
});
await test("recordShift keeps the GPS distance with the shift, ends the recording, and keeps the points until the next shift ends", async () => {
  Object.assign(loc, { servicesOn: true, foreground: "granted", background: "granted", started: false, startCalls: 0, stopCalls: 0 });
  store["@rr/pausedSubs/v1"] = "{}"; store["@rr/settings/v1"] = JSON.stringify({ rateCents: 35 }); delete store["@rr/history/v1"];
  const s = shiftState({ startedAt: at(2026, 10, 27, 21).getTime() });
  await Trk.startTracking(s.startedAt);
  store["@rr/track/points/" + s.startedAt] = JSON.stringify(Array.from({ length: 11 }, (_, i) => fix(i * 10_000, i * 100)));
  await Shift.recordShift(s);
  const [r] = await H.loadHistory();
  assert.ok(Math.abs(r.drivenM - 1000) < 15, String(r.drivenM));
  assert.deepStrictEqual([loc.started, store["@rr/track/active"]], [false, undefined]);
  assert.ok(store["@rr/track/points/" + s.startedAt], "the points stay so the shift can be reopened");
  // a shift nobody recorded has no GPS figure; ending it replaces the kept shift, so the old points go
  await Shift.recordShift(shiftState({ startedAt: at(2026, 10, 28, 21).getTime() }));
  assert.strictEqual(store["@rr/track/points/" + s.startedAt], undefined, "the previous shift's points are deleted");
  assert.strictEqual((await H.loadHistory()).find((x) => x.startedAt === at(2026, 10, 28, 21).getTime()).drivenM, null);
});

// ---- reports per route ----

const MIN = 60_000;
const gpsTenPerMinute = (t) => (t / MIN) * 10;   // a steady 10 m a minute
await test("routeBreakdown: time and distance go to the route of the house each leg ends at, counted houses share the rest", () => {
  const legs = [
    { route: "A", meters: 100, t: 10 * MIN }, { route: "B", meters: 200, t: 25 * MIN }, { route: "A", meters: 50, t: 30 * MIN },
    { route: "B", meters: 100, t: null }, { route: "A", meters: 100, t: null },
  ];
  const r = H.routeBreakdown({ startedAt: 0, finishedAt: 40 * MIN, legs, drivenAt: gpsTenPerMinute });
  assert.deepStrictEqual([r.A.minutes, r.B.minutes], [20, 20]);
  assert.deepStrictEqual([r.A.coveredM, r.B.coveredM], [250, 300]);
  assert.deepStrictEqual([r.A.drivenM, r.B.drivenM], [200, 200]);
  assert.strictEqual(r.A.minutes + r.B.minutes, 40, "nothing is lost or counted twice");
});
await test("routeBreakdown: the drive home isn't given to a route; no GPS or untimed ticks leave those figures empty", () => {
  const ticked = [{ route: "A", meters: 100, t: 10 * MIN }, { route: "B", meters: 100, t: 20 * MIN }];
  const r = H.routeBreakdown({ startedAt: 0, finishedAt: 50 * MIN, legs: ticked, drivenAt: gpsTenPerMinute });
  assert.strictEqual(r.A.minutes + r.B.minutes, 20, "the last 30 minutes (the drive home) belong to no route");
  const noGps = H.routeBreakdown({ startedAt: 0, finishedAt: 50 * MIN, legs: ticked, drivenAt: null });
  assert.deepStrictEqual([noGps.A.drivenM, noGps.A.minutes], [null, 10]);
  const untimed = H.routeBreakdown({ startedAt: 0, finishedAt: 50 * MIN, legs: [...ticked, { route: "A", meters: 70, t: undefined }], drivenAt: gpsTenPerMinute });
  assert.deepStrictEqual([untimed.A.minutes, untimed.B.minutes, untimed.A.drivenM, untimed.A.coveredM], [null, null, null, 170]);
});
await test("routeTotals: each shift's own rate, partial timing, per-hour figures", () => {
  const a = { ...mk(1), rateCents: 35, byRoute: { C3: { due: 10, delivered: 10, minutes: 30, coveredM: 3000, drivenM: 3200 }, A7: { due: 5, delivered: 4, minutes: null, coveredM: null, drivenM: null } } };
  const b = { ...mk(2), rateCents: 40, byRoute: { C3: { due: 10, delivered: 8, minutes: 30, coveredM: 3500, drivenM: null } } };
  const t = H.routeTotals([a, b]);
  assert.deepStrictEqual([t.C3.due, t.C3.delivered, t.C3.payCents, t.C3.duePayCents], [20, 18, 10 * 35 + 8 * 40, 10 * 35 + 10 * 40]);
  assert.deepStrictEqual([t.C3.minutes, t.C3.minutesPartial, t.C3.coveredM, t.C3.drivenM], [60, false, 6500, 3200]);
  assert.strictEqual(t.C3.housesPerHour, 18);
  assert.strictEqual(t.C3.kmPerHouse, 6.5 / 18);
  assert.deepStrictEqual([t.A7.minutes, t.A7.housesPerHour, t.A7.coveredM, t.A7.delivered], [null, null, null, 4]);
  assert.deepStrictEqual(H.routeTotals([]), {});
});
await test("recordShift splits a shift of two routes by route, and the parts add up", async () => {
  const j3 = subsOf("C3").slice(0, 6).map((x) => x.id), g7 = subsOf("A7").slice(0, 6).map((x) => x.id);
  const order = [j3[0], j3[1], g7[0], g7[1], j3[2], g7[2], j3[3], g7[3], j3[4], g7[4], j3[5], g7[5]];
  const t0 = at(2026, 10, 27, 21).getTime();
  const ticked = order.slice(0, 9);   // the last three are counted at Shift done
  const deliveredAt = Object.fromEntries(ticked.map((id, i) => [id, t0 + (i + 1) * 4 * MIN]));
  const points = Array.from({ length: 40 }, (_, i) => fix(t0 + i * 60_000, i * 40));   // 40 m a minute
  store["@rr/pausedSubs/v1"] = "{}"; store["@rr/settings/v1"] = JSON.stringify({ rateCents: 35 }); delete store["@rr/history/v1"];
  store["@rr/track/points/" + t0] = JSON.stringify(points);
  await Shift.recordShift({ date: "x", routeIds: ["C3", "A7"], startedAt: t0, finishedAt: null, deliveredIds: ticked, deliveredAt, skippedIds: [], orderedIds: order, deliveryDayIdx: 1, startMode: "library" });
  const [r] = await H.loadHistory();
  assert.deepStrictEqual(Object.keys(r.byRoute).sort(), ["A7", "C3"]);
  assert.deepStrictEqual([r.byRoute.C3.due, r.byRoute.C3.delivered, r.byRoute.A7.due, r.byRoute.A7.delivered], [6, 6, 6, 6]);
  const sum = (k) => r.byRoute.C3[k] + r.byRoute.A7[k];
  assert.ok(Math.abs(sum("coveredM") - r.coveredM) < 1, `${sum("coveredM")} vs ${r.coveredM}`);
  assert.ok(r.byRoute.C3.minutes > 0 && r.byRoute.A7.minutes > 0 && r.byRoute.C3.drivenM > 0 && r.byRoute.A7.drivenM > 0);
  assert.ok(sum("drivenM") <= r.drivenM + 1, "the route parts never exceed the whole");
});
await test("old history records without per-route detail still load", async () => {
  const old = { ...mk(3), byRoute: { C3: { due: 5, delivered: 5 } } };
  store["@rr/history/v1"] = JSON.stringify([old]);
  const [r] = await H.loadHistory();
  assert.deepStrictEqual(r.byRoute.C3, { due: 5, delivered: 5, minutes: null, coveredM: null, drivenM: null });
  delete store["@rr/history/v1"];
});

// ---- update mode ----

const CODE = { A11: "N1A00011", C13: "N1C00013", B21: "N1B00021", A7: "N1A00007", C3: "N1C00003" };
const parsedFrom = (rid, subs) => ({ code: CODE[rid], expected: null, subs: subs.map((s) => ({ name: s.name, address: s.address, city: s.city, postal: s.postal, schedule: s.schedule, note: s.note })) });
const coordsOf = (subs) => subs.map((s) => ({ lat: s.lat, lng: s.lng }));
for (const rid of ["A11", "A7", "B21", "C3", "C13"]) {
  await test(`update ${rid}: the same list changes nothing`, () => {
    const subs = subsOf(rid), order = SEED_ORDERS[rid];
    const r = Imp.buildUpdatedRoute(parsedFrom(rid, subs), coordsOf(subs), 1, new Map(), { subs, order });
    assert.deepStrictEqual([r.changes.added.length, r.changes.removed.length, r.changes.kept], [0, 0, subs.length]);
    assert.deepStrictEqual(r.imported.seed, order.map((id) => r.changes.idMap.get(id)));
  });
}
await test("update A11: remove 3, add 1: survivors keep their order and C13's first nine would still lead", () => {
  const subs = subsOf("A11"), order = SEED_ORDERS.A11, drop = new Set([order[5], order[40], order[90]]);
  const keep = subs.filter((s) => !drop.has(s.id)), near = by.get(order[30]);
  const parsed = { code: CODE.A11, expected: null, subs: [...keep.map((s) => ({ name: s.name, address: s.address, city: s.city, postal: s.postal, schedule: s.schedule })), { name: "NEW", address: "999 FAKE ST", city: near.city, postal: near.postal, schedule: "Mon-Sat" }] };
  const r = Imp.buildUpdatedRoute(parsed, [...coordsOf(keep), { lat: near.lat + 0.0004, lng: near.lng + 0.0004 }], 1, new Map(), { subs, order });
  assert.deepStrictEqual([r.changes.removed.length, r.changes.added.length], [3, 1]);
  const newId = r.changes.added[0].id;
  assert.deepStrictEqual(r.imported.seed.filter((id) => id !== newId), order.filter((id) => !drop.has(id)).map((id) => r.changes.idMap.get(id)));
});
await test("update C13: the first nine lead even when the old order had one buried", () => {
  const subs = subsOf("C13"), order = SEED_ORDERS.C13, bad = [...order.slice(1), order[0]];
  const r = Imp.buildUpdatedRoute(parsedFrom("C13", subs), coordsOf(subs), 1, new Map(), { subs, order: bad });
  const first = r.imported.seed.slice(0, 9).map((id) => r.imported.subs.find((s) => s.id === id).address);
  assert.deepStrictEqual(first, ["129 ALMA ST N", "70 DREW ST", "134 ALMA ST N", "97 DREW ST", "16 JULIA DR", "19 JULIA DR", "21 JULIA DR", "23 JULIA DR", "24 JULIA DR"]);
});
await test("every baked seed lists each house once, with C13's first nine leading where C13 is included", () => {
  const anchors = anchorIdsFor(["C13"], SUBSCRIBERS);
  for (const [key, order] of Object.entries(SEED_ORDERS)) {
    const routes = key.split("+");
    assert.deepStrictEqual([...order].sort(), SUBSCRIBERS.filter((s) => routes.includes(s.routeId)).map((s) => s.id).sort(), key);
    if (routes.includes("C13")) assert.deepStrictEqual(order.slice(0, 9), anchors, key + " anchors");
  }
});

// ---- search, houses added by hand, removing and reopening a shift ----

const Search = lib("houseSearch"), AH = lib("addHouse"), Reg = lib("registry"), Core = lib("registry-core"), Reo = lib("reopen"), Geo = lib("geocode");
const { ROUTES } = data("routes");
const BI = { routes: ROUTES, subs: SUBSCRIBERS };
const h0 = subsOf("C3")[20];
const addedHouse = (over = {}) => ({ id: "ADD-C3-x1", routeId: "C3", name: "NEW START", address: "9 TEST RD", postal: "N2J 1A1", city: "Waterloo", schedule: "Mon-Sat", lat: h0.lat + 0.0004, lng: h0.lng + 0.0004, ...over });

await test("a registry saved before houses could be added still loads, and a house can then be added and persists", async () => {
  store["@rr/registry/v1"] = JSON.stringify({ imported: {}, hidden: [], removed: [] });   // the shape the last release saved
  await Reg.loadRegistry();
  assert.strictEqual(Reg.allSubscribers().length, SUBSCRIBERS.length);
  await Reg.registry.addHouse(addedHouse());
  assert.strictEqual(Reg.allSubscribers().length, SUBSCRIBERS.length + 1);
  assert.strictEqual(JSON.parse(store["@rr/registry/v1"]).added.length, 1);
  assert.ok(Reg.isAddedHouse("ADD-C3-x1"));
  assert.strictEqual(Reg.countByRoute().C3, subsOf("C3").length + 1);
  assert.ok(Reg.subscribersForRoutesOn(["C3"], 1).some((x) => x.id === "ADD-C3-x1"), "delivered on a Monday-paper night");
});
await test("adding a house: same address twice, unknown route and removing a house from a list are all refused", async () => {
  await assert.rejects(Reg.registry.addHouse(addedHouse({ id: "ADD-C3-x2", address: "9  test rd" })), /already on route C3/);
  await assert.rejects(Reg.registry.addHouse(addedHouse({ id: "ADD-ZZ-1", routeId: "ZZ", address: "1 OTHER ST" })), /doesn't exist/);
  await assert.rejects(Reg.registry.addHouse(addedHouse({ id: ids[0], address: "5 ELSEWHERE RD" })), /already exists/);
  await assert.rejects(Reg.registry.removeAddedHouse(ids[0]), /wasn't added by hand/);
  assert.strictEqual(Reg.allSubscribers().length, SUBSCRIBERS.length + 1, "nothing changed");
});
await test("a house added by hand: a PDF import of its route replaces it; deleting a built-in route keeps it for Restore; Remove deletes it", async () => {
  const withOne = Core.addHouse(Core.EMPTY_STATE, BI, addedHouse());
  const imported = Core.importRoute(withOne, { route: ROUTES.find((r) => r.id === "C3"), importedAt: 1, subs: [], seed: [] });
  assert.strictEqual(imported.added.length, 0, "the imported list is the whole route");
  const deleted = Core.deleteRoute(withOne, BI, "C3");
  assert.strictEqual(Core.effectiveSubs(deleted, BI).some((x) => x.id === "ADD-C3-x1"), false, "gone while the route is deleted");
  assert.strictEqual(Core.effectiveSubs(Core.restoreRoute(deleted, BI, "C3"), BI).some((x) => x.id === "ADD-C3-x1"), true, "back after Restore");
  assert.strictEqual(Core.removeAddedHouse(withOne, "ADD-C3-x1").added.length, 0);
  await Reg.registry.removeAddedHouse("ADD-C3-x1");
  assert.strictEqual(Reg.allSubscribers().length, SUBSCRIBERS.length);
});

await test("searchHouses: any order of words, address first, number-led matches first, nothing for blank or no match", () => {
  const first = by.get("B21-001");
  assert.ok(Search.searchHouses(SUBSCRIBERS, "FAIRVIEW").some((x) => x.id === "B21-001"));
  assert.strictEqual(Search.searchHouses(SUBSCRIBERS, "14 FAIRVIEW")[0].id, "B21-001");
  assert.strictEqual(Search.searchHouses(SUBSCRIBERS, "LANGFORD ROWAN")[0].id, "B21-001");
  assert.strictEqual(Search.searchHouses(SUBSCRIBERS, first.postal.toLowerCase()).some((x) => x.id === "B21-001"), true);
  assert.deepStrictEqual([Search.searchHouses(SUBSCRIBERS, ""), Search.searchHouses(SUBSCRIBERS, "   "), Search.searchHouses(SUBSCRIBERS, "qqqzzz")], [[], [], []]);
  assert.strictEqual(Search.searchHouses(SUBSCRIBERS, "24 FAIRVIEW BLVD")[0].address, "24 FAIRVIEW BLVD", "an exact address ranks first");
  const many = Search.searchHouses(SUBSCRIBERS, "st", 5);
  assert.strictEqual(many.length, 5);
});

await test("cleanHouseInput / buildHouse: upper case, postal code shape, a house number is required", () => {
  const input = { name: " ", address: " 9  test rd ", postal: "n2j1a1", city: "Waterloo", routeId: "C3", schedule: "Mon-Sat" };
  const c = AH.cleanHouseInput(input);
  assert.deepStrictEqual([c.name, c.address, c.postal], ["NEW START", "9 TEST RD", "N2J 1A1"]);
  assert.strictEqual(AH.cleanHouseInput({ ...input, postal: "" }).postal, "");
  assert.throws(() => AH.cleanHouseInput({ ...input, address: "TEST RD" }), /house number/);
  assert.throws(() => AH.cleanHouseInput({ ...input, postal: "12345" }), /postal code/);
  assert.throws(() => AH.cleanHouseInput({ ...input, routeId: "" }), /Pick a route/);
  const h = AH.buildHouse(input, { lat: 43.46, lng: -80.52 }, 1_000_000);
  assert.deepStrictEqual([h.id.startsWith("ADD-C3-"), h.address, h.schedule, h.lat], [true, "9 TEST RD", "Mon-Sat", 43.46]);
  assert.notStrictEqual(AH.newHouseId("C3", 1), AH.newHouseId("C3", 2));
});

await test("findAddress: reuses a building already on the routes, tries the postal code then the street, refuses a match outside the region", async () => {
  const calls = [];
  const deps = (replies, known = new Map()) => ({ fetchJson: async (url) => { calls.push(decodeURIComponent(url.split("q=")[1])); return replies.shift() ?? []; }, sleep: async () => {}, known });
  const hit = (lat, lon) => [{ lat: String(lat), lon: String(lon), display_name: "9 Test Rd, Waterloo, Ontario" }];
  const known = new Map([[Geo.addressKey("14 FAIRVIEW BLVD", "Kitchener"), { lat: 43.4, lng: -80.5 }]]);
  const reused = await Geo.findAddress({ address: "14 FAIRVIEW BLVD APT 3", city: "Kitchener", postal: "" }, deps([], known));
  assert.deepStrictEqual([reused.reused, reused.coord.lat, calls.length], [true, 43.4, 0], "an apartment shares its building's coordinates, no request");
  const one = await Geo.findAddress({ address: "9 TEST RD", city: "Waterloo", postal: "N2J 1A1" }, deps([hit(43.46, -80.52)]));
  assert.deepStrictEqual([one.reused, one.label, calls.length, calls[0]], [false, "9 Test Rd, Waterloo, Ontario", 1, "9 TEST RD, Waterloo, ON, N2J 1A1"]);
  calls.length = 0;
  const two = await Geo.findAddress({ address: "9 TEST RD", city: "Waterloo", postal: "N2J 1A1" }, deps([[], hit(43.46, -80.52)]));
  assert.deepStrictEqual([!!two, calls.length, calls[1]], [true, 2, "9 TEST RD, Waterloo, ON"]);
  calls.length = 0;
  assert.strictEqual(await Geo.findAddress({ address: "9 TEST RD", city: "Waterloo", postal: "" }, deps([hit(45.4, -75.7), hit(45.4, -75.7)])), null, "Ottawa is not a match");
  assert.strictEqual(calls[0], "9 TEST RD, Waterloo, ON", "no empty postal in the query");
  assert.strictEqual(await Geo.findAddress({ address: "9 TEST RD", city: "Waterloo", postal: "" }, deps([[], []])), null);
  await assert.rejects(Geo.findAddress({ address: "9 TEST RD", city: "Waterloo", postal: "" }, { fetchJson: async () => { throw new Error("The address lookup service answered 503."); }, sleep: async () => {}, known: new Map() }), /503/);
});

const newId = "ADD-C3-t1";
const nearOf = (id, d = 0.0003) => ({ lat: by.get(id).lat + d, lng: by.get(id).lng + d });
const coordWith = (id, c) => (x) => (x === id ? c : coordOf(x));
const twinOf = (c) => AH.findRoadTwin(c, SUBSCRIBERS, matrixIdOfHouse);   // what the form gives a new house
const matrixWith = (id, twin) => (x) => (x === id ? twin : matrixIdOf(x));
await test("findRoadTwin: the nearest house with road data within 80 m; none when nothing is that close", () => {
  const j3 = SEED_ORDERS.C3, near = nearOf(j3[30], 0.0002);   // about 30 m away
  const twin = twinOf(near);
  assert.ok(twin, "a twin was found");
  const nearest = [...SUBSCRIBERS].sort((a, b) => Math.hypot(a.lat - near.lat, (a.lng - near.lng) * 0.73) - Math.hypot(b.lat - near.lat, (b.lng - near.lng) * 0.73))[0];
  assert.strictEqual(twin, matrixIdOfHouse(nearest));
  assert.strictEqual(twinOf({ lat: 43.6, lng: -80.2 }), undefined, "open country");
  assert.strictEqual(AH.buildHouse({ name: "", address: "9 TEST RD", postal: "", city: "Waterloo", routeId: "C3", schedule: "Mon-Sat" }, near, 1, twin).roadTwin, twin);
  assert.strictEqual("roadTwin" in AH.buildHouse({ name: "", address: "9 TEST RD", postal: "", city: "Waterloo", routeId: "C3", schedule: "Mon-Sat" }, near, 1), false);
});
await test("placeNewHouses: a house the saved order and seed never saw goes beside its neighbour, the old order is untouched", () => {
  const j3 = SEED_ORDERS.C3, c30 = nearOf(j3[31]);   // a probe where the demo layout puts the new house beside its neighbour (most do; 30 is one that does not)
  const out = Shift.placeNewHouses([...j3, newId], new Set(j3), new Set(), coordWith(newId, c30), matrixWith(newId, twinOf(c30)));
  assert.deepStrictEqual(out.filter((id) => id !== newId), j3, "the other 53 stay in order");
  const twin = twinOf(c30);
  assert.ok(j3.includes(twin), "the nearest house is on this route");
  assert.ok(Math.abs(out.indexOf(newId) - out.indexOf(twin)) === 1, `landed at ${out.indexOf(newId)}, its neighbour is at ${out.indexOf(twin)}`);
  assert.deepStrictEqual(Shift.placeNewHouses(j3, new Set(j3), new Set(), coordOf, matrixIdOf), j3, "nothing new, nothing moves");
  assert.deepStrictEqual(Shift.placeNewHouses([newId], new Set(), new Set(), coordWith(newId, nearOf(j3[0])), matrixWith(newId, twinOf(nearOf(j3[0])))), [newId], "a route of only new houses");
});
await test("placeNewHouses: C13's first nine stay first even for a house beside the first one", () => {
  const j13 = SEED_ORDERS.C13, anchors = anchorIdsFor(["C13"], SUBSCRIBERS);
  const c = nearOf(j13[0], 0.00015);
  const out = Shift.placeNewHouses([...j13, newId], new Set(j13), new Set(anchors), coordWith(newId, c), matrixWith(newId, twinOf(c)));
  assert.deepStrictEqual(out.slice(0, 9), anchors);
  assert.ok(out.indexOf(newId) >= 9);
  assert.deepStrictEqual(out.filter((id) => id !== newId), j13);
});
await test("insertIntoShift: delivered houses stay put, the new house goes beside its neighbour among the rest, stopped ones stay at the bottom", () => {
  const order = SEED_ORDERS.C3, delivered = order.slice(0, 20);
  const c40 = nearOf(order[40]), co = coordWith(newId, c40), mo = matrixWith(newId, twinOf(c40));
  const out = Shift.insertIntoShift(order, delivered, [], newId, co, mo);
  assert.deepStrictEqual(out.slice(0, 20), delivered);
  assert.deepStrictEqual(out.filter((id) => id !== newId), order);
  const twin = twinOf(c40);
  assert.ok(order.indexOf(twin) >= 20, "the nearest house is still to come");
  assert.ok(out.indexOf(newId) >= 20 && Math.abs(out.indexOf(newId) - out.indexOf(twin)) === 1, `landed at ${out.indexOf(newId)}, its neighbour is at ${out.indexOf(twin)}`);
  const stopped = [order[45]];
  const out2 = Shift.insertIntoShift(order, delivered, stopped, newId, co, mo);
  assert.strictEqual(out2[out2.length - 1], order[45]);
  assert.ok(out2.includes(newId) && out2.length === order.length + 1);
  assert.deepStrictEqual(Shift.insertIntoShift(out, delivered, [], newId, co, mo), out, "adding it twice changes nothing");
  assert.deepStrictEqual(Shift.insertIntoShift(order, order, [], newId, co, mo), [...order, newId], "everything delivered: it is the only stop left");
  const none = Shift.insertIntoShift(order, [], [], newId, co, mo);
  assert.deepStrictEqual(none.filter((id) => id !== newId), order, "nothing delivered yet: from the library");
});

const day = "2026-10-28", shiftKey = "@rr/shift/" + day;
const resetShiftStores = () => {
  store["@rr/pausedSubs/v1"] = "{}"; store["@rr/settings/v1"] = JSON.stringify({ rateCents: 35 });
  for (const k of ["@rr/history/v1", "@rr/lastClosed/v1", shiftKey]) delete store[k];
};
await test("deleteRecord: a shift removed from the history stops counting in the totals; an unknown id is refused", async () => {
  resetShiftStores();
  await Shift.recordShift(shiftState({ startedAt: at(2026, 10, 26, 21).getTime() }));
  await Shift.recordShift(shiftState({ startedAt: at(2026, 10, 27, 21).getTime() }));
  const before = await H.loadHistory();
  assert.strictEqual(before.length, 2);
  await H.deleteRecord(before[0].id);
  const after = await H.loadHistory();
  assert.deepStrictEqual(after.map((r) => r.id), [before[1].id]);
  assert.strictEqual(H.totalsOf(after).payCents, H.payCents(before[1]), "totals follow the history");
  await assert.rejects(H.deleteRecord("nope"), /isn't in the history/);
});
await test("reopen: Shift done by mistake is undone: the shift is back as it was, out of the history, and its GPS points survive", async () => {
  resetShiftStores();
  const s = shiftState({ startedAt: at(2026, 10, 27, 21).getTime() });
  Object.assign(loc, { servicesOn: true, foreground: "granted", background: "granted", started: false });
  await Trk.startTracking(s.startedAt);
  store["@rr/track/points/" + s.startedAt] = JSON.stringify(Array.from({ length: 11 }, (_, i) => fix(i * 10_000, i * 100)));
  await Shift.recordShift(s);
  assert.strictEqual((await H.loadHistory()).length, 1);
  const closed = await Reo.loadClosed();
  assert.deepStrictEqual([closed.recordId, closed.state.deliveredIds], [String(s.startedAt), s.deliveredIds]);
  const back = await Reo.reopenShift(day, Date.now());
  assert.deepStrictEqual([back.deliveredIds, back.orderedIds, back.finishedAt, back.date, back.startedAt], [s.deliveredIds, s.orderedIds, null, day, s.startedAt]);
  assert.strictEqual(JSON.parse(store[shiftKey]).startedAt, s.startedAt, "saved as the open shift");
  assert.deepStrictEqual([(await H.loadHistory()).length, await Reo.loadClosed()], [0, null]);
  assert.ok(store["@rr/track/points/" + s.startedAt], "the points are still there");
  await Shift.recordShift(back);   // ending it again records it once, with the whole GPS distance
  const [r] = await H.loadHistory();
  assert.ok(Math.abs(r.drivenM - 1000) < 15, String(r.drivenM));
});
await test("reopen: refused with nothing to reopen, with a shift already open, and after 12 hours", async () => {
  resetShiftStores();
  await assert.rejects(Reo.reopenShift(day, Date.now()), /no ended shift/);
  const s = shiftState({ startedAt: at(2026, 10, 27, 21).getTime() });
  await Shift.recordShift(s);
  store[shiftKey] = JSON.stringify(shiftState({ date: day }));
  await assert.rejects(Reo.reopenShift(day, Date.now()), /already open/);
  assert.strictEqual((await H.loadHistory()).length, 1, "a refused reopen leaves the history alone");
  delete store[shiftKey];
  await assert.rejects(Reo.reopenShift(day, Date.now() + 13 * 3_600_000), /too long ago/);
  assert.deepStrictEqual([Reo.canReopen(await Reo.loadClosed(), Date.now()), Reo.canReopen(await Reo.loadClosed(), Date.now() + 13 * 3_600_000), Reo.canReopen(null, 0)], [true, false, false]);
});
await test("reopen: only the latest ended shift can be reopened; removing it from the reports forgets it and its points", async () => {
  resetShiftStores();
  const a = shiftState({ startedAt: at(2026, 10, 26, 21).getTime() }), b = shiftState({ startedAt: at(2026, 10, 27, 21).getTime() });
  store["@rr/track/points/" + a.startedAt] = "[]"; store["@rr/track/points/" + b.startedAt] = "[]";
  await Shift.recordShift(a);
  await Shift.recordShift(b);
  assert.strictEqual((await Reo.loadClosed()).recordId, String(b.startedAt));
  assert.strictEqual(store["@rr/track/points/" + a.startedAt], undefined, "the older shift's points are gone");
  await Reo.forgetClosed(String(a.startedAt));
  assert.strictEqual((await Reo.loadClosed()).recordId, String(b.startedAt), "forgetting another shift leaves this one");
  await Reo.forgetClosed(String(b.startedAt));
  assert.deepStrictEqual([await Reo.loadClosed(), store["@rr/track/points/" + b.startedAt]], [null, undefined]);
});

// ---- notifications ----

const NH = lib("nextHouse"), Rem = lib("reminders"), Al = lib("alerts"), Ev = lib("shiftEvents"), Sto = lib("storage");
const housesById = new Map(SUBSCRIBERS.map((x) => [x.id, x]));
const nShift = (over = {}) => shiftState({ date: "2026-10-28", startedAt: at(2026, 10, 28, 22).getTime(), deliveredIds: [], skippedIds: [], ...over });
const clearShifts = () => { for (const k of Object.keys(store)) if (k.startsWith("@rr/shift/")) delete store[k]; };
const putShift = (s) => { store["@rr/shift/" + s.date] = JSON.stringify(s); return s; };
const resetAlerts = () => {
  Object.assign(notif, { scheduled: [], dismissed: [], cancelled: [], requests: 0, failNext: null });
  Object.assign(notif.perms, { granted: true, canAskAgain: true, allowOnRequest: true });
  rn.opened.length = 0;
  for (const k of ["@rr/alerts/near", "@rr/alerts/error", "@rr/alerts/handled", "@rr/track/error"]) delete store[k];
  store["@rr/pausedSubs/v1"] = "{}"; clearShifts();
};
const lastShown = () => notif.scheduled[notif.scheduled.length - 1];
const press = (action, houseId, shift, date = Date.now()) => ({ actionIdentifier: action, notification: { date, request: { identifier: "x", content: { data: { houseId, shift } } } } });

await test("nextStop: the first house still to do, skipping ticked, stopped and unknown ones; stopsLeft agrees", () => {
  const s = nShift({ orderedIds: ["NOPE", ...ids], deliveredIds: [ids[0], ids[1]] });
  assert.strictEqual(NH.nextStop(s, { [ids[2]]: true }, housesById).id, ids[3]);
  assert.strictEqual(NH.stopsLeft(s, { [ids[2]]: true }, housesById), ids.length - 3);
  assert.strictEqual(NH.nextStop(nShift({ orderedIds: ids, deliveredIds: ids }), {}, housesById), null);
  assert.strictEqual(NH.nextStop(nShift({ orderedIds: ["NOPE"] }), {}, housesById), null);
});
await test("markDeliveredState: ticks with a time, clears a skip, and ticking again changes nothing", () => {
  const s = nShift({ skippedIds: [ids[4]] });
  const t = NH.markDeliveredState(s, ids[4], 1234);
  assert.deepStrictEqual([t.deliveredIds, t.deliveredAt[ids[4]], t.skippedIds], [[ids[4]], 1234, []]);
  assert.strictEqual(NH.markDeliveredState(t, ids[4], 9999), t);
  assert.strictEqual(s.deliveredIds.length, 0, "the old state is untouched");
});
await test("nearStep: one alert when the car comes in from outside; none for a house already close; a new next house starts over", () => {
  const run = (dists, houseId = "A", state = null) => dists.map((d) => { const r = NH.nearStep(state, 1, houseId, d); state = r.state; return r.alert; });
  assert.deepStrictEqual(run([400, 250, 99, 60, 20]), [false, false, true, false, false]);
  assert.deepStrictEqual(run([400, 100]), [false, true], "exactly at the limit counts as near");
  assert.deepStrictEqual(run([60, 30, 200, 50]), [false, false, false, true], "already close when it became next: no alert then; leaving and coming back alerts once");
  assert.deepStrictEqual(run([400, 50, 300, 50]), [false, true, false, false], "once per house");
  const first = NH.nearStep(null, 1, "A", 400), second = NH.nearStep(first.state, 1, "B", 500);
  assert.deepStrictEqual([second.state.houseId, second.state.alerted, NH.nearStep(second.state, 2, "B", 500).state.shift], ["B", false, 2]);
});

await test("reminders: times parse, evenings only; the plan has one weekly notification per night, Sunday = weekday 1", () => {
  assert.deepStrictEqual([Rem.parseTime("20:30"), Rem.parseTime("8:30 pm"), Rem.parseTime(" 12:00 "), Rem.parseTime("11:59 PM")], [{ hour: 20, minute: 30 }, { hour: 20, minute: 30 }, { hour: 12, minute: 0 }, { hour: 23, minute: 59 }]);
  for (const bad of ["8", "25:00", "20:75", "8:30 xm", "13:00 pm", "9:00", "6:00 am", ""]) assert.throws(() => Rem.parseTime(bad), bad);
  assert.strictEqual(Rem.timeText(20, 5), "8:05 pm");
  const plan = Rem.reminderPlan({ on: true, hour: 20, minute: 30, nights: [5, 0, 0] });
  assert.deepStrictEqual(plan.map((p) => [p.identifier, p.weekday, p.hour, p.minute]), [["rr-remind-0", 1, 20, 30], ["rr-remind-5", 6, 20, 30]]);
  assert.ok(plan[0].body.startsWith("Mon paper") && plan[1].body.startsWith("Sat paper"), "Sunday night is Monday's paper, Friday night is Saturday's");
  assert.deepStrictEqual(Rem.reminderPlan({ on: false, hour: 20, minute: 0, nights: [0] }), []);
  assert.throws(() => Rem.reminderPlan({ on: true, hour: 20, minute: 0, nights: [6] }), /isn't a night worked/);
});
await test("reminders: settings save and load; a damaged file is an error, not defaults", async () => {
  delete store["@rr/reminders/v1"];
  assert.deepStrictEqual(await Rem.loadReminders(), Rem.DEFAULT_REMINDERS);
  await Rem.saveReminders({ on: true, hour: 21, minute: 15, nights: [1, 2] });
  assert.deepStrictEqual(await Rem.loadReminders(), { on: true, hour: 21, minute: 15, nights: [1, 2] });
  store["@rr/reminders/v1"] = JSON.stringify({ on: "yes" });
  await assert.rejects(Rem.loadReminders(), /expected shape/);
  delete store["@rr/reminders/v1"];
});

await test("loadActiveShift: the open shift whatever its date key, the newest if several, none once finished", async () => {
  resetAlerts();
  assert.strictEqual(await Sto.loadActiveShift(), null);
  putShift(nShift({ date: "2026-10-27", startedAt: 100, finishedAt: 500 }));
  assert.strictEqual(await Sto.loadActiveShift(), null, "a finished shift is not open");
  putShift(nShift({ date: "2026-10-26", startedAt: 200 }));
  putShift(nShift({ date: "2026-10-29", startedAt: 300 }));
  assert.strictEqual((await Sto.loadActiveShift()).startedAt, 300);
});

await test("syncNextHouse: one ongoing notification with the next house, how many are left and both buttons", async () => {
  resetAlerts();
  const s = nShift({ orderedIds: ids, deliveredIds: [ids[0]] });
  await Al.syncNextHouse(s, { [ids[1]]: true }, true);
  const n = lastShown();
  assert.strictEqual(n.identifier, "rr-next");
  assert.ok(n.content.title.includes(by.get(ids[2]).address), n.content.title);
  assert.ok(n.content.body.includes(`${ids.length - 2} left`), n.content.body);
  assert.deepStrictEqual([n.content.sticky, n.content.categoryIdentifier, n.content.data, n.trigger.channelId], [true, "rr-house", { houseId: ids[2], shift: s.startedAt }, "rr-next-house"]);
  assert.deepStrictEqual(notif.categories["rr-house"].map((a) => [a.identifier, a.buttonTitle, a.options.opensAppToForeground]), [["delivered", "Delivered", false], ["navigate", "Navigate", true]]);
  assert.deepStrictEqual(Object.keys(notif.channels).sort(), ["rr-near-house", "rr-next-house", "rr-reminder"]);
  assert.strictEqual(notif.requests, 0, "already allowed, so no prompt");
});
await test("syncNextHouse: every house ticked says so; no shift removes the notification; a refusal is an error naming the fix", async () => {
  resetAlerts();
  await Al.syncNextHouse(nShift({ orderedIds: ids, deliveredIds: ids }), {}, true);
  assert.strictEqual(lastShown().content.title, "All delivered");
  await Al.syncNextHouse(null, {}, true);
  assert.deepStrictEqual(notif.dismissed.slice(-2), ["rr-next", "rr-near"]);
  Object.assign(notif.perms, { granted: false, canAskAgain: false });
  await assert.rejects(Al.syncNextHouse(nShift({ orderedIds: ids }), {}, true), /Notifications are off for Night Route/);
});
await test("syncNextHouse: asks once when it may, shows the notification once allowed; without asking it never prompts", async () => {
  resetAlerts();
  Object.assign(notif.perms, { granted: false, canAskAgain: true, allowOnRequest: true });
  await assert.rejects(Al.syncNextHouse(nShift({ orderedIds: ids }), {}, false), /Notifications are off/);
  assert.strictEqual(notif.requests, 0);
  await Al.syncNextHouse(nShift({ orderedIds: ids }), {}, true);
  assert.deepStrictEqual([notif.requests, lastShown().identifier], [1, "rr-next"]);
});

await test("Delivered pressed with the app closed: the background task ticks the house, saves it, tells the screen, moves the notification on", async () => {
  resetAlerts();
  const s = putShift(nShift({ orderedIds: ids }));
  let heard = 0;
  const off = Ev.onShiftChangedElsewhere(() => heard++);
  await tasks["rr-notification-action"]({ data: press("delivered", ids[0], s.startedAt), error: null });
  off();
  const saved = JSON.parse(store["@rr/shift/2026-10-28"]);
  assert.deepStrictEqual([saved.deliveredIds, typeof saved.deliveredAt[ids[0]], heard], [[ids[0]], "number", 1]);
  assert.ok(lastShown().content.title.includes(by.get(ids[1]).address), "the notification now shows the next house");
  assert.strictEqual(lastShown().content.data.houseId, ids[1]);
  assert.strictEqual(store["@rr/alerts/error"], undefined);
  const shown = notif.scheduled.length;
  await tasks["rr-notification-action"]({ data: press("delivered", ids[0], s.startedAt), error: null });
  assert.deepStrictEqual([JSON.parse(store["@rr/shift/2026-10-28"]).deliveredIds, notif.scheduled.length], [[ids[0]], shown], "pressing it twice changes nothing");
});
await test("Delivered: a button on an old shift's notification, a stopped-house skip, and the last house", async () => {
  resetAlerts();
  const s = putShift(nShift({ orderedIds: ids.slice(0, 3) }));
  await tasks["rr-notification-action"]({ data: press("delivered", ids[0], s.startedAt - 1), error: null });
  assert.deepStrictEqual(JSON.parse(store["@rr/shift/2026-10-28"]).deliveredIds, [], "another shift's notification does nothing");
  store["@rr/pausedSubs/v1"] = JSON.stringify({ [ids[1]]: true });
  await tasks["rr-notification-action"]({ data: press("delivered", ids[0], s.startedAt), error: null });
  assert.strictEqual(lastShown().content.data.houseId, ids[2], "a Stopped house is skipped");
  await tasks["rr-notification-action"]({ data: press("delivered", ids[2], s.startedAt), error: null });
  assert.strictEqual(lastShown().content.title, "All delivered");
  clearShifts();
  const n = notif.scheduled.length;
  await tasks["rr-notification-action"]({ data: press("delivered", ids[0], s.startedAt), error: null });
  assert.deepStrictEqual([notif.scheduled.length, store["@rr/alerts/error"]], [n, undefined], "no open shift: nothing happens");
});
await test("the background task stores its failures for the shift screen instead of dropping them", async () => {
  resetAlerts();
  putShift(nShift({ orderedIds: ids }));
  await tasks["rr-notification-action"]({ data: undefined, error: { message: "the task manager said no" } });
  assert.strictEqual(await Al.lastAlertError(), "the task manager said no");
  await Al.clearAlertError();
  await tasks["rr-notification-action"]({ data: press("delivered", undefined, undefined), error: null });
  assert.match(await Al.lastAlertError(), /no house in it/);
  assert.deepStrictEqual(notif.registeredTasks, ["rr-notification-action"], "the task is registered with the library at import");
});
await test("Navigate opens Google Maps for that house; the same press is handled once", async () => {
  resetAlerts();
  const r = press("navigate", ids[2], 1, 777);
  await Al.handleLaunchResponse(r);
  await Al.handleLaunchResponse(r);
  assert.strictEqual(rn.opened.length, 1);
  assert.ok(rn.opened[0].startsWith("google.navigation:q=") && rn.opened[0].includes(encodeURIComponent(by.get(ids[2]).address)), rn.opened[0]);
  await assert.rejects(Al.handleAction(press("navigate", "NOPE", 1)), /no longer on a route/);
});

await test("checkNearHouse: one alert when the car comes within 100 m of the next house, not before, not again", async () => {
  resetAlerts();
  putShift(nShift({ orderedIds: ids }));
  const h = by.get(ids[0]), north = (m) => ({ lat: h.lat + m / 111320, lng: h.lng });
  for (const m of [600, 300, 150]) await Al.checkNearHouse(north(m));
  assert.strictEqual(notif.scheduled.length, 0, "still too far");
  await Al.checkNearHouse(north(80));
  assert.strictEqual(notif.scheduled.length, 1);
  const n = lastShown();
  assert.deepStrictEqual([n.identifier, n.content.categoryIdentifier, n.content.data.houseId, n.trigger.channelId], ["rr-near", "rr-house", ids[0], "rr-near-house"]);
  assert.ok(n.content.title.includes(h.address) && /^\d+ m away/.test(n.content.body), n.content.body);
  await Al.checkNearHouse(north(30)); await Al.checkNearHouse(north(90));
  assert.strictEqual(notif.scheduled.length, 1, "once per house");
});
await test("checkNearHouse: nothing without an open shift, with every house done, or with notifications off", async () => {
  resetAlerts();
  const h = by.get(ids[0]), near = { lat: h.lat + 0.0002, lng: h.lng };
  await Al.checkNearHouse({ lat: h.lat + 0.01, lng: h.lng }); await Al.checkNearHouse(near);
  putShift(nShift({ orderedIds: ids, deliveredIds: ids }));
  await Al.checkNearHouse({ lat: h.lat + 0.01, lng: h.lng }); await Al.checkNearHouse(near);
  clearShifts(); putShift(nShift({ orderedIds: ids }));
  Object.assign(notif.perms, { granted: false, canAskAgain: false });
  await Al.checkNearHouse({ lat: h.lat + 0.01, lng: h.lng }); await Al.checkNearHouse(near);
  assert.deepStrictEqual([notif.scheduled.length, notif.requests], [0, 0]);
});
await test("the GPS task raises the near alert from each fix, and a notification failure does not break the recording", async () => {
  resetAlerts();
  Object.assign(loc, { servicesOn: true, foreground: "granted", background: "granted", started: false });
  const s = putShift(nShift({ orderedIds: ids }));
  await Trk.startTracking(s.startedAt);
  const h = by.get(ids[0]), fixAt = (m, t) => ({ timestamp: t, coords: { latitude: h.lat + m / 111320, longitude: h.lng, accuracy: 5 } });
  await tasks[Trk.TRACK_TASK]({ data: { locations: [fixAt(400, 1000)] }, error: null });
  await tasks[Trk.TRACK_TASK]({ data: { locations: [fixAt(60, 6000)] }, error: null });
  assert.deepStrictEqual([notif.scheduled.map((x) => x.identifier), JSON.parse(store["@rr/track/points/" + s.startedAt]).length], [["rr-near"], 2]);
  const second = putShift(nShift({ startedAt: s.startedAt + 1000, orderedIds: ids.slice(3) })); clearShifts(); putShift(second);
  await Trk.stopTracking(s.startedAt); await Trk.startTracking(second.startedAt);
  notif.failNext = "the phone refused the alert";
  const h3 = by.get(ids[3]);
  await tasks[Trk.TRACK_TASK]({ data: { locations: [{ timestamp: 1000, coords: { latitude: h3.lat + 400 / 111320, longitude: h3.lng, accuracy: 5 } }] }, error: null });
  notif.failNext = "the phone refused the alert";
  await tasks[Trk.TRACK_TASK]({ data: { locations: [{ timestamp: 6000, coords: { latitude: h3.lat + 60 / 111320, longitude: h3.lng, accuracy: 5 } }] }, error: null });
  assert.strictEqual(JSON.parse(store["@rr/track/points/" + second.startedAt]).length, 2, "both fixes recorded");
  assert.strictEqual(store["@rr/track/error"], undefined, "not reported as a GPS error");
  assert.match(store["@rr/alerts/error"], /the phone refused the alert/);
});

await test("applyReminders: schedules a weekly notification per night, replaces the old ones, and off removes them", async () => {
  resetAlerts();
  const set = { on: true, hour: 20, minute: 30, nights: [0, 5] };
  assert.strictEqual(await Al.applyReminders(set), 2);
  const w = notif.scheduled.filter((r) => r.identifier.startsWith("rr-remind-"));
  assert.deepStrictEqual(w.map((r) => [r.identifier, r.trigger.type, r.trigger.weekday, r.trigger.hour, r.trigger.minute, r.trigger.channelId]), [["rr-remind-0", "weekly", 1, 20, 30, "rr-reminder"], ["rr-remind-5", "weekly", 6, 20, 30, "rr-reminder"]]);
  assert.strictEqual(await Al.applyReminders({ ...set, nights: [3] }), 1);
  assert.deepStrictEqual(notif.cancelled, ["rr-remind-0", "rr-remind-5"], "the previous ones were removed first");
  assert.strictEqual(await Al.applyReminders({ ...set, on: false }), 0);
  assert.ok(notif.cancelled.includes("rr-remind-3"));
  Object.assign(notif.perms, { granted: false, canAskAgain: false });
  assert.strictEqual(await Al.applyReminders({ ...set, on: false }), 0, "turning off needs no permission");
  await assert.rejects(Al.applyReminders(set), /Notifications are off/);
});
await test("the handler shows the near alert with a sound, and keeps the ongoing notification quiet", async () => {
  const quiet = await notif.handler.handleNotification({ request: { identifier: "rr-next" } });
  const loud = await notif.handler.handleNotification({ request: { identifier: "rr-near" } });
  assert.deepStrictEqual([quiet.shouldShowBanner, quiet.shouldPlaySound, loud.shouldShowBanner, loud.shouldPlaySound, quiet.shouldShowList], [false, false, true, true, true]);
});

cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
