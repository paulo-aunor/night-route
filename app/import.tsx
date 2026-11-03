import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { addressKey, geocodeRows, GeocodeCancelled, nominatimJson, type GeoProgress } from "@/lib/geocode";
import { buildImportedRoute, buildUpdatedRoute, type BuiltRoute, type RouteChanges } from "@/lib/importRoute";
import { carryPausedTo } from "@/lib/paused";
import { deriveRouteId, parseRouteListItems, type ParsedRoute, type ParseResult } from "@/lib/pdfRouteList";
import {
  carriedNotes, effectiveRoutes, isImportedRoute, knownCoordinates, registry, subscribersForRoutes, useRegistry,
} from "@/lib/registry";
import { plannedMeters } from "@/lib/headingData";
import { kmText, savingText } from "@/lib/history";
import { matrixIdOfHouse } from "@/lib/matrixAlias";
import { currentRouteOrder, useShift } from "@/lib/shift";
import { usePdfExtractor } from "@/lib/usePdfExtractor";
import type { Subscriber } from "@/types";

const MAX_BYTES = 3 * 1024 * 1024;

type Step = "idle" | "reading" | "review" | "locating" | "confirm" | "saved" | "error";
// Road distance from the library of the route's order before the import and after it.
type Distances = { beforeM: number; beforeHouses: number; afterM: number; afterHouses: number };
type Found = { parsed: ParsedRoute; built: BuiltRoute; changes?: RouteChanges; distances?: Distances };

function libraryDistance(subs: readonly Subscriber[], order: readonly string[]): number {
  const byId = new Map(subs.map((x) => [x.id, x]));
  return plannedMeters({
    stopIds: order,
    order,
    coordOf: (x) => byId.get(x),
    matrixIdOf: (x) => { const h = byId.get(x); return h ? matrixIdOfHouse(h) : undefined; },
    start: { kind: "library" },
  });
}
type Mode = "update" | "replace";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function ImportRoute() {
  const router = useRouter();
  const reg = useRegistry();
  const { state: shift } = useShift();
  const { view, extract } = usePdfExtractor();

  const [step, setStep] = useState<Step>("idle");
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<ParseResult | null>(null);
  const [progress, setProgress] = useState<{ id: string; p: GeoProgress; n: number; of: number } | null>(null);
  const [found, setFound] = useState<Found[]>([]);
  const [replacing, setReplacing] = useState<Record<string, true>>({});   // route codes set to Replace
  const [message, setMessage] = useState("");
  const cancelled = useRef(false);
  useEffect(() => () => { cancelled.current = true; }, []);

  const fail = (e: unknown) => {
    setMessage(errText(e));
    setStep("error");
  };

  const onPick = async () => {
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: "application/pdf",
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (picked.canceled) return;
      const asset = picked.assets[0];
      if (asset.size !== undefined && asset.size > MAX_BYTES) {
        throw new Error(`That PDF is ${(asset.size / 1048576).toFixed(1)} MB. Route lists are normally well under 1 MB.`);
      }
      setFileName(asset.name);
      setStep("reading");
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
      const items = await extract(base64);
      setResult(parseRouteListItems(items));
      setStep("review");
    } catch (e) {
      fail(e);
    }
  };

  const onLocate = async () => {
    if (!result) return;
    cancelled.current = false;
    setStep("locating");
    try {
      const known = knownCoordinates();
      const out: Found[] = [];
      for (let i = 0; i < result.routes.length; i++) {
        const parsed = result.routes[i];
        const id = deriveRouteId(parsed.code);
        const geo = await geocodeRows(
          parsed.subs,
          { fetchJson: nominatimJson, sleep: wait, known },
          (p) => setProgress({ id, p, n: i + 1, of: result.routes.length }),
          () => cancelled.current,
        );
        // Later routes in the same PDF can reuse what this one found.
        parsed.subs.forEach((s, k) => {
          const c = geo.coords[k];
          if (c) known.set(addressKey(s.address, s.city), c);
        });
        await wait(30);   // let the screen update before ordering blocks the thread
        // the route as it stands, to say how the new order compares
        const existingSubs = exists(id) ? subscribersForRoutes([id]) : [];
        const existingOrder = existingSubs.length > 0 ? await currentRouteOrder(id) : null;
        const measure = (built: BuiltRoute): Distances | undefined => existingOrder ? {
          beforeM: libraryDistance(existingSubs, existingOrder),
          beforeHouses: existingOrder.length,
          afterM: libraryDistance(built.imported.subs, built.imported.seed),
          afterHouses: built.imported.seed.length,
        } : undefined;
        if (modeFor(parsed.code, id) === "update" && existingOrder) {
          const built = buildUpdatedRoute(parsed, geo.coords, Date.now(), carriedNotes(id), { subs: existingSubs, order: existingOrder });
          out.push({ parsed, built, changes: built.changes, distances: measure(built) });
        } else {
          const built = buildImportedRoute(parsed, geo.coords, Date.now(), carriedNotes(id));
          out.push({ parsed, built, distances: measure(built) });
        }
      }
      setFound(out);
      setStep("confirm");
    } catch (e) {
      if (e instanceof GeocodeCancelled) {
        setStep("review");
        return;
      }
      fail(e);
    }
  };

  const onSave = async () => {
    try {
      for (const f of found) {
        if (f.changes) await carryPausedTo(f.changes.idMap);
        await registry.importRoute(f.built.imported);
      }
      setStep("saved");
    } catch (e) {
      fail(e);
    }
  };

  const activeIds = shift?.routeIds ?? [];
  const exists = (id: string) => effectiveRoutes().some((r) => r.id === id);
  const modeFor = (code: string, id: string): Mode => (exists(id) && !replacing[code] ? "update" : "replace");
  const existingNote = (code: string, id: string) => {
    if (!exists(id)) return "New route";
    const n = subscribersForRoutes([id]).length;
    const which = `${isImportedRoute(id) ? "your imported" : "the built-in"} ${id} (${n} houses)`;
    return modeFor(code, id) === "update" ? `Updates ${which}` : `Replaces ${which}`;
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {view}

      {reg.error && (
        <View style={styles.errorBox}><Text style={styles.errorText}>{reg.error}</Text></View>
      )}

      {step === "idle" && (
        <>
          <Text style={styles.lead}>
            Pick a Route Delivery List PDF from the depot. The app reads it, finds each address on the map, and orders the stops.
          </Text>
          <Text style={styles.hint}>
            A PDF for a route you already have updates it: houses keep their order, new ones are slotted in, and ones no longer listed are removed. Driving Order and Active Subscriber List PDFs aren't supported yet.
          </Text>
          <Pressable style={styles.primary} onPress={onPick}>
            <Text style={styles.primaryText}>Choose PDF</Text>
          </Pressable>
        </>
      )}

      {step === "reading" && (
        <View style={styles.busy}>
          <ActivityIndicator color="#60a5fa" />
          <Text style={styles.busyText}>Reading {fileName}…</Text>
        </View>
      )}

      {step === "review" && result && (
        <>
          <Text style={styles.lead}>{fileName}</Text>
          {result.routes.map((r) => {
            const id = deriveRouteId(r.code);
            const other = r.subs.filter((s) => s.schedule !== "Mon-Sat").length;
            const blocked = activeIds.includes(id);
            return (
              <View key={r.code} style={styles.card}>
                <Text style={styles.cardTitle}>{id} <Text style={styles.cardCode}>{r.code}</Text></Text>
                <Text style={styles.cardMeta}>
                  {r.subs.length} houses{other > 0 ? ` · ${other} not Mon-Sat` : ""}
                  {r.expected !== null ? ` · report says ${r.expected}` : ""}
                </Text>
                <Text style={styles.cardNote}>{existingNote(r.code, id)}</Text>
                {exists(id) && (
                  <View style={styles.modeRow}>
                    {(["update", "replace"] as const).map((m) => (
                      <Pressable
                        key={m}
                        style={[styles.modeBtn, modeFor(r.code, id) === m && styles.modeBtnOn]}
                        onPress={() => setReplacing((prev) => {
                          const next = { ...prev };
                          if (m === "replace") next[r.code] = true; else delete next[r.code];
                          return next;
                        })}
                      >
                        <Text style={[styles.modeText, modeFor(r.code, id) === m && styles.modeTextOn]}>
                          {m === "update" ? "Update, keep order" : "Replace, re-order"}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
                {blocked && (
                  <Text style={styles.errorText}>A shift using {id} is in progress. Finish or reset it before replacing this route.</Text>
                )}
              </View>
            );
          })}
          {result.problems.length > 0 && (
            <View style={styles.errorBox}>
              <Text style={styles.errorTitle}>Check these before importing</Text>
              {result.problems.map((p, i) => <Text key={i} style={styles.errorText}>• {p}</Text>)}
            </View>
          )}
          <Pressable
            style={[styles.primary, result.routes.some((r) => activeIds.includes(deriveRouteId(r.code))) && styles.primaryOff]}
            disabled={result.routes.some((r) => activeIds.includes(deriveRouteId(r.code)))}
            onPress={onLocate}
          >
            <Text style={styles.primaryText}>{result.problems.length > 0 ? "Import anyway" : "Find addresses and order stops"}</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={onPick}>
            <Text style={styles.secondaryText}>Choose a different PDF</Text>
          </Pressable>
        </>
      )}

      {step === "locating" && (
        <View style={styles.busy}>
          <ActivityIndicator color="#60a5fa" />
          <Text style={styles.busyText}>
            {progress
              ? `${progress.id}: finding buildings ${progress.p.done} of ${progress.p.total}`
              : "Finding addresses…"}
          </Text>
          {progress && progress.of > 1 && <Text style={styles.hint}>Route {progress.n} of {progress.of}</Text>}
          <Text style={styles.hint}>Known addresses are instant. New ones take about a second each.</Text>
          <Pressable style={styles.secondary} onPress={() => { cancelled.current = true; }}>
            <Text style={styles.secondaryText}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {step === "confirm" && (
        <>
          {found.map(({ parsed, built, changes, distances }) => {
            const id = built.imported.route.id;
            return (
              <View key={parsed.code} style={styles.card}>
                <Text style={styles.cardTitle}>{id} <Text style={styles.cardCode}>{parsed.code}</Text></Text>
                <Text style={styles.cardMeta}>
                  {changes
                    ? `${built.imported.subs.length} houses · ${changes.kept} kept in place · ${changes.added.length} added · ${changes.removed.length} removed`
                    : `${built.imported.subs.length} houses placed and ordered from the library`}
                </Text>
                <Text style={styles.cardNote}>{existingNote(parsed.code, id)}</Text>
                {distances && (
                  <Text style={styles.hint}>
                    {distances.beforeHouses === distances.afterHouses
                      ? `Route distance from the library ${savingText(distances.beforeM, distances.afterM)}`
                      : `Route distance from the library: ${kmText(distances.afterM)} for ${distances.afterHouses} houses, was ${kmText(distances.beforeM)} for ${distances.beforeHouses}.`}
                  </Text>
                )}
                {changes && changes.added.length > 0 && (
                  <View style={styles.listBox}>
                    <Text style={styles.listTitle}>Added, slotted in beside their nearest houses</Text>
                    {changes.added.map((a) => <Text key={a.id} style={styles.listText}>• {a.address}, {a.city} ({a.name})</Text>)}
                  </View>
                )}
                {changes && changes.removed.length > 0 && (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorTitle}>{changes.removed.length} no longer on the report, will be removed</Text>
                    {changes.removed.map((r) => <Text key={r.id} style={styles.errorText}>• {r.address}, {r.city} ({r.name})</Text>)}
                  </View>
                )}
                {built.estimatedStops > 0 && (
                  <Text style={styles.hint}>Ordering uses map distances for these new addresses, so it can be a few percent longer than a route built with full road data.</Text>
                )}
                {built.unplaced.length > 0 && (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorTitle}>{built.unplaced.length} couldn't be found and will be left out</Text>
                    {built.unplaced.map((u, i) => (
                      <Text key={i} style={styles.errorText}>• {u.address}, {u.city} ({u.name})</Text>
                    ))}
                  </View>
                )}
              </View>
            );
          })}
          <Pressable style={styles.primary} onPress={onSave}>
            <Text style={styles.primaryText}>
              {found.some((f) => f.built.unplaced.length > 0) ? "Save without the missing addresses" : "Save route"}
            </Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={() => setStep("review")}>
            <Text style={styles.secondaryText}>Back</Text>
          </Pressable>
        </>
      )}

      {step === "saved" && (
        <>
          <Text style={styles.lead}>Saved</Text>
          {found.map(({ built }) => (
            <Text key={built.imported.route.id} style={styles.cardMeta}>
              {built.imported.route.id}: {built.imported.subs.length} houses
            </Text>
          ))}
          <Text style={styles.hint}>The route is on the home screen. Houses you stopped before stay stopped.</Text>
          <Pressable style={styles.primary} onPress={() => router.back()}>
            <Text style={styles.primaryText}>Done</Text>
          </Pressable>
        </>
      )}

      {step === "error" && (
        <>
          <View style={styles.errorBox}>
            <Text style={styles.errorTitle}>That didn't work</Text>
            <Text style={styles.errorText}>{message}</Text>
          </View>
          <Pressable style={styles.primary} onPress={() => { setStep("idle"); setResult(null); }}>
            <Text style={styles.primaryText}>Try again</Text>
          </Pressable>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content: { padding: 16, gap: 12 },
  lead: { color: "#f5f5f5", fontSize: 16, lineHeight: 23 },
  hint: { color: "#888", fontSize: 13, lineHeight: 19 },
  busy: { alignItems: "center", gap: 10, paddingVertical: 30 },
  busyText: { color: "#f5f5f5", fontSize: 15 },
  card: { backgroundColor: "#161616", borderRadius: 12, padding: 16, borderWidth: 1, borderColor: "#222", gap: 6 },
  cardTitle: { color: "#f5f5f5", fontSize: 20, fontWeight: "700" },
  cardCode: { color: "#666", fontSize: 13, fontWeight: "400" },
  cardMeta: { color: "#aaa", fontSize: 14 },
  cardNote: { color: "#60a5fa", fontSize: 13 },
  primary: { backgroundColor: "#4ade80", borderRadius: 12, padding: 16, alignItems: "center" },
  primaryOff: { opacity: 0.4 },
  primaryText: { color: "#0a0a0a", fontSize: 16, fontWeight: "700" },
  secondary: { padding: 12, alignItems: "center" },
  secondaryText: { color: "#60a5fa", fontSize: 14 },
  modeRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  modeBtn: { flex: 1, borderRadius: 8, borderWidth: 1, borderColor: "#333", padding: 10, alignItems: "center" },
  modeBtnOn: { borderColor: "#60a5fa", backgroundColor: "#0f1d33" },
  modeText: { color: "#888", fontSize: 13 },
  modeTextOn: { color: "#60a5fa", fontWeight: "700" },
  listBox: { backgroundColor: "#0f1d33", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: "#1e3a5f", gap: 4 },
  listTitle: { color: "#93c5fd", fontSize: 14, fontWeight: "700" },
  listText: { color: "#93c5fd", fontSize: 13, lineHeight: 18 },
  errorBox: { backgroundColor: "#2a0f0f", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: "#f87171", gap: 4 },
  errorTitle: { color: "#fca5a5", fontSize: 14, fontWeight: "700" },
  errorText: { color: "#fca5a5", fontSize: 13, lineHeight: 18 },
});
