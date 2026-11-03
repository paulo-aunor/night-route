// Bakes delivery orders that account for which way the car is facing.
//
// The old seeds minimised the OSRM /table distance, which lets the car reverse for free at every stop.
// A real drive can't: after delivering a house you carry on in the direction you were going, so
// "across the street, behind you" costs a loop round the block. On C3 that was 12 houses driven past
// three or more times. Here every stop has two states (the two directions of travel along its road),
// distances come from /table with a bearing on each end, and the search picks the order that is short
// when each leg takes the shortest way from the direction the car is facing.
//
// usage:
//   node scripts/bake-heading-seeds.mjs fetch                       road directions + distances for every house (public OSRM, ~10 min, cached)
//   node scripts/bake-heading-seeds.mjs solve A7 C3+C13 [options]   optimise route sets, check each against OSRM /route
//   node scripts/bake-heading-seeds.mjs solve all-sets [options]    all 31 combinations of the five routes
//   node scripts/bake-heading-seeds.mjs write                       rewrite src/data/seed-orders.ts from scripts/heading-seeds/*.json
// solve options: --seconds N (search time per start, default 60)  --starts N (independent searches, default 3)
//                --calibrate N (rounds of correcting pairs the model got wrong against /route, default 2)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CACHE = path.join(HERE, ".cache");
const OUT_DIR = path.join(HERE, "heading-seeds");
const OSRM = "https://router.project-osrm.org";
const RANGE = 35;          // degrees either side of a stop's road direction
const SNAP_SLACK_M = 20;   // a direction whose road is this much farther than the nearest road doesn't exist here (one-way)
const BLOCK = 50;

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------------------------------------------------------------- the model and search (shared with the app)

// src/lib/headingSearch.ts has no imports, so it is compiled on the fly and the app and this tool run the same code.
const searchSource = fs.readFileSync(path.join(ROOT, "src/lib/headingSearch.ts"), "utf8");
const searchJs = ts.transpileModule(searchSource, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { search, legsGreedy } = await import("data:text/javascript;base64," + Buffer.from(searchJs).toString("base64"));

// ---------------------------------------------------------------- data

const geo = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/subscribers.geocoded.json"), "utf8"));
const subsSrc = fs.readFileSync(path.join(ROOT, "src/data/subscribers.ts"), "utf8");
const SUBS = [...subsSrc.matchAll(/\{ id: "([^"]+)", routeId: "([^"]+)", name: "[^"]*", address: "([^"]+)"/g)].map((m) => ({
  id: m[1], routeId: m[2], address: m[3].replace(/\s+/g, " ").trim().toUpperCase(),
}));
if (SUBS.length === 0) throw new Error("no subscribers parsed from src/data/subscribers.ts");
for (const s of SUBS) {
  const c = geo.stops[s.id];
  if (!c) throw new Error(`no coordinates for ${s.id}`);
  s.lat = c.lat; s.lng = c.lng;
}
const IDS = SUBS.map((s) => s.id);
const N = IDS.length;
const IDX = new Map(IDS.map((id, k) => [id, k]));
const LIB = { lat: geo.library.lat, lng: geo.library.lng };
const ROUTE_IDS = [...new Set(SUBS.map((s) => s.routeId))].sort();

const anchorsSrc = fs.readFileSync(path.join(ROOT, "src/data/anchors.ts"), "utf8");
const ROUTE_ANCHORS = {};
for (const m of anchorsSrc.matchAll(/^\s{2}(\w+): \[([^\]]*)\]/gm)) {
  ROUTE_ANCHORS[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}
function anchorsFor(routes) {
  const out = [];
  for (const r of routes) for (const addr of ROUTE_ANCHORS[r] ?? []) {
    const hit = SUBS.find((s) => s.routeId === r && s.address === addr);
    if (hit) out.push(IDX.get(hit.id));
  }
  return out;
}

// Pairs whose route cuts through a car park or private lane (src/data/cut-through.ts, written by
// scripts/audit-cut-throughs.mjs), as a per-pair penalty in metres, either direction.
function cutThroughPenalties() {
  const file = path.join(ROOT, "src/data/cut-through.ts");
  if (!fs.existsSync(file)) throw new Error("src/data/cut-through.ts is missing; run `node scripts/audit-cut-throughs.mjs` first");
  const pen = new Float32Array(N * N);
  for (const m of fs.readFileSync(file, "utf8").matchAll(/\["([^"]+)", "([^"]+)", (\d+)\]/g)) {
    const a = IDX.get(m[1]), b = IDX.get(m[2]);
    if (a === undefined || b === undefined) throw new Error(`cut-through.ts names an unknown house: ${m[1]} or ${m[2]}`);
    pen[a * N + b] = Math.max(pen[a * N + b], +m[3]);
    pen[b * N + a] = Math.max(pen[b * N + a], +m[3]);
  }
  return pen;
}

function readSeeds() {
  const src = fs.readFileSync(path.join(ROOT, "src/data/seed-orders.ts"), "utf8");
  const seeds = {};
  for (const m of src.matchAll(/^\s{2}"([^"]+)": \[([^\]]*)\]/gm)) seeds[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  return seeds;
}

// ---------------------------------------------------------------- OSRM

let lastCall = 0;
async function osrm(pathAndQuery) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = 1100 - (Date.now() - lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    let res;
    try {
      res = await fetch(OSRM + pathAndQuery);
    } catch (e) {
      lastError = e;   // a dropped connection; retried, and raised if it keeps happening
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      continue;
    }
    if (res.ok) {
      const j = await res.json();
      if (j.code !== "Ok") throw new Error(`OSRM ${j.code}: ${j.message ?? ""} (${pathAndQuery.slice(0, 120)})`);
      return j;
    }
    if (res.status === 400) throw new Error(`OSRM 400 for ${pathAndQuery.slice(0, 160)}`);
    lastError = new Error(`OSRM answered ${res.status}`);
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  throw new Error(`OSRM kept failing for ${pathAndQuery.slice(0, 120)}: ${lastError?.cause?.code ?? lastError?.message}`);
}

function jsonCache(name) {
  const file = path.join(CACHE, name);
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  // several solves can share one cache file, so write a temp file and rename it into place
  return {
    data,
    save: () => {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    },
  };
}

const pt = (k) => (k === -1 ? LIB : SUBS[k]);
const lonlat = (k) => `${pt(k).lng},${pt(k).lat}`;

// ---------------------------------------------------------------- fetch

const KX = Math.cos((43.45 * Math.PI) / 180);

// Road direction at each house: the first ~15 m of the route from the house to the library.
async function fetchAxes() {
  const c = jsonCache("axes.json");
  let n = 0;
  for (const s of SUBS) {
    if (c.data[s.id]) continue;
    const j = await osrm(`/route/v1/driving/${s.lng},${s.lat};${LIB.lng},${LIB.lat}?overview=false&steps=true&geometries=geojson`);
    const line = j.routes[0].legs[0].steps.flatMap((st) => st.geometry.coordinates);
    let p = line[line.length - 1];
    for (const q of line.slice(1)) {
      if (Math.hypot((q[0] - line[0][0]) * KX * 111320, (q[1] - line[0][1]) * 111320) >= 15) { p = q; break; }
    }
    const dx = (p[0] - line[0][0]) * KX, dy = p[1] - line[0][1];
    c.data[s.id] = (Math.atan2(dx, dy) * 180) / Math.PI;
    if (++n % 25 === 0) { c.save(); console.log(`  road directions ${n}`); }
  }
  c.save();
  return c.data;
}

const bearingOf = (axes, k, state) => Math.round((((axes[IDS[k]] + (state ? 180 : 0)) % 360) + 360) % 360);

async function fetchMatrices() {
  const axes = await fetchAxes();
  const c = jsonCache("table-blocks.json");

  // how far each house is from its nearest road (any direction)
  const snap = new Float64Array(N);
  for (let i = 0; i < N; i += 99) {
    const part = Array.from({ length: Math.min(99, N - i) }, (_, k) => i + k);
    const key = `snap|${i}`;
    if (!c.data[key]) {
      const j = await osrm(`/table/v1/driving/${part.map(lonlat).join(";")}?annotations=distance&sources=0`);
      c.data[key] = j.destinations.map((d) => d.distance);
      c.save();
    }
    part.forEach((k, a) => (snap[k] = c.data[key][a]));
  }

  const C = [0, 1, 2, 3].map(() => new Float32Array(N * N));   // index s*2+t: leave in state s, arrive in state t
  const Lib = [new Float32Array(N), new Float32Array(N)];       // library -> house, arriving in state t
  const missing = Array.from({ length: N }, () => [false, false]);

  for (let i0 = 0; i0 < N; i0 += BLOCK) {
    for (let j0 = 0; j0 < N; j0 += BLOCK) {
      const S = Array.from({ length: Math.min(BLOCK, N - i0) }, (_, k) => i0 + k);
      const D = Array.from({ length: Math.min(BLOCK, N - j0) }, (_, k) => j0 + k);
      for (let s = 0; s < 2; s++) for (let t = 0; t < 2; t++) {
        const key = `${s}${t}|${i0}|${j0}`;
        if (!c.data[key]) {
          const bearings = [...S.map((k) => `${bearingOf(axes, k, s)},${RANGE}`), ...D.map((k) => `${bearingOf(axes, k, t)},${RANGE}`)].join(";");
          const j = await osrm(
            `/table/v1/driving/${[...S, ...D].map(lonlat).join(";")}?annotations=distance` +
            `&sources=${S.map((_, k) => k).join(";")}&destinations=${D.map((_, k) => S.length + k).join(";")}&bearings=${bearings}`,
          );
          c.data[key] = { d: j.distances, sd: j.sources.map((x) => x.distance), dd: j.destinations.map((x) => x.distance) };
          c.save();
          console.log(`  block ${key}`);
        }
        const r = c.data[key];
        S.forEach((k, a) => { if (r.sd[a] > snap[k] + SNAP_SLACK_M) missing[k][s] = true; });
        D.forEach((k, b) => { if (r.dd[b] > snap[k] + SNAP_SLACK_M) missing[k][t] = true; });
        for (let a = 0; a < S.length; a++) for (let b = 0; b < D.length; b++) {
          C[s * 2 + t][S[a] * N + D[b]] = r.d[a][b] === null ? Infinity : r.d[a][b];
        }
      }
    }
  }
  for (let j0 = 0; j0 < N; j0 += 99) {
    const D = Array.from({ length: Math.min(99, N - j0) }, (_, k) => j0 + k);
    for (let t = 0; t < 2; t++) {
      const key = `lib|${t}|${j0}`;
      if (!c.data[key]) {
        const j = await osrm(
          `/table/v1/driving/${[-1, ...D].map(lonlat).join(";")}?annotations=distance&sources=0&bearings=;${D.map((k) => `${bearingOf(axes, k, t)},${RANGE}`).join(";")}`,
        );
        c.data[key] = j.distances[0].slice(1);
        c.save();
      }
      D.forEach((k, b) => { Lib[t][k] = c.data[key][b] ?? Infinity; });
    }
  }
  for (let k = 0; k < N; k++) for (let st = 0; st < 2; st++) {
    if (!missing[k][st]) continue;
    Lib[st][k] = Infinity;
    for (let o = 0; o < N; o++) for (let other = 0; other < 2; other++) {
      C[st * 2 + other][k * N + o] = Infinity;   // can't leave in a direction the road doesn't allow
      C[other * 2 + st][o * N + k] = Infinity;   // can't arrive that way either
    }
  }
  const oneWay = missing.filter((m) => m[0] || m[1]).length;
  const file = path.join(CACHE, "heading-matrices.bin");
  const buf = Buffer.concat([...C, ...Lib].map((a) => Buffer.from(a.buffer)));
  fs.writeFileSync(file, buf);
  fs.writeFileSync(path.join(CACHE, "heading-matrices.json"), JSON.stringify({ ids: IDS, oneWay }));
  console.log(`done: ${N} houses, ${oneWay} on a road with only one usable direction`);
}

function loadMatrices() {
  const meta = JSON.parse(fs.readFileSync(path.join(CACHE, "heading-matrices.json"), "utf8"));
  if (meta.ids.length !== N || meta.ids.some((id, k) => id !== IDS[k])) {
    throw new Error("the cached distances are for a different list of houses; run `fetch` again (delete scripts/.cache first)");
  }
  const raw = fs.readFileSync(path.join(CACHE, "heading-matrices.bin"));
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const C = [0, 1, 2, 3].map((q) => f.subarray(q * N * N, (q + 1) * N * N));
  const Lib = [0, 1].map((t) => f.subarray(4 * N * N + t * N, 4 * N * N + (t + 1) * N));
  return { C, Lib };
}

// ---------------------------------------------------------------- checking against the real router

const realCache = jsonCache("real-routes.json");
// Plain OSRM /route (what a navigation app does): length of every leg, library first. Chunked to stay under the demo server's limits.
async function realLegs(order) {
  const ids = [-1, ...order];
  const legs = [];
  for (let i = 0; i < ids.length - 1; i += 99) {
    const part = ids.slice(i, Math.min(i + 100, ids.length));
    const key = part.join(">");
    if (!realCache.data[key]) {
      const j = await osrm(`/route/v1/driving/${part.map(lonlat).join(";")}?overview=false`);
      realCache.data[key] = j.routes[0].legs.map((l) => l.distance);
      realCache.save();
    }
    legs.push(...realCache.data[key]);
  }
  return legs;
}
const sum = (a) => a.reduce((t, x) => t + x, 0);

// ---------------------------------------------------------------- solve

function parseSet(arg) {
  const routes = arg.split("+").map((x) => x.trim().toUpperCase()).sort();
  for (const r of routes) if (!ROUTE_IDS.includes(r)) throw new Error(`unknown route ${r} (have ${ROUTE_IDS.join(", ")})`);
  return routes;
}

async function solveSet(routes, opts, mats) {
  const key = routes.join("+");
  const stops = SUBS.map((s, k) => (routes.includes(s.routeId) ? k : -1)).filter((k) => k >= 0);
  const stopSet = new Set(stops);
  const seeds = readSeeds();
  const full = seeds[ROUTE_IDS.join("+")];
  const baseline = (seeds[key] ?? full?.filter((id) => routes.includes(SUBS[IDX.get(id)].routeId)) ?? []).map((id) => IDX.get(id));
  if (baseline.length !== stops.length || baseline.some((k) => !stopSet.has(k))) {
    throw new Error(`${key}: no existing seed covering all ${stops.length} houses to start from`);
  }
  const fixedIds = anchorsFor(routes);
  const fixed = fixedIds.length;
  if (fixedIds.some((k, i) => baseline[i] !== k)) throw new Error(`${key}: the existing seed doesn't start with the fixed first houses`);

  const staticPen = cutThroughPenalties();
  const penaltyKm = (order) => {
    let t = 0;
    for (let i = 1; i < order.length; i++) t += staticPen[order[i - 1] * N + order[i]];
    return t / 1000;
  };
  const before = sum(await realLegs(baseline)) / 1000;
  const beforeEff = before + penaltyKm(baseline);   // distance plus what the cut-throughs it uses are charged
  console.log(`${key}: ${stops.length} houses, current seed ${before.toFixed(2)} km on the real roads, ${penaltyKm(baseline).toFixed(2)} km of cut-through penalty`);

  const pen = Float32Array.from(staticPen);
  const problem = { n: N, c: mats.C, start: mats.Lib };
  let candidates = [];
  let start = baseline;
  for (let round = 0; round <= opts.calibrate; round++) {
    for (let n = 0; n < opts.starts; n++) {
      const r = search(problem, start, { fixed, stops, ms: opts.seconds * 1000, seed: 1000 * round + n + 1, pen });
      const km = sum(await realLegs(r.order)) / 1000;
      const eff = km + penaltyKm(r.order);
      candidates.push({ order: r.order, modelKm: r.cost / 1000, realKm: km, effKm: eff, round });
      console.log(`  round ${round} search ${n + 1}: model ${(r.cost / 1000).toFixed(2)} km, real ${km.toFixed(2)} km, with cut-through penalty ${eff.toFixed(2)} km (${r.kicks} restarts)`);
    }
    const top = candidates.reduce((a, b) => (b.effKm < a.effKm ? b : a));
    if (round === opts.calibrate) break;
    // where the model said "short" and the router said "long", add the difference to that pair and search again
    const real = await realLegs(top.order);
    const model = legsGreedy(problem, top.order);
    let fixes = 0;
    for (let i = 1; i < top.order.length; i++) {
      const diff = real[i] - model[i];
      if (diff > 60) { pen[top.order[i - 1] * N + top.order[i]] += diff; fixes++; }
    }
    console.log(`  calibration: ${fixes} pairs corrected`);
    if (fixes === 0) break;
    start = top.order;
  }
  const best = candidates.reduce((a, b) => (b.effKm < a.effKm ? b : a));
  // never ship something worse than what's already there
  const keep = best.effKm < beforeEff - 0.0005 ? best : { order: baseline, realKm: before, effKm: beforeEff, modelKm: null, round: -1 };
  const file = path.join(OUT_DIR, `${key}.json`);
  const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  const result = {
    set: key,
    houses: stops.length,
    order: keep.order.map((k) => IDS[k]),
    currentKm: prior?.currentKm ?? +before.toFixed(3),   // the first baseline stays the reference through later re-bakes
    newKm: +keep.realKm.toFixed(3),
    cutThroughPenaltyKm: +penaltyKm(keep.order).toFixed(3),
    modelKm: keep.modelKm === null ? null : +keep.modelKm.toFixed(3),
    bakedOn: new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(file, JSON.stringify(result, null, 1));
  console.log(`  -> ${key}: ${before.toFixed(2)} km -> ${keep.realKm.toFixed(2)} km (${((keep.realKm / before - 1) * 100).toFixed(1)}%); cut-through penalty ${penaltyKm(baseline).toFixed(2)} km -> ${penaltyKm(keep.order).toFixed(2)} km\n`);
  return result;
}

function allSets() {
  const out = [];
  for (let mask = 1; mask < 1 << ROUTE_IDS.length; mask++) out.push(ROUTE_IDS.filter((_, i) => mask & (1 << i)));
  return out;
}

// ---------------------------------------------------------------- write

function writeSeeds() {
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error("nothing in scripts/heading-seeds/ - run `solve` first");
  const results = files.map((f) => JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8")));
  const old = readSeeds();
  const merged = { ...old };
  for (const r of results) merged[r.set] = r.order;
  const keys = Object.keys(merged).sort((a, b) => a.split("+").length - b.split("+").length || a.localeCompare(b));
  const chunk = (arr) => {
    const lines = [];
    for (let i = 0; i < arr.length; i += 7) lines.push("    " + arr.slice(i, i + 7).map((x) => `"${x}"`).join(", ") + ",");
    return lines.join("\n");
  };
  const note = (k) => {
    const r = results.find((x) => x.set === k);
    return r ? `  // ${k}: ${r.houses} houses, ${r.newKm.toFixed(2)} km on the road (was ${r.currentKm.toFixed(2)} km), direction-aware order\n` : `  // ${k}: not re-baked\n`;
  };
  const header = fs.readFileSync(path.join(ROOT, "src/data/seed-orders.ts"), "utf8").split("export const SEED_ORDERS")[0]
    .replace(/(\/\/\n)*\/\/ \d{4}-\d{2}-\d{2} direction-aware refresh:[\s\S]*$/, "")
    .replace("// Precomputed via OR-Tools GUIDED_LOCAL_SEARCH on real OSRM driving-distance matrices.", "// Precomputed by scripts/bake-heading-seeds.mjs: direction-aware orders checked against OSRM /route.")
    .replace(/(\n\/\/)+\s*$/, "")
    .trimEnd();
  const stamp = new Date().toISOString().slice(0, 10);
  const body = keys.map((k) => `${note(k)}  "${k}": [\n${chunk(merged[k])}\n  ],`).join("\n");
  const text = header + `\n//\n// ${stamp} direction-aware refresh: orders re-baked with scripts/bake-heading-seeds.mjs so the car is\n// never assumed able to reverse at a stop. Each set was checked against OSRM /route (km figures below).\n\nexport const SEED_ORDERS: Record<string, string[]> = {\n${body}\n};\n`;
  fs.writeFileSync(path.join(ROOT, "src/data/seed-orders.ts"), text);
  console.log(`wrote ${keys.length} seeds (${results.length} re-baked) to src/data/seed-orders.ts`);
}

// ---------------------------------------------------------------- main

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? +rest[i + 1] : dflt;
};
const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));

if (cmd === "fetch") {
  await fetchMatrices();
} else if (cmd === "solve") {
  const mats = loadMatrices();
  const opts = { seconds: flag("seconds", 60), starts: flag("starts", 3), calibrate: flag("calibrate", 2) };
  const sets = positional.includes("all-sets") ? allSets() : positional.map(parseSet);
  if (sets.length === 0) throw new Error("name at least one route set, e.g. `solve A7 C3+C13` or `solve all-sets`");
  for (const s of sets) await solveSet(s, opts, mats);
} else if (cmd === "write") {
  writeSeeds();
} else {
  throw new Error("usage: bake-heading-seeds.mjs fetch | solve <sets...|all-sets> [--seconds N --starts N --calibrate N] | write");
}
