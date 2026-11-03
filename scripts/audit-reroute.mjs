// Measures what a mid-shift "Re-route from here" does on the real roads: for a shift part way through, the order
// the driver had against the order Re-route produces, as driven (OSRM street paths), counting how often a house
// that has not been delivered yet is driven past.
//
// usage: node scripts/audit-reroute.mjs [--cuts 0.25,0.5,0.75] [--sets C3,A11,...]    (public OSRM server, cached)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadApp } from "./lib/load-app.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, ".cache");
fs.mkdirSync(CACHE, { recursive: true });
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; };
const cuts = arg("cuts", "0.25,0.5,0.75").split(",").map(Number);
const sets = arg("sets", "C3,A11,A11+A7+B21,A11+A7+B21+C13+C3").split(",");
const PASS_M = 25;   // houses sit about 18 m from the road centre, so this is "driving right by it"

const { lib, data, cleanup } = loadApp();
const Shift = lib("shift");
const { SUBSCRIBERS } = data("subscribers");
const { SEED_ORDERS } = data("seed-orders");
const { matrixIdFor } = lib("matrixAlias");
const by = new Map(SUBSCRIBERS.map((s) => [s.id, s]));
const coordOf = (id) => (by.has(id) ? { lat: by.get(id).lat, lng: by.get(id).lng } : undefined);
const matrixIdOf = (id) => (by.has(id) ? matrixIdFor(by.get(id).address, by.get(id).city) : undefined);

const cacheFile = path.join(CACHE, "reroute-legs.json");
const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// street path of every leg of [start, ...ids]
async function legsOf(start, ids) {
  const pts = [start, ...ids.map(coordOf)];
  const legs = [];
  for (let i = 0; i < pts.length - 1; i += 24) {
    const part = pts.slice(i, Math.min(i + 25, pts.length));
    const key = part.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
    if (!cache[key]) {
      for (let attempt = 0; ; attempt++) {
        let res = null;
        try { res = await fetch(`https://router.project-osrm.org/route/v1/driving/${key}?overview=false&steps=true&geometries=geojson`); } catch { /* retried below */ }
        if (res && res.ok) {
          const j = await res.json();
          if (j.code !== "Ok") throw new Error("OSRM " + j.code);
          cache[key] = j.routes[0].legs.map((l) => ({ m: l.distance, line: l.steps.flatMap((s) => s.geometry.coordinates) }));
          fs.writeFileSync(cacheFile + ".tmp", JSON.stringify(cache));
          fs.renameSync(cacheFile + ".tmp", cacheFile);
          await sleep(1100);
          break;
        }
        if (attempt >= 4) throw new Error("OSRM kept failing");
        await sleep(3000 * (attempt + 1));
      }
    }
    legs.push(...cache[key]);
  }
  return legs;
}

const KX = 111320 * Math.cos((43.45 * Math.PI) / 180), K = 111320;
function distToLine(p, line) {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const ax = line[i][0] * KX, ay = line[i][1] * K, bx = line[i + 1][0] * KX, by_ = line[i + 1][1] * K;
    const px = p.lng * KX, py = p.lat * K, dx = bx - ax, dy = by_ - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

// km driven, and how many times an undelivered house is driven past (not counting a leg's own two ends)
function measure(legs, ids) {
  let m = 0, passes = 0;
  const houses = new Set();
  legs.forEach((leg, k) => {
    m += leg.m;
    for (let j = k + 1; j < ids.length; j++) {   // ids[k] is this leg's destination; j > k are still to come
      if (j === k) continue;
      if (distToLine(coordOf(ids[j]), leg.line) <= PASS_M && !(j === k)) { passes++; houses.add(ids[j]); }
    }
  });
  return { km: m / 1000, passes, houses: houses.size };
}

console.log("set".padEnd(20), "cut".padStart(4), "left".padStart(5), "  km (had -> re-routed)    undelivered houses driven past (had -> re-routed)");
for (const set of sets) {
  const order = SEED_ORDERS[set];
  for (const f of cuts) {
    const k = Math.round(order.length * f);
    const delivered = order.slice(0, k), remaining = order.slice(k);
    const c = coordOf(delivered[k - 1]);
    const here = { lat: c.lat + 0.0003, lng: c.lng - 0.0003 };   // standing near the last house, not exactly at it
    const plan = Shift.planReroute(order, delivered, [], here, coordOf, matrixIdOf);
    const after = plan.orderedIds.slice(k);
    const a = measure(await legsOf(here, remaining), remaining), b = measure(await legsOf(here, after), after);
    const moved = after.filter((id, i) => id !== remaining[i]).length;
    console.log(set.padEnd(20), String(Math.round(f * 100) + "%").padStart(4), String(remaining.length).padStart(5),
      `  ${a.km.toFixed(2)} -> ${b.km.toFixed(2)} km`.padEnd(24), `  passes ${a.passes} -> ${b.passes}  (houses ${a.houses} -> ${b.houses}); ${moved} of ${after.length} houses changed place`);
  }
}

// You skip ahead: 8 houses from further along the order get delivered, then you re-route from where you are.
console.log("\nskipped ahead (8 houses from 60% of the way through the rest are delivered first)");
for (const set of sets) {
  const order = SEED_ORDERS[set];
  const k = Math.round(order.length * 0.25), j = k + Math.round((order.length - k) * 0.6);
  const delivered = [...order.slice(0, k), ...order.slice(j, j + 8)];
  const done = new Set(delivered);
  const remaining = order.filter((id) => !done.has(id));
  const c = coordOf(delivered[delivered.length - 1]);
  const here = { lat: c.lat + 0.0003, lng: c.lng - 0.0003 };
  const orderedIds = [...delivered, ...remaining];
  const plan = Shift.planReroute(orderedIds, delivered, [], here, coordOf, matrixIdOf);
  const after = plan.orderedIds.slice(delivered.length);
  const a = measure(await legsOf(here, remaining), remaining), b = measure(await legsOf(here, after), after);
  const moved = after.filter((id, i) => id !== remaining[i]).length;
  console.log(set.padEnd(20), "      ", String(remaining.length).padStart(5),
    `  ${a.km.toFixed(2)} -> ${b.km.toFixed(2)} km`.padEnd(24), `  passes ${a.passes} -> ${b.passes}  (houses ${a.houses} -> ${b.houses}); ${moved} of ${after.length} houses changed place; the app says ${(plan.beforeM / 1000).toFixed(2)} -> ${(plan.afterM / 1000).toFixed(2)} km`);
}
cleanup();
