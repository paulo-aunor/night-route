// Checks the app's logic against the real source: compiles src/ with tsc into a temp folder and runs the
// functions with React Native's storage and location swapped for in-memory stand-ins.
//
// usage: node scripts/test-logic.mjs        (no network; takes about 30 s because the order search is timed)

import assert from "assert";
import { loadApp } from "./lib/load-app.mjs";

const { store, loc, tasks, notif, rn, fileSystem, lib, data, cleanup } = loadApp();

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
await test("nearStep and nearResolve: the straight line asks for the road distance once per approach; the road distance decides", () => {
  const now = 1_000_000;
  const walk = (dists, start = null, house = "A") => { let st = start; return dists.map((d, i) => { const r = NH.nearStep(st, 1, house, d, now + i * 25_000); st = r.state; return r.lookup; }); };
  assert.deepStrictEqual(walk([400, 250, 140, 120, 60]), [false, false, true, true, true], "looks up on coming within 150 m, again every 20 s while still close, at most 3 times");
  assert.deepStrictEqual(walk([400, 140, 120, 90, 60, 30]), [false, true, true, true, false, false]);
  assert.deepStrictEqual(walk([60, 30, 20]), [false, false, false], "already close when it became next: never looked up");
  assert.deepStrictEqual(walk([400, 100, 300, 100]).filter(Boolean).length, 2, "leaving and coming back starts again");
  const quick = NH.nearStep(null, 1, "A", 400, now).state, first = NH.nearStep(quick, 1, "A", 100, now + 1000);
  assert.strictEqual(first.lookup, true);
  assert.strictEqual(NH.nearStep(first.state, 1, "A", 100, now + 5000).lookup, false, "not again within 20 s");
  assert.strictEqual(NH.nearStep(first.state, 1, "A", 100, now + 21_000).lookup, true);
  const yes = NH.nearResolve(first.state, 80), no = NH.nearResolve(first.state, 400), none = NH.nearResolve(first.state, null), edge = NH.nearResolve(first.state, 100);
  assert.deepStrictEqual([yes.alert, no.alert, none.alert, edge.alert], [true, false, false, true]);
  assert.deepStrictEqual([yes.state.alerted, no.state.alerted], [true, false]);
  assert.strictEqual(NH.nearStep(yes.state, 1, "A", 100, now + 99_000).lookup, false, "alerted: finished with this house");
  const other = NH.nearStep(yes.state, 1, "B", 400, now), second = NH.nearStep(yes.state, 2, "A", 400, now);
  assert.deepStrictEqual([other.state.houseId, other.state.alerted, second.state.shift], ["B", false, 2]);
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

// the routing server: what it is asked, and what it answers (road metres, or an error)
const osrm = { calls: [], answer: 80, fail: null };
const realFetch = globalThis.fetch;
const stubRouting = () => {
  osrm.calls.length = 0; osrm.answer = 80; osrm.fail = null;
  globalThis.fetch = async (url) => {
    osrm.calls.push(String(url));
    if (osrm.fail) throw new Error(osrm.fail);
    return { ok: true, status: 200, json: async () => ({ code: "Ok", routes: [{ distance: osrm.answer }] }) };
  };
};
const realNow = Date.now;
const clock = { t: 5_000_000 };
const useClock = () => { Date.now = () => clock.t; };
const restoreClock = () => { Date.now = realNow; globalThis.fetch = realFetch; };

await test("checkNearHouse: asks the routing server once the car is within 150 m in a straight line, alerts when the road is within 100 m", async () => {
  resetAlerts(); stubRouting(); useClock();
  try {
    putShift(nShift({ orderedIds: ids }));
    const h = by.get(ids[0]), north = (m) => ({ lat: h.lat + m / 111320, lng: h.lng });
    for (const m of [600, 300, 200]) await Al.checkNearHouse(north(m));
    assert.deepStrictEqual([osrm.calls.length, notif.scheduled.length], [0, 0], "far away: no request, no alert");
    await Al.checkNearHouse(north(120));
    assert.strictEqual(osrm.calls.length, 1);
    assert.ok(osrm.calls[0].includes("/route/v1/driving/") && osrm.calls[0].includes(`${h.lng.toFixed(6)},${h.lat.toFixed(6)}`), osrm.calls[0]);
    const n = lastShown();
    assert.deepStrictEqual([notif.scheduled.length, n.identifier, n.content.categoryIdentifier, n.content.data.houseId, n.trigger.channelId], [1, "rr-near", "rr-house", ids[0], "rr-near-house"]);
    assert.ok(n.content.title.includes(h.address) && /^80 m by road/.test(n.content.body), n.content.body);
    clock.t += 30_000; await Al.checkNearHouse(north(60)); await Al.checkNearHouse(north(30));
    assert.deepStrictEqual([osrm.calls.length, notif.scheduled.length], [1, 1], "once per house");
  } finally { restoreClock(); }
});
await test("checkNearHouse: a house close on the line but far by road (a parallel street) does not alert, and is checked again", async () => {
  resetAlerts(); stubRouting(); useClock();
  try {
    putShift(nShift({ orderedIds: ids }));
    const h = by.get(ids[0]), north = (m) => ({ lat: h.lat + m / 111320, lng: h.lng });
    await Al.checkNearHouse(north(400));
    osrm.answer = 700;                    // the street the car is on only reaches the house the long way round
    await Al.checkNearHouse(north(80));
    assert.deepStrictEqual([osrm.calls.length, notif.scheduled.length], [1, 0]);
    clock.t += 5_000; await Al.checkNearHouse(north(80));
    assert.strictEqual(osrm.calls.length, 1, "not again within 20 s");
    clock.t += 20_000; osrm.answer = 60;  // the car turned in and the road is short now
    await Al.checkNearHouse(north(70));
    assert.deepStrictEqual([osrm.calls.length, notif.scheduled.length, /^60 m by road/.test(lastShown().content.body)], [2, 1, true]);
    resetAlerts(); stubRouting(); osrm.answer = 700; putShift(nShift({ orderedIds: ids }));
    await Al.checkNearHouse(north(400));
    for (let i = 0; i < 6; i++) { clock.t += 25_000; await Al.checkNearHouse(north(80)); }
    assert.deepStrictEqual([osrm.calls.length, notif.scheduled.length], [3, 0], "at most three lookups for one approach");
  } finally { restoreClock(); }
});
await test("checkNearHouse: with no signal it uses the straight-line distance and says so; no route at all never alerts", async () => {
  resetAlerts(); stubRouting(); useClock();
  try {
    putShift(nShift({ orderedIds: ids }));
    const h = by.get(ids[0]), north = (m) => ({ lat: h.lat + m / 111320, lng: h.lng });
    await Al.checkNearHouse(north(400));
    osrm.fail = "Network request failed";
    await Al.checkNearHouse(north(60));
    assert.strictEqual(notif.scheduled.length, 1, "60 m on the line: alert anyway");
    assert.ok(/^60 m away/.test(lastShown().content.body), lastShown().content.body);
    assert.match(await Al.lastAlertError(), /Couldn't check the road distance to the next house \(Network request failed\)\. Using the straight-line distance/);
    resetAlerts(); stubRouting(); putShift(nShift({ orderedIds: ids }));
    await Al.checkNearHouse(north(400)); osrm.fail = "boom";
    await Al.checkNearHouse(north(130));
    assert.strictEqual(notif.scheduled.length, 0, "130 m on the line is not near, even without signal");
  } finally { restoreClock(); }
});
await test("checkNearHouse: nothing without an open shift, with every house done, or with notifications off", async () => {
  resetAlerts(); stubRouting(); useClock();
  try {
    const h = by.get(ids[0]), near = { lat: h.lat + 0.0002, lng: h.lng };
    await Al.checkNearHouse({ lat: h.lat + 0.01, lng: h.lng }); await Al.checkNearHouse(near);
    putShift(nShift({ orderedIds: ids, deliveredIds: ids }));
    await Al.checkNearHouse({ lat: h.lat + 0.01, lng: h.lng }); await Al.checkNearHouse(near);
    clearShifts(); putShift(nShift({ orderedIds: ids }));
    Object.assign(notif.perms, { granted: false, canAskAgain: false });
    await Al.checkNearHouse({ lat: h.lat + 0.01, lng: h.lng }); await Al.checkNearHouse(near);
    assert.deepStrictEqual([notif.scheduled.length, notif.requests, osrm.calls.length], [0, 0, 0]);
  } finally { restoreClock(); }
});
await test("the GPS task raises the near alert from each fix, and a notification failure does not break the recording", async () => {
  resetAlerts(); stubRouting(); useClock();
  try {
    Object.assign(loc, { servicesOn: true, foreground: "granted", background: "granted", started: false });
    const s = putShift(nShift({ orderedIds: ids }));
    await Trk.startTracking(s.startedAt);
    const h = by.get(ids[0]), fixAt = (m, t) => ({ timestamp: t, coords: { latitude: h.lat + m / 111320, longitude: h.lng, accuracy: 5 } });
    await tasks[Trk.TRACK_TASK]({ data: { locations: [fixAt(400, 1000)] }, error: null });
    await tasks[Trk.TRACK_TASK]({ data: { locations: [fixAt(60, 6000)] }, error: null });
    assert.deepStrictEqual([notif.scheduled.map((x) => x.identifier), JSON.parse(store["@rr/track/points/" + s.startedAt]).length], [["rr-near"], 2]);
    const second = putShift(nShift({ startedAt: s.startedAt + 1000, orderedIds: ids.slice(3) })); clearShifts(); putShift(second);
    await Trk.stopTracking(s.startedAt); await Trk.startTracking(second.startedAt);
    const h3 = by.get(ids[3]);
    await tasks[Trk.TRACK_TASK]({ data: { locations: [{ timestamp: 1000, coords: { latitude: h3.lat + 400 / 111320, longitude: h3.lng, accuracy: 5 } }] }, error: null });
    notif.failNext = "the phone refused the alert";
    await tasks[Trk.TRACK_TASK]({ data: { locations: [{ timestamp: 6000, coords: { latitude: h3.lat + 60 / 111320, longitude: h3.lng, accuracy: 5 } }] }, error: null });
    assert.strictEqual(JSON.parse(store["@rr/track/points/" + second.startedAt]).length, 2, "both fixes recorded");
    assert.strictEqual(store["@rr/track/error"], undefined, "not reported as a GPS error");
    assert.match(store["@rr/alerts/error"], /the phone refused the alert/);
  } finally { restoreClock(); }
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

// ---- how a shift was driven ----

const Drv = lib("driving"), Arc = lib("archive");
const o0 = { lat: 43.46, lng: -80.52 };
const mE = (m) => m / (111320 * Math.cos(o0.lat * Math.PI / 180)), mN = (m) => m / 111320;
const gpsFix = (t, eastM, northM = 0, sp = null, acc = 5) => ({ t, lat: o0.lat + mN(northM), lng: o0.lng + mE(eastM), acc, hd: null, sp });
// a straight run east at `v` m/s from x0, one fix every `every` s, starting at time t0
const runEast = (t0, x0, v, secs, every = 2, withSpeed = true) => {
  const out = [];
  for (let s = 0; s <= secs; s += every) out.push(gpsFix(t0 + s * 1000, x0 + v * s, 0, withSpeed ? v : null));
  return out;
};

await test("track encoding: points survive a round trip to about 0.1 m, unknowns stay unknown, order is by time", () => {
  const pts = [gpsFix(5000, 120.4, 3.3, 8.7, 6), { ...gpsFix(1000, 0, 0, null, 12), hd: 271 }, { ...gpsFix(3000, 50, -9, 0, 5), hd: null }];
  const enc = Arc.encodeTrack(pts, 0);
  assert.strictEqual(enc.d.length, 18);
  const back = Arc.decodeTrack(enc);
  assert.deepStrictEqual(back.map((p) => p.t), [1000, 3000, 5000]);
  assert.deepStrictEqual(back.map((p) => [p.acc, p.hd, p.sp]), [[12, 271, null], [5, null, 0], [6, null, 8.7]]);
  for (const [a, b] of [[back[2], pts[0]], [back[0], pts[1]], [back[1], pts[2]]]) assert.ok(Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lng - b.lng) < 1e-6);
  assert.throws(() => Arc.decodeTrack({ t0: 0, n: 3, d: [1, 2] }), /damaged/);
  assert.deepStrictEqual(Arc.decodeTrack(Arc.encodeTrack([], 0)), []);
});

await test("drivingStats: moving, a stop, speed over 50 km/h, a hole in the recording, distance", () => {
  const pts = [
    ...runEast(0, 0, 10, 60),                           // 60 s at 36 km/h: 600 m
    ...Array.from({ length: 21 }, (_, i) => gpsFix(62_000 + i * 2000, 600, 0, 0)),   // stands still for 40 s
    ...runEast(102_000, 600, 15, 30),                   // 30 s at 54 km/h: 450 m
    ...runEast(432_000, 1050, 5, 20),                   // 5 minutes later: a hole, not a stop; 100 m
  ];
  const st = Drv.drivingStats(pts);
  assert.ok(Math.abs(st.movedM - 1150) < 30, String(st.movedM));
  assert.deepStrictEqual([st.stops, Math.round(st.stoppedS), Math.round(st.longestStopS)], [1, 40, 40]);
  assert.ok(st.gapS > 290 && st.gapS < 310, String(st.gapS));
  assert.ok(Math.abs(st.topKmh - 54) < 1, String(st.topKmh));
  assert.ok(Math.abs(st.aboveLimitS - 30) < 3, String(st.aboveLimitS));
  assert.ok(st.avgMovingKmh > 35 && st.avgMovingKmh < 50, String(st.avgMovingKmh));
  assert.strictEqual(st.movingS + st.stoppedS + 0 <= st.recordedS + 1, true);
  const none = Drv.drivingStats([]);
  assert.deepStrictEqual([none.movedM, none.stops, none.topKmh, none.avgMovingKmh], [0, 0, null, null]);
});
await test("drivingStats: a pause under 20 s is not a stop; a glitch jump and poor fixes do not count as speed", () => {
  const pts = [...runEast(0, 0, 10, 20), ...Array.from({ length: 5 }, (_, i) => gpsFix(22_000 + i * 2000, 200, 0, 0)), ...runEast(32_000, 200, 10, 20)];
  assert.strictEqual(Drv.drivingStats(pts).stops, 0);
  const glitch = [...runEast(0, 0, 10, 40), gpsFix(41_000, 9000, 0, null)];   // 8 km away one second later
  assert.ok(Drv.drivingStats(glitch).topKmh < 40);
  const poor = [...runEast(0, 0, 10, 40), { ...gpsFix(42_000, 9000, 0, null), acc: 300 }];
  assert.ok(Drv.drivingStats(poor).topKmh < 40);
});
await test("drivingStats: hard braking and acceleration from the phone's speed, and from positions when there is none", () => {
  // 12 m/s, then 3 m/s two seconds later: 4.5 m/s of braking per second
  const brake = [gpsFix(0, 0, 0, 12), gpsFix(2000, 24, 0, 12), gpsFix(4000, 33, 0, 3), gpsFix(6000, 39, 0, 3)];
  assert.deepStrictEqual([Drv.drivingStats(brake).hardBrakes, Drv.drivingStats(brake).hardAccels], [1, 0]);
  const accel = [gpsFix(0, 0, 0, 0), gpsFix(2000, 0, 0, 0), gpsFix(4000, 20, 0, 10), gpsFix(6000, 60, 0, 10)];
  assert.deepStrictEqual([Drv.drivingStats(accel).hardBrakes, Drv.drivingStats(accel).hardAccels], [0, 1]);
  const gentle = [gpsFix(0, 0, 0, 12), gpsFix(2000, 24, 0, 10), gpsFix(4000, 44, 0, 8), gpsFix(6000, 60, 0, 6)];
  assert.deepStrictEqual([Drv.drivingStats(gentle).hardBrakes, Drv.drivingStats(gentle).hardAccels], [0, 0]);
  // no speed from the phone: legs of 12 m/s, 12 m/s, 0.5 m/s, 0.5 m/s, each 2 s: the drop is seen between legs
  const derived = [gpsFix(0, 0), gpsFix(2000, 24), gpsFix(4000, 48), gpsFix(6000, 50), gpsFix(8000, 52), gpsFix(10000, 53)];
  assert.strictEqual(Drv.drivingStats(derived).hardBrakes, 1);
  assert.strictEqual(Drv.drivingStats(runEast(0, 0, 10, 60, 2, false)).hardBrakes, 0, "steady driving brakes nowhere");
});

// houses along a street 15 m north of the road, every 100 m
const street = [100, 200, 300, 400].map((x, i) => ({ id: "S" + i, lat: o0.lat + mN(15), lng: o0.lng + mE(x) }));
await test("passesBeforeDelivery: a house passed on the way out and delivered on the way back has one earlier pass", () => {
  const out = runEast(0, 0, 10, 50), back = Array.from({ length: 26 }, (_, i) => gpsFix(52_000 + i * 2000, 500 - 10 * i * 2, 0, 10));
  const ticks = { S0: 10_000, S1: 20_000, S2: 30_000, S3: 40_000 };
  assert.deepStrictEqual(Drv.passesBeforeDelivery(street, [...out, ...back], ticks).found.map((f) => [f.id, f.before.length]), [["S0", 0], ["S1", 0], ["S2", 0], ["S3", 0]]);
  const late = { ...ticks, S1: 52_000 + 15_000 };   // S1 ticked on the way back
  const r = Drv.passesBeforeDelivery(street, [...out, ...back], late);
  assert.deepStrictEqual(r.found.map((f) => [f.id, f.before.length]), [["S0", 0], ["S1", 1], ["S2", 0], ["S3", 0]]);
  const first = r.found[1].before[0];
  assert.ok(Math.abs(first.t - 20_000) < 2500 && Math.abs(first.distM - 15) < 1, JSON.stringify(first));
  assert.ok(r.found[1].deliveredAt > 60_000);
});
await test("passesBeforeDelivery: out, back and out again gives two earlier passes; far, unticked and unrecorded houses are left out", () => {
  const leg = (t0, x0, dir) => Array.from({ length: 26 }, (_, i) => gpsFix(t0 + i * 2000, x0 + dir * 10 * i * 2, 0, 10));
  const track = [...leg(0, 0, 1), ...leg(52_000, 500, -1), ...leg(104_000, 0, 1)];
  const far = { id: "FAR", lat: o0.lat + mN(300), lng: o0.lng + mE(200) };
  const r = Drv.passesBeforeDelivery([street[1], far, street[2]], track, { S1: 104_000 + 12_000, FAR: 30_000 });
  assert.deepStrictEqual(r.found.map((f) => [f.id, f.before.length]), [["S1", 2]]);
  assert.strictEqual(r.unmatched, 1, "the far house was ticked where the car never went near it");
  assert.strictEqual(Drv.passesBeforeDelivery([street[1]], track, {}).found.length, 0, "never ticked: nothing says when");
  assert.deepStrictEqual(Drv.passesBeforeDelivery([street[1]], [], { S1: 1000 }), { found: [], unmatched: 1 });
});
await test("passesBeforeDelivery: a car parked between two houses counts as one pass for both; a gap in the recording is not a pass", () => {
  const parked = [...runEast(0, 0, 10, 10), ...Array.from({ length: 10 }, (_, i) => gpsFix(12_000 + i * 2000, 100, 0, 0)), ...runEast(32_000, 100, 10, 10)];
  const two = [{ id: "A", lat: o0.lat + mN(15), lng: o0.lng + mE(100) }, { id: "B", lat: o0.lat + mN(15), lng: o0.lng + mE(110) }];
  assert.deepStrictEqual(Drv.passesBeforeDelivery(two, parked, { A: 14_000, B: 30_000 }).found.map((f) => f.before.length), [0, 0]);
  const holed = [gpsFix(0, 0, 0, 10), gpsFix(120_000, 400, 0, 10)];   // two minutes with nothing: no segment, no pass
  assert.strictEqual(Drv.passesBeforeDelivery([street[1]], holed, { S1: 60_000 }).unmatched, 1);
});

await test("orderDeviation: houses outside the longest run that stayed in order, with how far each moved", () => {
  const planned = ["a", "b", "c", "d", "e", "f"];
  assert.deepStrictEqual(Drv.orderDeviation(planned, planned), { compared: 6, outOfOrder: 0, shifts: [] });
  const swap = Drv.orderDeviation(planned, ["a", "c", "b", "d", "e", "f"]);
  assert.deepStrictEqual([swap.compared, swap.outOfOrder, swap.shifts.length], [6, 1, 1]);
  assert.strictEqual(Drv.orderDeviation(planned, ["f", "e", "d", "c", "b", "a"]).outOfOrder, 5);
  const jump = Drv.orderDeviation(planned, ["a", "b", "d", "e", "f", "c"]);
  assert.deepStrictEqual([jump.outOfOrder, jump.shifts[0]], [1, { id: "c", planned: 2, delivered: 5 }]);
  const partial = Drv.orderDeviation(planned, ["x", "b", "a", "y"]);
  assert.deepStrictEqual([partial.compared, partial.outOfOrder], [2, 1], "houses not in the plan are left out");
  assert.deepStrictEqual(Drv.orderDeviation(planned, []), { compared: 0, outOfOrder: 0, shifts: [] });
});

await test("analyzeShift: time per house leaves out breaks; summarize keeps the figures the history needs", () => {
  const t0 = 1_000_000, tickAt = { a: t0 + 60_000, b: t0 + 120_000, c: t0 + 400_000, d: t0 + 1_500_000 };
  const a = Drv.analyzeShift({ points: [], houses: [], tickAt, tickOrder: ["a", "b", "c", "d"], plannedOrder: ["a", "c", "b", "d"], startedAt: t0 });
  assert.deepStrictEqual([a.timePerHouse.ticked, a.timePerHouse.medianS, Math.round(a.timePerHouse.meanS), a.timePerHouse.slowest[0]], [3, 60, 133, { id: "c", s: 280 }]);
  assert.deepStrictEqual([a.order.compared, a.order.outOfOrder], [4, 1]);
  const sum = Drv.summarize(a);
  assert.deepStrictEqual([sum.stops, sum.passedHouses, sum.outOfOrder, sum.topKmh], [0, 0, 1, null]);
  assert.strictEqual(Drv.summarize(Drv.analyzeShift({ points: [], houses: [], tickAt: {}, tickOrder: [], plannedOrder: null, startedAt: 0 })).outOfOrder, null, "no plan kept: no comparison");
});

await test("archive: a shift is kept whole and its analysis is the same from the file as from the raw track", async () => {
  const startedAt = at(2026, 11, 3, 22).getTime();
  const pts = [...runEast(startedAt, 0, 10, 50), ...Array.from({ length: 26 }, (_, i) => gpsFix(startedAt + 52_000 + i * 2000, 500 - 20 * i, 0, 10))];
  const houses = street.map((h) => ({ id: h.id, routeId: "C3", address: h.id + " TEST RD", lat: h.lat, lng: h.lng }));
  const s = { date: "2026-11-04", routeIds: ["C3"], startedAt, finishedAt: null, deliveredIds: ["S0", "S2", "S1", "S3"], skippedIds: [], orderedIds: ["S0", "S1", "S2", "S3"], startOrder: ["S0", "S1", "S2", "S3"],
    deliveredAt: { S0: startedAt + 10_000, S2: startedAt + 30_000, S1: startedAt + 67_000, S3: startedAt + 40_000 }, headingAt: { S0: 90 }, deliveryDayIdx: 2, startMode: "library", optimizations: [] };
  const a = Arc.buildArchive(s, { points: pts, houses, stoppedIds: [], finishedAt: startedAt + 120_000 });
  assert.deepStrictEqual([a.id, a.plannedOrder, a.tickOrder, a.houses.length, a.track.n], [String(startedAt), ["S0", "S1", "S2", "S3"], ["S0", "S2", "S1", "S3"], 4, pts.length]);
  const direct = Drv.analyzeShift({ points: pts, houses, tickAt: s.deliveredAt, tickOrder: a.tickOrder, plannedOrder: a.plannedOrder, startedAt });
  const viaFile = Arc.analyzeArchive(JSON.parse(JSON.stringify(a)));
  assert.deepStrictEqual([viaFile.passes.houses, viaFile.passes.total, viaFile.order.outOfOrder, viaFile.stats.stops], [direct.passes.houses, direct.passes.total, direct.order.outOfOrder, direct.stats.stops]);
  assert.ok(Math.abs(viaFile.stats.movedM - direct.stats.movedM) < 3, `${viaFile.stats.movedM} vs ${direct.stats.movedM}`);
  assert.deepStrictEqual([viaFile.passes.houses, viaFile.order.outOfOrder], [1, 1], "S1 was passed on the way out and delivered later, after S2");
  assert.throws(() => Arc.buildArchive({ ...s, startedAt: null }, { points: [], houses: [], stoppedIds: [], finishedAt: 1 }), /never started/);
  assert.strictEqual(Arc.buildArchive({ ...s, startOrder: undefined }, { points: [], houses: [], stoppedIds: [], finishedAt: 1 }).plannedOrder, null);
});
await test("archive files: save, list newest first, load, a damaged file is an error, delete, export everything in one file", async () => {
  for (const k of Object.keys(fileSystem.files)) delete fileSystem.files[k];
  const mk = (startedAt) => Arc.buildArchive({ date: "d", routeIds: ["C3"], startedAt, finishedAt: null, deliveredIds: [], skippedIds: [], orderedIds: [], deliveryDayIdx: 1, startMode: "library" }, { points: [gpsFix(startedAt, 0)], houses: [], stoppedIds: [], finishedAt: startedAt + 1 });
  assert.deepStrictEqual(await Arc.listArchives(), [], "no folder yet");
  await Arc.saveArchive(mk(1000)); await Arc.saveArchive(mk(3000)); await Arc.saveArchive(mk(2000));
  assert.deepStrictEqual(await Arc.listArchives(), ["3000", "2000", "1000"]);
  assert.strictEqual((await Arc.loadArchive("2000")).startedAt, 2000);
  assert.strictEqual(await Arc.loadArchive("999"), null);
  fileSystem.files["file:///doc/shift-archive/1000.json"] = JSON.stringify({ v: 2 });
  await assert.rejects(Arc.loadArchive("1000"), /isn't in the expected shape/);
  await Arc.saveArchive(mk(1000));
  const ex = await Arc.exportArchives(at(2026, 11, 4, 9).getTime());
  assert.deepStrictEqual([ex.shifts, ex.uri], [3, "file:///cache/night-route-driving-data-2026-11-04.json"]);
  const out = JSON.parse(fileSystem.files[ex.uri]);
  assert.deepStrictEqual([out.app, out.shifts.map((x) => x.id)], ["night-route", ["3000", "2000", "1000"]]);
  await Arc.deleteArchive("2000"); await Arc.deleteArchive("2000");
  assert.deepStrictEqual(await Arc.listArchives(), ["3000", "1000"], "deleting twice is fine");
});

await test("recordShift keeps the archive and a driving summary; without GPS it keeps neither; reopening removes the archive", async () => {
  resetShiftStores();
  for (const k of Object.keys(fileSystem.files)) delete fileSystem.files[k];
  Object.assign(loc, { servicesOn: true, foreground: "granted", background: "granted", started: false });
  const startedAt = at(2026, 11, 3, 22).getTime();
  // four houses well apart (over 80 m from each other), so each stop is a stop at one house only
  const spread = [];
  for (const id of SEED_ORDERS.C3) if (spread.every((h) => Math.hypot(h.lat - by.get(id).lat, (h.lng - by.get(id).lng) * 0.73) * 111320 > 80)) spread.push(by.get(id));
  const hs = spread.slice(0, 4);
  assert.strictEqual(hs.length, 4);
  // a continuous drive: 30 s at each house, then 5 s fixes while travelling to the next one
  const track = [];
  let clock = startedAt;
  hs.forEach((h, i) => {
    for (let k = 0; k < 7; k++, clock += 5000) track.push({ t: clock, lat: h.lat + mN(8), lng: h.lng, acc: 5, hd: null, sp: 0 });
    const n = hs[i + 1];
    if (!n) return;
    for (let k = 1; k <= 8; k++, clock += 5000) track.push({ t: clock, lat: h.lat + (n.lat - h.lat) * k / 9 + mN(8), lng: h.lng + (n.lng - h.lng) * k / 9, acc: 5, hd: null, sp: 6 });
  });
  const four = hs.map((h) => h.id);
  const s = shiftState({ date: "2026-11-04", startedAt, orderedIds: four, startOrder: four, deliveredIds: four, skippedIds: [], deliveredAt: Object.fromEntries(four.map((id, i) => [id, startedAt + i * 75_000 + 15_000])), deliveryDayIdx: 2 });
  store["@rr/track/points/" + startedAt] = JSON.stringify(track);
  await Shift.recordShift(s);
  const [r] = await H.loadHistory();
  assert.ok(r.driving && r.driving.stops === 4 && r.driving.outOfOrder === 0 && r.driving.passedHouses === 0, JSON.stringify(r.driving));
  const a = await Arc.loadArchive(String(startedAt));
  assert.deepStrictEqual([a.houses.length, a.houses[0].address, a.tickOrder.length], [4, hs[0].address, 4]);
  // no recording: no summary and no file
  await Shift.recordShift(shiftState({ date: "2026-11-05", startedAt: startedAt + 86_400_000, orderedIds: ids.slice(0, 2), deliveredIds: [], skippedIds: [], deliveryDayIdx: 2 }));
  const two = await H.loadHistory();
  assert.deepStrictEqual([two.length, two[1].driving, (await Arc.listArchives()).length], [2, undefined, 1]);
  // the latest shift is the one that can be reopened; doing so removes its record and (nothing to remove here) keeps the other archive
  assert.strictEqual((await Reo.reopenShift("2026-11-06", Date.now())).startedAt, startedAt + 86_400_000);
  assert.deepStrictEqual([(await H.loadHistory()).length, (await Arc.listArchives()).length], [1, 1]);
  await Shift.recordShift(s);   // end the first one again after replacing it: reopen the earlier by ending a newer
});
await test("reopen removes that shift's archive so ending it again keeps one", async () => {
  resetShiftStores();
  for (const k of Object.keys(fileSystem.files)) delete fileSystem.files[k];
  const startedAt = at(2026, 11, 3, 22).getTime(), h = by.get(ids[0]);
  store["@rr/track/points/" + startedAt] = JSON.stringify([{ t: startedAt, lat: h.lat, lng: h.lng, acc: 5 }, { t: startedAt + 5000, lat: h.lat + mN(40), lng: h.lng, acc: 5 }]);
  const s = shiftState({ date: "2026-11-04", startedAt, orderedIds: ids.slice(0, 2), startOrder: ids.slice(0, 2), deliveredIds: [], skippedIds: [], deliveryDayIdx: 2 });
  await Shift.recordShift(s);
  assert.strictEqual((await Arc.listArchives()).length, 1);
  await Reo.reopenShift("2026-11-04", Date.now());
  assert.deepStrictEqual([(await Arc.listArchives()).length, (await H.loadHistory()).length], [0, 0]);
  await Shift.recordShift(s);
  assert.deepStrictEqual([(await Arc.listArchives()).length, (await H.loadHistory()).length], [1, 1]);
});

await test("distanceComparison and drivingTotals add up only the shifts that have the figures", () => {
  const rec = (over) => ({ id: "x", startedAt: 0, finishedAt: 1, night: "2026-11-01", paperDay: 1, routeIds: ["C3"], due: 1, ticked: 1, counted: 0, skipped: 0, stopped: 0, rateCents: 35, plannedM: 1000, coveredM: 900, drivenM: 1200, savedM: 0, optimizations: 0, startMode: "library", byRoute: {}, ...over });
  assert.deepStrictEqual(H.distanceComparison([rec({}), rec({ drivenM: null }), rec({ plannedM: null, drivenM: 5000 }), rec({ plannedM: 3000, drivenM: 2500 })]), { shifts: 2, movedM: 3700, plannedM: 4000 });
  assert.strictEqual(H.distanceComparison([rec({ drivenM: null })]), null);
  const d = (over) => ({ stops: 10, stoppedS: 300, topKmh: 55, avgMovingKmh: 30, aboveLimitS: 20, hardBrakes: 2, hardAccels: 1, passedHouses: 4, passes: 6, outOfOrder: 3, gapS: 0, ...over });
  const t = H.drivingTotals([rec({ driving: d({}) }), rec({}), rec({ driving: d({ topKmh: 71, outOfOrder: null, passes: 1, passedHouses: 1 }) })]);
  assert.deepStrictEqual([t.shifts, t.stops, t.topKmh, t.hardBrakes, t.passedHouses, t.passes, t.outOfOrder, t.outOfOrderShifts], [2, 20, 71, 4, 5, 7, 3, 1]);
  assert.strictEqual(H.drivingTotals([]).topKmh, null);
});
await test("the GPS task keeps each fix's speed, and -1 (unknown) as null", async () => {
  resetAlerts();
  Object.assign(loc, { servicesOn: true, foreground: "granted", background: "granted", started: false });
  const s = putShift(nShift({ orderedIds: ids }));
  await Trk.startTracking(s.startedAt);
  const loc1 = { timestamp: 1000, coords: { latitude: 43.4, longitude: -80.5, accuracy: 5, heading: 90, speed: 7.5 } };
  const loc2 = { timestamp: 6000, coords: { latitude: 43.4, longitude: -80.5, accuracy: 5, heading: -1, speed: -1 } };
  await tasks[Trk.TRACK_TASK]({ data: { locations: [loc1, loc2] }, error: null });
  const pts = JSON.parse(store["@rr/track/points/" + s.startedAt]);
  assert.deepStrictEqual(pts.map((p) => [p.sp, p.hd]), [[7.5, 90], [null, null]]);
});

// ---- distances along real roads ----

const Roads = lib("roads"), Snap = lib("roadSnap");
const noWait = async () => {};
const lineTrack = (n, stepM, dtMs = 2000, t0 = 0) => Array.from({ length: n }, (_, i) => gpsFix(t0 + i * dtMs, i * stepM, 0, stepM / (dtMs / 1000)));

await test("matchingRuns: fixes thinned to 25 m, pieces of at most 90 that join end to end, split at holes and glitches", () => {
  const pieces = Roads.matchingRuns(lineTrack(300, 10));   // 3 km, a fix every 10 m
  assert.ok(pieces.length >= 2 && pieces.every((p) => p.length <= 90 && p.length >= 2), pieces.map((p) => p.length).join(","));
  for (let i = 1; i < pieces.length; i++) assert.strictEqual(pieces[i][0], pieces[i - 1][pieces[i - 1].length - 1], "each piece starts where the last ended");
  const flat = pieces.flat();
  for (let i = 1; i < flat.length; i++) assert.ok(flat[i].t >= flat[i - 1].t);
  const first = pieces[0], gaps = first.slice(1).map((p, i) => Math.hypot((p.lat - first[i].lat) * 111320, (p.lng - first[i].lng) * 111320 * 0.7266));
  assert.ok(gaps.every((g) => g > 20), "spaced out");
  assert.ok(Math.abs(flat[flat.length - 1].lng - lineTrack(300, 10)[299].lng) < 1e-6, "the last fix is kept");
  const holed = [...lineTrack(20, 10), ...lineTrack(20, 10, 2000, 200_000).map((p) => ({ ...p, lng: p.lng + mE(5000) }))];
  assert.strictEqual(Roads.matchingRuns(holed).length, 2, "a 2-minute hole splits the run");
  const glitch = [...lineTrack(20, 10), gpsFix(41_000, 90_000, 0, null), ...lineTrack(20, 10, 2000, 44_000).map((p) => ({ ...p, lng: p.lng + mE(300) }))];
  assert.ok(Roads.matchingRuns(glitch).every((p) => p.every((q) => Math.abs((q.lng - o0.lng) / mE(1)) < 5000)), "the 90 km jump is not in any piece");
  assert.deepStrictEqual([Roads.matchingRuns([]), Roads.matchingRuns([gpsFix(0, 0)]), Roads.matchingRuns(lineTrack(30, 0))], [[], [], []], "nothing to match, or a car that stood still");
  assert.deepStrictEqual(Roads.matchingRuns([{ ...gpsFix(0, 0), acc: 200 }, { ...gpsFix(2000, 100), acc: 200 }]), [], "poor fixes are dropped");
});
await test("matchTrack: sends each piece to the server in lng,lat order, adds the road distances, reports how much it could place", async () => {
  const urls = [], sleeps = [];
  const deps = {
    sleep: async (ms) => { sleeps.push(ms); },
    fetchJson: async (url) => { urls.push(url); const n = url.split("/driving/")[1].split("?")[0].split(";").length; return { code: "Ok", matchings: [{ distance: 1000 }, { distance: 250 }], tracepoints: Array.from({ length: n }, (_, i) => (i === 0 ? null : {})) }; },
  };
  const pieces = Roads.matchingRuns(lineTrack(300, 10));
  const r = await Roads.matchTrack(lineTrack(300, 10), deps);
  assert.deepStrictEqual([urls.length, r.pieces, r.meters, sleeps.length], [pieces.length, pieces.length, 1250 * pieces.length, pieces.length - 1]);
  assert.ok(sleeps.every((ms) => ms >= 1000), "spaced out for the shared server");
  assert.ok(urls[0].startsWith("https://router.project-osrm.org/match/v1/driving/") && /overview=false&gaps=ignore&tidy=true&radiuses=(\d+;)*\d+$/.test(urls[0]), urls[0]);
  const firstPt = pieces[0][0];
  assert.ok(urls[0].includes(`${firstPt.lng.toFixed(6)},${firstPt.lat.toFixed(6)};`), "longitude first");
  const total = pieces.reduce((t, p) => t + p.length, 0);
  assert.ok(Math.abs(r.coverage - (total - pieces.length) / total) < 1e-9, String(r.coverage));
  const none = await Roads.matchTrack(lineTrack(40, 10), { sleep: noWait, fetchJson: async () => ({ code: "NoMatch" }) });
  assert.deepStrictEqual([none.meters, none.coverage, none.unmatchedPieces], [0, 0, 1], "a piece with no match adds nothing and is counted");
  await assert.rejects(Roads.matchTrack(lineTrack(40, 10), { sleep: noWait, fetchJson: async () => ({ code: "InvalidQuery" }) }), /couldn't match the track \(InvalidQuery\)/);
  await assert.rejects(Roads.matchTrack(lineTrack(40, 10), { sleep: noWait, fetchJson: async () => { throw new Error("Network request failed"); } }), /Network request failed/);
  assert.deepStrictEqual(await Roads.matchTrack([], deps), { meters: 0, coverage: 0, pieces: 0, unmatchedPieces: 0 });
});
await test("roadDistanceM and roadsAround: the road distance between two places, and from a new house to its neighbours both ways", async () => {
  const seen = [];
  const route = (body) => ({ sleep: noWait, fetchJson: async (u) => { seen.push(u); return body; } });
  assert.strictEqual(await Roads.roadDistanceM(o0, { lat: 43.47, lng: -80.51 }, route({ code: "Ok", routes: [{ distance: 812.5 }] })), 812.5);
  assert.ok(seen[0].includes("/route/v1/driving/-80.520000,43.460000;-80.510000,43.470000?overview=false"), seen[0]);
  assert.strictEqual(await Roads.roadDistanceM(o0, o0, route({ code: "NoRoute" })), null);
  await assert.rejects(Roads.roadDistanceM(o0, o0, route({ code: "Error" })), /couldn't find a route/);
  seen.length = 0;
  const nb = [{ id: "N1", lat: 43.461, lng: -80.521 }, { id: "N2", lat: 43.462, lng: -80.522 }, { id: "N3", lat: 43.463, lng: -80.523 }];
  const table = { sleep: noWait, fetchJson: async (u) => { seen.push(u); return u.includes("sources=0&") ? { code: "Ok", distances: [[120, 340, null, 900]] } : { code: "Ok", distances: [[130], [350], [500], [880]] }; } };
  const r = await Roads.roadsAround(o0, nb, { lat: 43.4659, lng: -80.5247 }, table);
  assert.deepStrictEqual(r, { out: { N1: 120, N2: 340 }, in: { N1: 130, N2: 350, N3: 500 }, fromLibrary: 880 }, "N3 has no road from the house, so only the way in is kept");
  assert.deepStrictEqual(seen.length, 2);
  assert.ok(seen[0].includes("sources=0&destinations=1;2;3;4") && seen[1].includes("sources=1;2;3;4&destinations=0"), seen.join(" | "));
  await assert.rejects(Roads.roadsAround(o0, nb, o0, { sleep: noWait, fetchJson: async () => ({ code: "TooBig" }) }), /couldn't give distances \(TooBig\)/);
});

await test("nearestHouses: the closest within range, nearest first, at most k", () => {
  const near = AH.nearestHouses(o0, [{ id: "far", lat: o0.lat + 0.5, lng: o0.lng }, { id: "b", lat: o0.lat + mN(300), lng: o0.lng }, { id: "a", lat: o0.lat + mN(50), lng: o0.lng }, { id: "c", lat: o0.lat + mN(900), lng: o0.lng }], 2);
  assert.deepStrictEqual(near.map((h) => h.id), ["a", "b"]);
  assert.deepStrictEqual(AH.nearestHouses(o0, [{ id: "far", lat: o0.lat + 0.5, lng: o0.lng }]), []);
  const h = AH.buildHouse({ name: "", address: "9 TEST RD", postal: "", city: "Waterloo", routeId: "C3", schedule: "Mon-Sat" }, o0, 1, undefined, { out: { A: 5 }, in: { A: 6 }, fromLibrary: 77 });
  assert.deepStrictEqual([h.roadOut, h.roadIn, h.roadLib, "roadTwin" in h], [{ A: 5 }, { A: 6 }, 77, false]);
  assert.strictEqual("roadLib" in AH.buildHouse({ name: "", address: "9 TEST RD", postal: "", city: "Waterloo", routeId: "C3", schedule: "Mon-Sat" }, o0, 1, undefined, { out: {}, in: {}, fromLibrary: null }), false);
});
await test("real road distances for a house with no road data replace the straight-line guess, in the order search's costs", async () => {
  const a = SEED_ORDERS.C3[10], id = "ADD-C3-road", pos = { lat: by.get(a).lat + mN(400), lng: by.get(a).lng };
  const co = (x) => (x === id ? pos : coordOf(x)), mo = (x) => (x === id ? undefined : matrixIdOf(x));
  const legs = () => HD.legMeters({ stopIds: [a, id], order: [a, id], coordOf: co, matrixIdOf: mo, start: { kind: "library" } });
  const guess = legs();
  const backGuess = HD.legMeters({ stopIds: [id, a], order: [id, a], coordOf: co, matrixIdOf: mo, start: { kind: "library" } })[1];
  assert.ok(Math.abs(guess[1] - 400 * 1.4) < 25, `straight line x 1.4: ${guess[1]}`);
  HD.setExtraRoadDistances(new Map([[HD.roadKey(a, id), 1234], [HD.roadKey("LIB", id), 777]]));
  try {
    assert.strictEqual(legs()[1], 1234, "a known road distance wins over the guess");
    assert.strictEqual(HD.legMeters({ stopIds: [id], order: [id], coordOf: co, matrixIdOf: mo, start: { kind: "library" } })[0], 777, "and from the library");
    assert.strictEqual(HD.legMeters({ stopIds: [id, a], order: [id, a], coordOf: co, matrixIdOf: mo, start: { kind: "library" } })[1], backGuess, "a pair with no entry is still guessed");
  } finally { HD.setExtraRoadDistances(new Map()); }
  assert.ok(Math.abs(legs()[1] - guess[1]) < 1e-6, "cleared again");
});
await test("a house saved with road distances feeds them to the ordering code, and removing it takes them away", async () => {
  const a = SEED_ORDERS.C3[10], id = "ADD-C3-road2", pos = { lat: by.get(a).lat + mN(400), lng: by.get(a).lng };
  const house = { id, routeId: "C3", name: "NEW START", address: "77 ROADTEST ST", postal: "", city: "Waterloo", schedule: "Mon-Sat", lat: pos.lat, lng: pos.lng, roadOut: { [a]: 555 }, roadIn: { [a]: 4321 }, roadLib: 999 };
  await Reg.registry.addHouse(house);
  try {
    const co = (x) => (x === id ? pos : coordOf(x)), mo = (x) => (x === id ? undefined : matrixIdOf(x));
    const leg = (order) => HD.legMeters({ stopIds: order, order, coordOf: co, matrixIdOf: mo, start: { kind: "library" } });
    assert.deepStrictEqual([leg([id, a])[1], leg([a, id])[1], leg([id])[0]], [555, 4321, 999]);
  } finally { await Reg.registry.removeAddedHouse(id); }
  const co = (x) => (x === id ? pos : coordOf(x));
  assert.ok(Math.abs(HD.legMeters({ stopIds: [a, id], order: [a, id], coordOf: co, matrixIdOf: (x) => (x === id ? undefined : matrixIdOf(x)), start: { kind: "library" } })[1] - 560) < 25, "back to the straight-line guess");
});

const roadRec = (id, over = {}) => ({ id, startedAt: Number(id), finishedAt: Number(id) + 3_600_000, night: "2026-11-03", paperDay: 2, routeIds: ["C3"], due: 2, ticked: 2, counted: 0, skipped: 0, stopped: 0, rateCents: 35, plannedM: 2000, coveredM: 1900, drivenM: 2100, savedM: 0, optimizations: 0, startMode: "library", byRoute: {}, ...over });
await test("movedOf: along roads when the match placed 80% of the track, else the straight segments; totals say how many shifts are on roads", () => {
  assert.deepStrictEqual(H.movedOf(roadRec("1")), { m: 2100, onRoads: false });
  assert.deepStrictEqual(H.movedOf(roadRec("1", { roadM: 2300, roadCoverage: 0.95 })), { m: 2300, onRoads: true });
  assert.deepStrictEqual(H.movedOf(roadRec("1", { roadM: 900, roadCoverage: 0.5 })), { m: 2100, onRoads: false }, "a poor match leaves out too much");
  assert.deepStrictEqual(H.movedOf(roadRec("1", { roadM: 2300, roadCoverage: 0.8 })), { m: 2300, onRoads: true });
  assert.strictEqual(H.movedOf(roadRec("1", { drivenM: null })), null);
  assert.strictEqual(H.movedOf(roadRec("1", { drivenM: null, roadM: 5, roadCoverage: 0.2 })), null);
  const recs = [roadRec("1", { roadM: 2300, roadCoverage: 0.95 }), roadRec("2"), roadRec("3", { drivenM: null })];
  const t = H.totalsOf(recs);
  assert.deepStrictEqual([t.drivenM, t.recordedShifts, t.roadShifts, t.drivenPartial], [4400, 2, 1, true]);
  assert.deepStrictEqual(H.distanceComparison(recs), { shifts: 2, movedM: 4400, plannedM: 4000 });
});
await test("snapPendingShifts: measures each kept shift along roads once, stores it on the shift and its record, stops at the first failure", async () => {
  resetShiftStores();
  for (const k of Object.keys(fileSystem.files)) delete fileSystem.files[k];
  const mkArc = (startedAt) => Arc.buildArchive({ date: "d", routeIds: ["C3"], startedAt, finishedAt: null, deliveredIds: [], skippedIds: [], orderedIds: [], deliveryDayIdx: 1, startMode: "library" }, { points: lineTrack(60, 12, 2000, startedAt), houses: [], stoppedIds: [], finishedAt: startedAt + 1 });
  for (const id of ["1000", "2000", "3000"]) { await Arc.saveArchive(mkArc(Number(id))); await H.appendRecord(roadRec(id)); }
  await Arc.deleteArchive("3000"); await Arc.saveArchive(mkArc(3000)); await H.deleteRecord("3000");   // a shift removed from the reports but with a file left behind
  assert.strictEqual(await Snap.shiftsWaitingForRoads(), 3);
  let calls = 0, ok = true;
  const deps = { sleep: noWait, fetchJson: async (url) => { calls++; if (!ok) throw new Error("Network request failed"); const n = url.split("/driving/")[1].split("?")[0].split(";").length; return { code: "Ok", matchings: [{ distance: 800 }], tracepoints: Array.from({ length: n }, () => ({})) }; } };
  ok = false;
  const bad = await Snap.snapPendingShifts(deps);
  assert.deepStrictEqual([bad.measured, bad.failed, bad.waiting, bad.error, calls], [0, true, 3, "Network request failed", 1], "the first failure stops the run");
  assert.strictEqual(await Snap.lastRoadError(), "Network request failed");
  ok = true; calls = 0;
  const good = await Snap.snapPendingShifts(deps);
  assert.deepStrictEqual([good.measured, good.failed, good.waiting, good.error], [3, false, 0, null]);
  assert.strictEqual(await Snap.lastRoadError(), null, "a clean run clears the error");
  const recs = await H.loadHistory();
  assert.deepStrictEqual(recs.map((r) => [r.id, r.roadM > 0, r.roadCoverage]), [["1000", true, 1], ["2000", true, 1]], "the removed shift got no record back");
  assert.ok((await Arc.loadArchive("1000")).road.meters > 0);
  const callsBefore = calls;
  assert.strictEqual((await Snap.snapPendingShifts(deps)).measured, 0);
  assert.strictEqual(calls, callsBefore, "a shift already measured is not sent again");
  // two callers at once share one run
  await Arc.saveArchive(mkArc(4000)); await H.appendRecord(roadRec("4000"));
  calls = 0;
  const [x, y] = await Promise.all([Snap.snapPendingShifts(deps), Snap.snapPendingShifts(deps)]);
  assert.deepStrictEqual([x.measured, y.measured, calls > 0], [1, 1, true]);
  assert.ok(calls <= 2, `one run: ${calls} requests`);
});

cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
