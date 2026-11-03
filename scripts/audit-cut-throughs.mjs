// Finds legs of the baked delivery orders that cut through parking aisles, driveways or private lanes in
// the middle of the leg, and writes them to src/data/cut-through.ts so the optimizer steers away.
//
// OSRM's car profile treats these ways as roads. When the car can't reverse at a stop, the route often
// loops through a car park to turn round, which may be gated or closed. Tracks and trails were checked
// too: none of the baked routes use one.
//
// The first and last 80 m of a leg are ignored (the stop's own driveway or lot), and so is any leg that
// starts at the library, which has to leave through its own lot whichever stop comes first.
//
// usage: node scripts/audit-cut-throughs.mjs     (OpenStreetMap + OSRM public servers, cached in scripts/.cache)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CACHE = path.join(HERE, ".cache");
fs.mkdirSync(CACHE, { recursive: true });

const END_M = 80;        // ignore this much at each end of a leg
const TOL_M = 6;         // a route point this close to a flagged way counts as on it
const MIN_M = 40;        // legs with less than this on flagged ways are left alone
const PRICE = 2;         // a cut-through costs this many times its own length extra, so it is only used when it saves more
const BBOX = "43.38,-80.62,43.54,-80.38";
const UA = "NightRoute/0.1 (demo)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const geo = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/subscribers.geocoded.json"), "utf8"));
const seedSrc = fs.readFileSync(path.join(ROOT, "src/data/seed-orders.ts"), "utf8");
const seeds = {};
for (const m of seedSrc.matchAll(/^\s{2}"([^"]+)": \[([^\]]*)\]/gm)) seeds[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
const pt = (id) => (id === "library" ? geo.library : geo.stops[id]);

// ---- the flagged ways, from OpenStreetMap ----

async function suspectWays() {
  const file = path.join(CACHE, "suspect-ways.json");
  if (!fs.existsSync(file)) {
    const restricted = "private|no|customers|delivery|destination|permit|agricultural|forestry";
    const hw = "service|unclassified|residential|living_street|tertiary|secondary|primary";
    const query = `[out:json][timeout:120];(
      way["highway"="track"](${BBOX});
      way["highway"~"^(${hw})$"]["access"~"^(${restricted})$"](${BBOX});
      way["highway"~"^(${hw})$"]["motor_vehicle"~"^(${restricted})$"](${BBOX});
      way["highway"~"^(${hw})$"]["vehicle"~"^(${restricted})$"](${BBOX});
      way["highway"~"^(service|unclassified|residential|living_street|tertiary)$"]["surface"~"^(unpaved|gravel|dirt|ground|grass|sand|mud|earth|compacted|fine_gravel|woodchips|pebblestone)$"](${BBOX});
      way["highway"="service"]["service"~"^(parking_aisle|driveway|drive-through|emergency_access)$"](${BBOX});
    );out tags geom;`;
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
    });
    if (!res.ok) throw new Error(`Overpass answered ${res.status}`);
    fs.writeFileSync(file, JSON.stringify(await res.json()));
  }
  return JSON.parse(fs.readFileSync(file, "utf8")).elements.filter((e) => e.type === "way" && e.geometry);
}

const KX = 111320 * Math.cos((43.45 * Math.PI) / 180), K = 111320, CELL = 25;
const grid = new Map();
function indexWays(ways) {
  for (const w of ways) {
    for (let i = 0; i < w.geometry.length - 1; i++) {
      const a = [w.geometry[i].lon * KX, w.geometry[i].lat * K], b = [w.geometry[i + 1].lon * KX, w.geometry[i + 1].lat * K];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
      for (let s = 0; s <= n; s++) {
        const x = a[0] + ((b[0] - a[0]) * s) / n, y = a[1] + ((b[1] - a[1]) * s) / n;
        const k = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push([x, y]);
      }
    }
  }
}
function onFlaggedWay(x, y) {
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    for (const [px, py] of grid.get(`${Math.floor(x / CELL) + dx},${Math.floor(y / CELL) + dy}`) || []) if (Math.hypot(px - x, py - y) < TOL_M) return true;
  }
  return false;
}
// metres of a route that lie on flagged ways, ignoring the stretch at each end
function midOverlap(line) {
  const lens = [0];
  for (let i = 0; i < line.length - 1; i++) lens.push(lens[i] + Math.hypot((line[i + 1][0] - line[i][0]) * KX, (line[i + 1][1] - line[i][1]) * K));
  const full = lens[lens.length - 1];
  let on = 0;
  for (let i = 0; i < line.length - 1; i++) {
    if (lens[i] < END_M || lens[i + 1] > full - END_M) continue;
    const len = lens[i + 1] - lens[i], n = Math.max(1, Math.ceil(len / 5));
    for (let s = 0; s < n; s++) {
      if (onFlaggedWay((line[i][0] + ((line[i + 1][0] - line[i][0]) * (s + 0.5)) / n) * KX, (line[i][1] + ((line[i + 1][1] - line[i][1]) * (s + 0.5)) / n) * K)) on += len / n;
    }
  }
  return on;
}

// ---- the real routes, from OSRM ----

const legsFile = path.join(CACHE, "route-legs.json");
const legsCache = fs.existsSync(legsFile) ? JSON.parse(fs.readFileSync(legsFile, "utf8")) : {};
async function routeLegs(ids) {   // consecutive legs of an order, plain OSRM /route, 25 stops a request
  const out = [];
  for (let i = 0; i < ids.length - 1; i += 24) {
    const part = ids.slice(i, Math.min(i + 25, ids.length));
    const key = part.join(">");
    if (!legsCache[key]) {
      const coords = part.map((id) => `${pt(id).lng},${pt(id).lat}`).join(";");
      for (let attempt = 0; ; attempt++) {
        let res;
        try { res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=false&steps=true&geometries=geojson`); } catch (e) { res = null; }
        if (res && res.ok) {
          const j = await res.json();
          if (j.code !== "Ok") throw new Error("OSRM " + j.code);
          legsCache[key] = j.routes[0].legs.map((l) => ({ m: l.distance, line: l.steps.flatMap((s) => s.geometry.coordinates) }));
          fs.writeFileSync(legsFile + ".tmp", JSON.stringify(legsCache));
          fs.renameSync(legsFile + ".tmp", legsFile);
          await sleep(1100);
          break;
        }
        if (attempt >= 4) throw new Error("OSRM kept failing for " + key.slice(0, 60));
        await sleep(3000 * (attempt + 1));
      }
    }
    out.push(...legsCache[key]);
  }
  return out;
}

// ---- scan ----

indexWays(await suspectWays());
// Pairs found earlier stay on the list: a re-baked order avoids them, but the phone's search could still pick them.
const dataFile = path.join(ROOT, "src/data/cut-through.ts");
const known = new Map();
if (fs.existsSync(dataFile)) {
  for (const m of fs.readFileSync(dataFile, "utf8").matchAll(/\["([^"]+)", "([^"]+)", (\d+)\]/g)) known.set(`${m[1]}|${m[2]}`, +m[3] / PRICE);
}
const pairs = new Map();
let legsChecked = 0, metres = 0;
for (const [set, order] of Object.entries(seeds)) {
  const ids = ["library", ...order];
  const legs = await routeLegs(ids);
  legs.forEach((leg, k) => {
    legsChecked++; metres += leg.m;
    if (k === 0) return;                    // leaving the library: unavoidable
    const on = midOverlap(leg.line);
    if (on < MIN_M) return;
    const [a, b] = [ids[k], ids[k + 1]].sort();
    const key = `${a}|${b}`;
    pairs.set(key, Math.max(pairs.get(key) ?? 0, Math.round(on)));
  });
  console.log(`${set}: ${pairs.size} flagged pairs so far`);
}
const fresh = [...pairs.keys()].filter((k) => !known.has(k));
for (const [k, on] of known) pairs.set(k, Math.max(pairs.get(k) ?? 0, on));
const list = [...pairs.entries()].map(([k, on]) => [...k.split("|"), on]).sort((x, y) => y[2] - x[2]);
const rows = list.map(([a, b, on]) => `  ["${a}", "${b}", ${on * PRICE}],`).join("\n");
fs.writeFileSync(path.join(ROOT, "src/data/cut-through.ts"), `// Generated by scripts/audit-cut-throughs.mjs. Do not edit.
//
// Pairs of houses whose driving leg runs through a parking aisle, driveway or private lane in the middle of
// the leg. OSRM counts those as roads, but they can be gated or closed and a car that can't reverse at a stop
// often loops through a car park to turn round. Each entry is [house, house, penalty in metres] (twice the
// length of the cut-through, either direction). The order search adds the penalty when it uses the pair.

export const CUT_THROUGH: readonly (readonly [string, string, number])[] = [
${rows}
];
`);
console.log(`\n${legsChecked} legs (${(metres / 1000).toFixed(0)} km) in ${Object.keys(seeds).length} orders; ${fresh.length} new pairs cut through for 40 m or more, ${list.length} on the list; wrote src/data/cut-through.ts`);
for (const [a, b, on] of list.slice(0, 12)) console.log(`  ${a} <-> ${b}: ${on} m`);
