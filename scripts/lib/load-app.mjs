// Loads the app's own TypeScript for scripts that run in Node: compiles src/ with tsc into a temp folder and
// swaps the phone's storage, location and task modules for in-memory stand-ins.
//
// const { lib, data, store, loc, tasks, cleanup } = loadApp();

import { spawnSync } from "child_process";
import fs from "fs";
import Module from "module";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

export function loadApp(extraEntries = []) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "rr-logic-"));

  // ---- compile ----

  const entries = ["lib/shift", "lib/importRoute", "lib/history", "lib/settings", "lib/schedule", "lib/headingData", "lib/headingSearch",
    "lib/mergeOrder", "lib/tracking", "lib/houseSearch", "lib/addHouse", "lib/geocode", "lib/reopen", "lib/registry", "lib/registry-core", "data/routes", "lib/alerts", "lib/nextHouse", "lib/reminders", "lib/shiftEvents", "lib/notes", "lib/navigation", "data/cut-through", "lib/matrixAlias", "data/seed-orders", "data/subscribers", "data/anchors"].map((f) => path.join(ROOT, "src", f + ".ts"));
  fs.writeFileSync(path.join(OUT, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "es2020", module: "commonjs", moduleResolution: "node", resolveJsonModule: true, esModuleInterop: true,
      skipLibCheck: true, strict: true, rootDir: ROOT, outDir: path.join(OUT, "js"), baseUrl: ROOT, paths: { "@/*": ["src/*"] },
    },
    files: entries,
  }));
  const tsc = spawnSync(process.execPath, [path.join(ROOT, "node_modules/typescript/bin/tsc"), "-p", path.join(OUT, "tsconfig.json")], { encoding: "utf8" });
  if (!fs.existsSync(path.join(OUT, "js/src/lib/shift.js"))) throw new Error("compile failed:\n" + tsc.stdout + tsc.stderr);
  if (tsc.status !== 0) console.log("note: tsc reported type errors (run `npm run typecheck`):\n" + tsc.stdout.slice(0, 600));

  // ---- stand-ins for the phone's modules ----

  const store = {};
  const asyncStorage = {
    getItem: async (k) => (k in store ? store[k] : null),
    setItem: async (k, v) => { store[k] = v; },
    removeItem: async (k) => { delete store[k]; },
    getAllKeys: async () => Object.keys(store),
  };
  // location: what the phone says, and a record of what the app asked it to do
  const loc = {
    servicesOn: true, foreground: "granted", background: "granted", started: false, startedWith: null, startCalls: 0, stopCalls: 0,
    Accuracy: { High: 4 },
    hasServicesEnabledAsync: async () => loc.servicesOn,
    requestForegroundPermissionsAsync: async () => ({ status: loc.foreground }),
    requestBackgroundPermissionsAsync: async () => ({ status: loc.background }),
    hasStartedLocationUpdatesAsync: async () => loc.started,
    startLocationUpdatesAsync: async (name, options) => { loc.started = true; loc.startedWith = { name, options }; loc.startCalls++; },
    stopLocationUpdatesAsync: async () => { loc.started = false; loc.stopCalls++; },
  };
  const tasks = {};
  const taskManager = { defineTask: (name, fn) => { tasks[name] = fn; } };
  // notifications: what the app asked the phone to show, schedule and remove, and what the phone allows
  const notif = {
    perms: { granted: true, canAskAgain: true, allowOnRequest: true }, requests: 0, handler: null,
    channels: {}, categories: {}, scheduled: [], dismissed: [], cancelled: [], registeredTasks: [], failNext: null,
    AndroidImportance: { LOW: 2, DEFAULT: 3, HIGH: 4 },
    SchedulableTriggerInputTypes: { WEEKLY: "weekly" },
    setNotificationHandler: (h) => { notif.handler = h; },
    setNotificationChannelAsync: async (id, c) => { notif.channels[id] = c; },
    setNotificationCategoryAsync: async (id, actions) => { notif.categories[id] = actions; },
    getPermissionsAsync: async () => ({ granted: notif.perms.granted, canAskAgain: notif.perms.canAskAgain }),
    requestPermissionsAsync: async () => { notif.requests++; if (notif.perms.allowOnRequest) notif.perms.granted = true; return { granted: notif.perms.granted }; },
    scheduleNotificationAsync: async (r) => { if (notif.failNext) { const e = notif.failNext; notif.failNext = null; throw new Error(e); } notif.scheduled.push(r); return r.identifier; },
    dismissNotificationAsync: async (id) => { notif.dismissed.push(id); },
    getAllScheduledNotificationsAsync: async () => notif.scheduled.filter((r) => r.trigger && r.trigger.type === "weekly" && !notif.cancelled.includes(r.identifier)).map((r) => ({ identifier: r.identifier })),
    cancelScheduledNotificationAsync: async (id) => { notif.cancelled.push(id); },
    registerTaskAsync: async (name) => { notif.registeredTasks.push(name); return null; },
    addNotificationResponseReceivedListener: () => ({ remove() {} }),
    useLastNotificationResponse: () => null,
  };
  // react-native: only the parts the app's logic files touch
  const rn = { opened: [] };
  const reactNative = { Platform: { OS: "android" }, Linking: { canOpenURL: async () => true, openURL: async (u) => { rn.opened.push(u); } }, AppState: { addEventListener: () => ({ remove() {} }) } };
  const stubs = { "@react-native-async-storage/async-storage": asyncStorage, "expo-location": loc, "expo-task-manager": taskManager, "expo-notifications": notif, "react-native": reactNative };

  const SRC = path.join(OUT, "js/src");
  const resolveFilename = Module._resolveFilename;
  const reactPath = resolveFilename.call(Module, "react", { id: "x", filename: path.join(ROOT, "x.js"), paths: [path.join(ROOT, "node_modules")] });
  Module._resolveFilename = function (request, ...rest) {
    if (request.startsWith("@/")) request = path.join(SRC, request.slice(2));
    else if (request === "react") return reactPath;
    else if (request in stubs) return path.join(OUT, "stub_" + request.replace(/\W/g, "_") + ".cjs");
    return resolveFilename.call(this, request, ...rest);
  };
  for (const [name, impl] of Object.entries(stubs)) {   // the stand-ins have to be the live objects, so they go in the module cache
    const p = path.join(OUT, "stub_" + name.replace(/\W/g, "_") + ".cjs");
    fs.writeFileSync(p, "");
    const m = new Module(p); m.filename = p; m.loaded = true; m.exports = { __esModule: true, default: impl, ...impl };
    Module._cache[p] = m;
  }
  const require = Module.createRequire(import.meta.url);
  const lib = (n) => require(path.join(SRC, "lib", n + ".js"));
  const data = (n) => require(path.join(SRC, "data", n + ".js"));


  return { ROOT, store, loc, tasks, notif, rn, lib, data, cleanup: () => fs.rmSync(OUT, { recursive: true, force: true }) };
}
