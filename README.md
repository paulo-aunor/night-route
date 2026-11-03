# Night Route

An Android app that turns a newspaper-style delivery list into the shortest drive it can find, hands each stop to Google Maps for turn-by-turn, keeps a checklist, records what you delivered and how far you drove, and works out what you earned.

**This is the public demo build.** It is the same code as the private app, running on synthetic data: 346 invented houses on five invented routes, on real streets in Guelph, Ontario, with invented names and house numbers, and a public landmark (Guelph City Hall) as the depot. No real customer, address, route or publication appears anywhere in this repository. Distances and the sample figures in this repo come from this synthetic data, so they are not the figures from the private app's real routes.

Built by one developer for one phone. No backend, no login, no sync: everything is stored on the device.

## What it does

**Routes.** Five built-in routes: B21, C3, C13, A7, A11 (346 houses, in `src/data/subscribers.ts`). The depot is Guelph City Hall, 1 Carden St. C13's first nine houses are always delivered first (`src/data/anchors.ts`). Routes can be hidden, activated, deleted and restored from the Routes screen (`app/routes.tsx`).

**Nights and paper days.** The week runs Sunday night to Friday night. Sunday night delivers Monday's paper, Monday night delivers Tuesday's, and so on up to Friday night for Saturday's paper. The night chips on the home screen show the paper day. Logic is in `src/lib/schedule.ts`.

**Ordering.** Every selection of routes has a pre-computed order, and the same optimizer runs on the phone for anything that has no stored order (GPS start, Re-route from here, imports).
- The model is direction-aware. Each house has two states, one per direction of travel along its road, because a car cannot reverse at a stop. The older distance-matrix approach let the car reverse for free, which is what sent the route past the same house three times.
- Distances come from OSRM. The search is 2-opt, or-opt and iterated local search (`src/lib/headingSearch.ts`, `src/lib/headingData.ts`).
- A list of 55 house pairs whose shortest road cuts through a car park, driveway or private lane is penalised so the order avoids them (`src/data/cut-through.ts`).
- Measured savings are not quoted here: the figures from the private build were taken on real routes, not on this synthetic data.

**Shift screen** (`app/shift.tsx`).
- Next-stop card and an ordered checklist. Tap an address to open Google Maps in driving mode. Tick a house to mark it delivered.
- Drag the handle (or long-press a row) to reorder by hand. The order is remembered for the next shift on the same routes.
- Notes per house (the pencil button), merged with the depot's own delivery instructions from the PDFs.
- Stop a house (paper not delivered). Stopped houses are skipped on every shift until you un-stop them; they are listed on the Stopped screen (`app/paused.tsx`). You can also stop or resume any house from **Search houses** on the home screen, without starting a shift.
- **Add a house** (new start) at the bottom of the screen adds it to the stops you have left (see below).
- **Re-route from here** re-plans the houses left from your current position. It keeps your order unless a different one saves at least 150 m and 3%, so it will not shuffle a good order. It shows the distance and about-minutes saved, at an assumed 24 km/h.
- **Shift done** saves the shift to history. Houses ticked after the fact are counted at the end. If it was tapped by mistake, the home screen offers **Reopen the shift** for the next 12 hours (see below).
- Screen stays awake while the shift is open.

**Search, new starts, and undo.**
- **Search houses** (`app/search.tsx`): type part of an address, name or postal code; any house on any route can be stopped or resumed from the result, with no shift started.
- **Add a house** (`app/add-house.tsx`, also a button on the shift screen): route, address, city, optional postal code and name, and whether it gets paper every day or Fri and Sat only. The address is looked up on Nominatim and the matched place is shown for you to check before the house is saved. Google Maps is sent the address you typed. The house is stored with the registry (`added` in `@rr/registry/v1`), not in the route list files.
  - At the start of a shift, a house that neither the saved order nor the baked seed knows is slotted in where it adds the least driving (C13's first nine stay first). During a shift it is slotted into the stops left, from the last house delivered.
  - To place it, the house borrows the road data of the nearest house within 80 m (`roadTwin`) and is ordered as that house's neighbour. Further than 80 m from any house it has only a straight-line estimate and can land away from its real neighbours; drag it into place.
  - Houses added by hand can be removed from Search houses (not while a shift is open). Importing a route from a PDF replaces them: if the PDF lists the house it stays, if not, Update mode shows it in the removed list.
- **Remove from reports** (Earnings, on each recorded shift): for a shift started by mistake. It stops counting in every total and cannot be brought back.
- **Reopen the shift**: the latest ended shift is kept (its state and GPS points) for 12 hours. The home screen offers to put it back as tonight's shift and takes it out of the reports; ending it again records it once. Only the latest shift can be reopened.

**Notifications** (`src/lib/alerts.ts`, screen `app/reminders.tsx`). Android only, all local: nothing is sent to a server.
- **Next house, with buttons.** While a shift is open, one ongoing notification shows the next house (address, name, notes, how many are left) with **Delivered** and **Navigate** buttons. Delivered ticks the house exactly as ticking it in the app does, saves it, and moves the notification to the next house. It works with Night Route closed: the library hands the press to a background task (Android only). Navigate opens the app and then Google Maps for that house.
- **Near the next house.** Each GPS fix is checked against the next house. When the car comes within 100 m of it from further away, an alert pops (once per house) with the same buttons. A next house that is already close when it becomes next does not alert, so a street of doors gives one alert on arrival. It needs the GPS recording on.
- **Nightly reminder.** Weekly notifications on the nights you pick, at a time from 12:00 to 23:59 (the evening of that night), saying which paper is tonight. Set on the Notifications screen from the home screen.
- The first shift asks for the notification permission. If it is refused, or the background handler fails, the shift screen says so under the header and tapping the line tries again.
- A house ticked from a notification changes the saved shift behind the screen; the screen reloads it when the app comes back to the front, so its next save does not put the old copy back.

**GPS recording.** When a shift starts, the app records your position in a background task with an Android foreground service, so it keeps working while Google Maps is on screen. This needs location set to "Allow all the time". The recorded distance is movement, so it includes walking to doors and the drive home. If permission is refused, the shift screen says so and you can retry from there.

**Importing a route** (`app/import.tsx`). Pick a route PDF from the depot. The app parses it on the device (`src/lib/pdfRouteList.ts`), geocodes new addresses with Nominatim at one request a second (already-known addresses are reused), and orders the houses.
- **Update** mode is for a full new PDF of a route you already have: existing houses keep their order, new houses are inserted at the cheapest place, dropped houses are removed, and you confirm the added and removed lists first. Stopped houses and notes carry over.
- **Replace** builds the route from scratch.
- It shows the route distance before and after.

**Earnings and reports** (`app/earnings.tsx`). Pay is a flat rate per house delivered (default $0.35, editable on the screen; the rate in force is saved on each shift so old shifts do not change when you change it). Two tabs, Tonight and This week, each with:
- pay, houses delivered, stopped, time, houses per hour, earnings per hour;
- distance covered along the delivered houses, planned distance, distance saved by optimizing, km per house;
- the same figures per route, for every night and for the week; the week tab also steps back through earlier weeks and compares with the week before.

Time and distance for each leg are credited to the route of the house the leg ends at. A shift where you did not tick houses as you went has no per-route timing, and shifts saved before per-route timing was added have none either.

## Status

Logic is tested on the laptop. These have **not** been confirmed on the phone yet: background GPS recording and its permission prompts, the Earnings screen layout, the facing-based start used by Re-route, per-route timing, the new Search houses, Add a house, Remove from reports and Reopen screens, and all of the notifications (their logic is tested, their rendering and the phone's behaviour are not).

Known limits:
- The direction a car faces after a house is inferred from the order you ticked houses in. GPS heading is not used.
- A house at an intersection can be approached from more than two directions, so a few repeat passes remain.
- The cut-through list comes from OpenStreetMap tags and only covers pairs that turned up in an audit. A new one on the road can still be missed.
- Minutes saved are an estimate (24 km/h), not measured.
- The order model has no notion of which side of the car a house is on. On the private build's real routes roughly half the undelivered houses the car drives within 25 m of are on the passenger side. That is only a missed delivery if papers go out of the passenger window; they can go out of either side, or by a short walk, so it is not modelled. Pricing a short walk between nearby houses was tried and changed no order, because 20 seconds on foot costs about as much as 130 m of driving.
- Re-route was checked against real street paths (`scripts/audit-reroute.mjs`). A repair step that moved single houses the model said were out of place (up to 274 m) gave identical real distance on one route and 0.17 km more on another, so it was not kept: the model is only good to a few percent, and gains of a few hundred metres are inside that. A cause for repeat passes after Re-route that has not been ruled out: the direction the car faces is inferred from the order houses were ticked, not from GPS heading.
- Notification buttons: Android restricts starting an app from the background, so Navigate opens Night Route first and Maps from there. Delivered pressed with the app closed relies on the notification library's background task; it is tested with a stand-in for the library and has not been tried on a phone.
- Directions still need signal for Google Maps' live routing. The checklist, orders and reports work offline.
- There is no skip button on the shift screen, so the "skipped" figure on the reports is always 0. Use Stop for a house that gets no paper.

## Running it

```bash
cd night-route
npm install
npm start
```

Background GPS recording and the foreground service need a real build, so the app is meant to be installed as an APK rather than opened in Expo Go. Expo Go is fine for the checklist and ordering screens; whether recording works inside it is untested.

### Building the APK

EAS Build, `preview` profile (internal distribution, APK):

```bash
npx eas build --platform android --profile preview
```

Queue time on the free tier has ranged from minutes to several hours. The build page lists the APK link when it finishes. `eas.json` also has a `production` profile (app bundle); it has not been used.

### Checks

```bash
npm run typecheck
node scripts/test-logic.mjs
node --test scripts/test-reorder-save.mjs
```

`test-logic.mjs` compiles `src/` into a temp folder and runs it against in-memory stand-ins for storage, location and the background task. It needs no network and takes about 30 seconds because the order search is timed. It covers the night and paper-day rules, pay, history and per-route reports, the optimizer, update-mode import, Re-route, GPS tracking, notifications (what is shown, the Delivered button handled as the background task would, the near alert, reminders), search, houses added by hand (registry, address lookup, placement at shift start and mid-shift), removing a shift, and reopening one. The React screens and hooks are not covered by it.

## Layout

```
app/                    expo-router screens (file path = route)
  _layout.tsx           navigation shell; imports tracking so the background task is registered at startup
  index.tsx             home: night selector, route picker, start shift, links, Reopen banner
  shift.tsx             the checklist, Re-route from here, Shift done
  earnings.tsx          pay and performance reports
  routes.tsx            hide / activate / delete / restore routes
  paused.tsx            houses marked Stopped
  reminders.tsx         notification settings: nightly reminder
  search.tsx            find any house; stop, resume or remove it
  add-house.tsx         add a new start
  import.tsx            PDF import (Update / Replace)

src/
  components/AddHouseForm.tsx   the add-a-house form (used by add-house.tsx and the shift screen)
  types.ts              shared types
  data/
    subscribers.ts      the 346 built-in houses
    subscribers.geocoded.json   their coordinates
    routes.ts, anchors.ts, depot-notes.ts
    seed-orders.ts      baked order per route selection (31)   [generated]
    heading-matrix.ts   direction-aware road distances         [generated]
    cut-through.ts      penalised house pairs                  [generated]
  lib/
    shift.ts            useShift() state, planReroute, planFromGps, recordShift
    headingSearch.ts    the search (pure; also used by the bake script)
    headingData.ts      builds the problem, orderStops, insertStops, distances
    optimizer-v2.ts, matrix.ts, matrixAlias.ts   older distance-matrix helpers still used for house ids and straight-line fallback
    importRoute.ts, pdfRouteList.ts, geocode.ts, registry.ts, registry-core.ts
    history.ts          shift records, totals, week and per-route reports
    schedule.ts, settings.ts, paused.ts, notes.ts, storage.ts, mergeOrder.ts
    houseSearch.ts, addHouse.ts   search, and building a house added by hand
    reopen.ts           keeps the latest ended shift so it can be reopened
    alerts.ts           notifications: next-house notification, near alert, button handling, reminders
    nextHouse.ts, reminders.ts, shiftEvents.ts   their rules (no phone modules, so they are tested in Node)
    tracking.ts         background GPS recording and distance from the track
    navigation.ts       opens Google Maps (driving mode)

scripts/                data pipeline and checks, run with node on the laptop
```

State is in `AsyncStorage`: the current shift, last order per route selection (`@rr/lastOrder/v14/`, bumped whenever the seeds change so stale orders are dropped), history, stopped houses, notes, the rate, the route registry, and the GPS track points.

## Regenerating the data

These talk to public servers (OSRM, Overpass, Nominatim) and cache under `scripts/.cache/` (git-ignored). Run `npm install` inside `scripts/` first.

| When | Run |
|---|---|
| The built-in house list or coordinates change | `node scripts/bake-heading-seeds.mjs fetch`, then `solve all-sets`, then `write`, then `node scripts/export-heading-data.mjs` |
| You want to re-check orders for cut-throughs | `node scripts/audit-cut-throughs.mjs`, then re-bake |
| You want to measure what Re-route does on real roads | `node scripts/audit-reroute.mjs` |

Bump `LAST_ORDER_PREFIX` in `src/lib/storage.ts` after re-baking, or phones keep using the orders they saved. The `bake` modes and options are described at the top of `scripts/bake-heading-seeds.mjs`.

Older scripts in `scripts/` (`parse-*.mjs`, `solve-*.py`, `*-ortools.json`, `night-matrix.json`) are from the first optimizer and the PDF parsing of the built-in routes. They are kept for reference.
