import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AddHouseForm from "@/components/AddHouseForm";
import { clearAlertError, lastAlertError, syncNextHouse } from "@/lib/alerts";
import { useKeepAwake } from "expo-keep-awake";
import { useRouter } from "expo-router";
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from "react-native-draggable-flatlist";
import { DEPOT_NOTES } from "@/data/depot-notes";
import { openInGoogleMaps } from "@/lib/navigation";
import { getCurrentCoord } from "@/lib/location";
import { noteKey, useNotes } from "@/lib/notes";
import { kmText, minText, savingText } from "@/lib/history";
import { usePaused } from "@/lib/paused";
import { subscribersForRoutes, useRegistry } from "@/lib/registry";
import { DAY_NAMES, nightOfPaperDay, paperDayIndex } from "@/lib/schedule";
import { formatMoney, useRate } from "@/lib/settings";
import { shiftDistances, useShift } from "@/lib/shift";
import { isTracking, lastTrackError, startTracking, trackedMeters } from "@/lib/tracking";
import type { Subscriber } from "@/types";

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function Shift() {
  useKeepAwake();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, ready, reorder, rerouteFrom, markDelivered, unmarkDelivered, finish, finishAsDone, reset, addToShift, reload } = useShift();
  const { notes, setNote } = useNotes();
  const { paused, togglePaused } = usePaused();
  const { rateCents } = useRate();
  const reg = useRegistry();
  const [rerouting, setRerouting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [editing, setEditing] = useState<Subscriber | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // A house ticked from a notification changes the saved shift while this screen is open or in the background;
  // coming back to the app takes that copy.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") void reload(); });
    return () => sub.remove();
  }, [reload]);

  // The ongoing "next house" notification follows the shift on screen. The first run asks for permission; a refusal,
  // or a failure in the background button handler, is shown below the header, not hidden.
  const [alertError, setAlertError] = useState<string | null>(null);
  const askedForAlerts = useRef(false);
  const syncAlerts = useCallback((ask: boolean) => {
    if (!ready) return;
    syncNextHouse(state, paused, ask)
      .then(() => lastAlertError())
      .then((stored) => setAlertError(stored))
      .catch((e: unknown) => setAlertError(e instanceof Error ? e.message : String(e)));
  }, [ready, state, paused, reg.state]);
  useEffect(() => {
    syncAlerts(!askedForAlerts.current);
    askedForAlerts.current = true;
  }, [syncAlerts]);

  // What the GPS recording has measured so far. Read again every 20 s; a failure is shown, not hidden.
  const [gps, setGps] = useState<{ drivenM: number | null; on: boolean; error: string | null }>({ drivenM: null, on: false, error: null });
  const startedAt = state?.startedAt ?? null;
  const readGps = useCallback(async () => {
    if (startedAt === null) return;
    try {
      const [drivenM, on, error] = await Promise.all([trackedMeters(startedAt), isTracking(startedAt), lastTrackError()]);
      setGps({ drivenM, on, error });
    } catch (e) {
      setGps({ drivenM: null, on: false, error: e instanceof Error ? e.message : String(e) });
    }
  }, [startedAt]);
  useEffect(() => {
    void readGps();
    const t = setInterval(() => void readGps(), 20_000);
    return () => clearInterval(t);
  }, [readGps]);
  const turnOnGps = async () => {
    if (startedAt === null) return;
    try {
      await startTracking(startedAt);
    } catch (e) {
      Alert.alert("Couldn't turn on GPS recording", e instanceof Error ? e.message : String(e));
    }
    await readGps();
  };

  // Distance driven so far (along the houses ticked off) against the planned total. A failure is shown, not hidden.
  const distances = useMemo(() => {
    if (!state) return { value: null, error: null };
    try {
      return { value: shiftDistances(state, Object.keys(paused), false), error: null };
    } catch (e) {
      return { value: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [state, paused, reg.state]);

  const stops = useMemo(() => {
    if (!state) return [];
    const bag = subscribersForRoutes(state.routeIds);
    const byId = new Map(bag.map((s) => [s.id, s]));
    const ordered: Subscriber[] = [];
    for (const id of state.orderedIds) {
      if (paused[id]) continue;   // house is Stopped — skip entirely
      const s = byId.get(id);
      if (s) ordered.push(s);
    }
    return ordered;
  }, [state, paused, reg.state]);

  if (!ready || !reg.ready) return <View style={styles.center}><Text style={styles.dim}>Loading…</Text></View>;

  if (!state) {
    return (
      <View style={styles.center}>
        <Text style={styles.dim}>No shift in progress.</Text>
        <Pressable style={styles.primary} onPress={() => router.replace("/")}>
          <Text style={styles.primaryText}>Go home</Text>
        </Pressable>
      </View>
    );
  }

  const delivered = state.deliveredIds;
  const remaining = stops.filter((s) => !delivered.includes(s.id));
  const nextStop = remaining[0];
  const allDone = remaining.length === 0;
  const elapsed = state.startedAt ? now - state.startedAt : 0;
  const paperDay = state.deliveryDayIdx ?? paperDayIndex();
  const savedM = (state.optimizations ?? []).reduce((t, o) => t + Math.max(0, o.beforeM - o.afterM), 0);

  const openNote = (s: Subscriber) => {
    setEditing(s);
    setDraft(notes[noteKey(s)] ?? "");
  };
  const closeNote = () => { setEditing(null); setDraft(""); };
  const saveNote = () => {
    if (editing) setNote(noteKey(editing), draft);
    closeNote();
  };

  // Recording the shift can fail; say so and leave the shift in place so it can be tried again.
  const closeShift = async (end: () => Promise<void>) => {
    try {
      await end();
      router.replace("/");
    } catch (e) {
      Alert.alert("Couldn't save the shift", e instanceof Error ? e.message : String(e));
    }
  };

  const onFinish = () => {
    Alert.alert("Finish shift?", "Marks the shift complete.", [
      { text: "Cancel", style: "cancel" },
      { text: "Finish", onPress: () => closeShift(finish) },
    ]);
  };

  const onShiftDone = () => {
    const remaining = stops.length - state.deliveredIds.length;
    const pay = `Pays ${formatMoney(stops.length * rateCents)} for ${stops.length} house${stops.length === 1 ? "" : "s"}.`;
    Alert.alert(
      "Shift done?",
      remaining > 0
        ? `Marks the remaining ${remaining} stop${remaining === 1 ? "" : "s"} as delivered and saves this order for next time. ${pay}`
        : `Marks the shift complete and saves this order for next time. ${pay}`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Shift done", onPress: () => closeShift(finishAsDone) },
      ],
    );
  };

  const onReroute = () => {
    Alert.alert(
      "Re-route from here?",
      `Re-orders the ${remaining.length} stop${remaining.length === 1 ? "" : "s"} you haven't delivered, starting from where you are now. Any manual order for them is replaced.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Re-route",
          onPress: async () => {
            setRerouting(true);
            try {
              const here = await getCurrentCoord();
              const r = await rerouteFrom(here, Object.keys(paused));
              Alert.alert(
                "Re-routed",
                `${r.stops} stop${r.stops === 1 ? "" : "s"} re-ordered from where you are.\n\nRemaining distance ${savingText(r.beforeM, r.afterM)}`,
              );
            } catch (e) {
              Alert.alert("Couldn't re-route", e instanceof Error ? e.message : String(e));
            } finally {
              setRerouting(false);
            }
          },
        },
      ],
    );
  };

  // The new start is already saved on its route; this slots it into the stops left and says where it landed.
  const onHouseAdded = async (house: Subscriber) => {
    const order = await addToShift(house.id);
    setAdding(false);
    if (order === null) {
      Alert.alert("House added", `${house.address} is on route ${house.routeId} but not on tonight's shift (other route, or no paper tonight). It is in the order from the next shift.`);
      return;
    }
    const before = order.slice(0, order.indexOf(house.id)).reverse().find((id) => !paused[id]);
    const prev = before === undefined ? undefined : subscribersForRoutes(state?.routeIds ?? []).find((x) => x.id === before);
    Alert.alert("House added", `${house.address} is in tonight's stops, ${prev ? `after ${prev.address}` : "first"}. Drag it if it should go elsewhere.`);
  };

  const onReset = () => {
    Alert.alert("Reset shift?", "Clears all delivery marks for today.", [
      { text: "Cancel", style: "cancel" },
      { text: "Reset", style: "destructive", onPress: async () => { await reset(); router.replace("/"); } },
    ]);
  };

  const onDragEnd = ({ data }: { data: Subscriber[] }) => {
    void reorder(data.map((s) => s.id));
  };

  const renderItem = ({ item, drag, isActive }: RenderItemParams<Subscriber>) => {
    const isDone = delivered.includes(item.id);
    const isNext = nextStop?.id === item.id;
    const userNote = notes[noteKey(item)];
    const depotNote = DEPOT_NOTES[item.id] ?? item.note;
    return (
      <ScaleDecorator>
        <View style={[styles.row, isNext && styles.rowNext, isDone && styles.rowDone, isActive && styles.rowActive]}>
          <Pressable
            style={[styles.rowCheck, isDone && styles.rowCheckOn]}
            onPress={() => (isDone ? unmarkDelivered(item.id) : markDelivered(item.id))}
            hitSlop={12}
          >
            {isDone && <Text style={styles.rowCheckMark}>✓</Text>}
          </Pressable>
          <Pressable
            style={styles.rowBody}
            onPress={() => openInGoogleMaps(item)}
            onLongPress={drag}
            delayLongPress={220}
          >
            <Text style={[styles.rowAddress, isDone && styles.rowStrike]}>{item.address}</Text>
            <Text style={[styles.rowName, isDone && styles.rowStrike]}>{item.name}</Text>
            {depotNote ? <Text style={styles.rowDepotNote}>📮 {depotNote}</Text> : null}
            {userNote ? <Text style={styles.rowNote}>✎ {userNote}</Text> : null}
            <Text style={styles.rowMeta}>{item.routeId} · {item.postal}{item.schedule ? ` · ${item.schedule}` : ""}</Text>
          </Pressable>
          <Pressable onPress={() => openNote(item)} style={styles.noteBtn} hitSlop={12}>
            <Text style={[styles.noteBtnText, userNote && styles.noteBtnTextActive]}>✎</Text>
          </Pressable>
          <Pressable onLongPress={drag} delayLongPress={0} style={styles.dragHandle} hitSlop={12}>
            <Text style={styles.dragHandleText}>≡</Text>
          </Pressable>
        </View>
      </ScaleDecorator>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <Text style={styles.headerRoutes}>{state.routeIds.join(" · ")}  ·  {DAY_NAMES[nightOfPaperDay(paperDay)]} night · {DAY_NAMES[paperDay]} paper</Text>
          <Pressable style={styles.doneBtn} onPress={onShiftDone}>
            <Text style={styles.doneBtnText}>Shift done</Text>
          </Pressable>
        </View>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${(delivered.length / Math.max(stops.length, 1)) * 100}%` }]} />
        </View>
        <View style={styles.headerRow}>
          <Text style={styles.headerStat}>{delivered.length} / {stops.length}</Text>
          <Text style={styles.headerStat}>{formatMoney(delivered.length * rateCents)} of {formatMoney(stops.length * rateCents)}</Text>
          <Text style={styles.headerStat}>{formatElapsed(elapsed)}</Text>
        </View>
        {distances.value && (
          <Text style={styles.headerSub}>
            {kmText(distances.value.coveredM)} covered of {kmText(distances.value.plannedM)} planned
            {savedM > 50 ? ` · saved ${kmText(savedM)}, ${minText(savedM)} by optimizing` : ""}
          </Text>
        )}
        {distances.error && <Text style={styles.headerError}>Distance unavailable: {distances.error}</Text>}
        {alertError && (
          <Pressable onPress={async () => { await clearAlertError(); syncAlerts(true); }} hitSlop={8}>
            <Text style={styles.headerWarn}>Notifications: {alertError} Tap to try again.</Text>
          </Pressable>
        )}
        {gps.on ? (
          <Text style={styles.headerSub}>GPS: {kmText(gps.drivenM ?? 0)} moved so far{gps.error ? ` · ${gps.error}` : ""}</Text>
        ) : (
          <Pressable onPress={turnOnGps} hitSlop={8}>
            <Text style={styles.headerWarn}>GPS recording is off{gps.error ? `: ${gps.error}` : ""}. Tap to turn it on.</Text>
          </Pressable>
        )}
      </View>

      {nextStop && !allDone && (
        <Pressable style={styles.next} onPress={() => openInGoogleMaps(nextStop)}>
          <Text style={styles.nextLabel}>NEXT</Text>
          <Text style={styles.nextAddress}>{nextStop.address}</Text>
          <Text style={styles.nextName}>{nextStop.name}</Text>
          {(DEPOT_NOTES[nextStop.id] ?? nextStop.note) ? <Text style={styles.nextDepotNote}>📮 {DEPOT_NOTES[nextStop.id] ?? nextStop.note}</Text> : null}
          {notes[noteKey(nextStop)] ? <Text style={styles.nextNote}>✎ {notes[noteKey(nextStop)]}</Text> : null}
          <Text style={styles.nextNav}>Tap to navigate ›</Text>
        </Pressable>
      )}

      {allDone && (
        <View style={[styles.next, styles.doneBanner]}>
          <Text style={styles.doneTitle}>All delivered</Text>
          <Text style={styles.doneSub}>Time: {formatElapsed(elapsed)} · Earned {formatMoney(delivered.length * rateCents)} · Go home.</Text>
          <Pressable style={styles.primary} onPress={onFinish}>
            <Text style={styles.primaryText}>Finish shift</Text>
          </Pressable>
        </View>
      )}

      <DraggableFlatList
        data={stops}
        keyExtractor={(s) => s.id}
        onDragEnd={onDragEnd}
        renderItem={renderItem}
        style={{ flex: 1 }}
        containerStyle={{ flex: 1 }}
        contentContainerStyle={[styles.list, { paddingBottom: 24 }]}
      />

      <View style={[styles.footer, { paddingBottom: 12 + insets.bottom }]}>
        <Pressable
          style={[styles.rerouteBtn, (rerouting || allDone) && styles.rerouteBtnOff]}
          onPress={onReroute}
          disabled={rerouting || allDone}
        >
          <Text style={styles.rerouteText}>{rerouting ? "Finding you…" : "Re-route from here"}</Text>
        </Pressable>
        <Pressable style={styles.footerBtn} onPress={() => setAdding(true)}>
          <Text style={styles.footerLink}>Add a house (new start)</Text>
        </Pressable>
        <Text style={styles.footerHint}>Tap ✎ to add note · long-press ≡ to reorder</Text>
        <Pressable style={styles.footerBtn} onPress={onReset}>
          <Text style={styles.footerText}>Reset today's shift</Text>
        </Pressable>
      </View>

      <Modal visible={adding} animationType="slide" onRequestClose={() => setAdding(false)}>
        <View style={styles.addWrap}>
          <ScrollView contentContainerStyle={styles.addContent} keyboardShouldPersistTaps="handled">
            <Pressable onPress={() => setAdding(false)} hitSlop={12}><Text style={styles.addBack}>‹ Cancel</Text></Pressable>
            <Text style={styles.addTitle}>Add a house</Text>
            <Text style={styles.addSub}>It goes into the stops you have left where it adds the least driving, and opens in Google Maps like any other stop.</Text>
            <AddHouseForm defaultRouteId={state.routeIds[0]} onAdded={onHouseAdded} />
          </ScrollView>
        </View>
      </Modal>

      <Modal visible={!!editing} animationType="slide" transparent onRequestClose={closeNote}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalWrap}>
          <Pressable style={styles.modalBackdrop} onPress={closeNote} />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{editing?.address}</Text>
            <Text style={styles.modalSub}>{editing?.name} · {editing?.postal}</Text>
            {editing && (
              <Pressable
                style={[styles.pauseRow, paused[editing.id] && styles.pauseRowOn]}
                onPress={() => {
                  togglePaused(editing.id);
                  if (!paused[editing.id]) closeNote();
                }}
              >
                <View style={[styles.pauseDot, paused[editing.id] && styles.pauseDotOn]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.pauseLabel}>
                    {paused[editing.id] ? "Stopped — paper not delivered" : "Stop this house"}
                  </Text>
                  <Text style={styles.pauseSub}>
                    {paused[editing.id]
                      ? "Tap to resume deliveries"
                      : "Hide from future shifts until resumed"}
                  </Text>
                </View>
              </Pressable>
            )}
            <TextInput
              style={styles.modalInput}
              multiline
              placeholder="e.g. 'side door', 'red brick, no number', 'watch for dog'"
              placeholderTextColor="#555"
              value={draft}
              onChangeText={setDraft}
            />
            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancel} onPress={closeNote}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.modalSave} onPress={saveNote}>
                <Text style={styles.modalSaveText}>Save</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0a0a0a", gap: 12 },
  dim: { color: "#888" },

  header: { padding: 16, paddingBottom: 12, borderBottomWidth: 1, borderColor: "#1a1a1a" },
  headerTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 },
  headerRoutes: { color: "#888", fontSize: 12, letterSpacing: 1, flex: 1 },
  doneBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: "#facc15" },
  doneBtnText: { color: "#0a0a0a", fontSize: 13, fontWeight: "700" },
  headerSub: { color: "#aaa", fontSize: 12, marginTop: 6 },
  headerWarn: { color: "#facc15", fontSize: 12, marginTop: 6 },
  headerError: { color: "#fca5a5", fontSize: 12, marginTop: 6 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  headerStat: { color: "#f5f5f5", fontSize: 14, fontWeight: "600" },
  progressBar: { height: 6, backgroundColor: "#1a1a1a", borderRadius: 3, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: "#4ade80" },

  next: {
    backgroundColor: "#0f1a12", margin: 16, marginTop: 12, padding: 20,
    borderRadius: 16, borderWidth: 1, borderColor: "#4ade80",
  },
  nextLabel: { color: "#4ade80", fontSize: 12, letterSpacing: 2, fontWeight: "700" },
  nextAddress: { color: "#f5f5f5", fontSize: 24, fontWeight: "700", marginTop: 8 },
  nextName: { color: "#aaa", fontSize: 14, marginTop: 4 },
  nextDepotNote: { color: "#60a5fa", fontSize: 14, marginTop: 6 },
  nextNote: { color: "#facc15", fontSize: 14, marginTop: 6, fontStyle: "italic" },
  nextNav: { color: "#4ade80", fontSize: 14, marginTop: 12, fontWeight: "600" },

  doneBanner: { borderColor: "#facc15", backgroundColor: "#1a1305", alignItems: "center", gap: 12 },
  doneTitle: { color: "#facc15", fontSize: 24, fontWeight: "700" },
  doneSub: { color: "#c9a83a", fontSize: 14 },

  list: { paddingHorizontal: 16, paddingBottom: 8 },
  row: {
    flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 12,
    marginBottom: 8, backgroundColor: "#141414", borderRadius: 10, gap: 8,
  },
  rowNext: { backgroundColor: "#101c14", borderWidth: 1, borderColor: "#4ade80" },
  rowDone: { opacity: 0.4 },
  rowActive: { backgroundColor: "#1c1c1c", borderWidth: 1, borderColor: "#666" },
  rowCheck: {
    width: 32, height: 32, borderRadius: 8, borderWidth: 2, borderColor: "#333",
    alignItems: "center", justifyContent: "center",
  },
  rowCheckOn: { backgroundColor: "#4ade80", borderColor: "#4ade80" },
  rowCheckMark: { color: "#0a0a0a", fontSize: 18, fontWeight: "700" },
  rowBody: { flex: 1 },
  rowAddress: { color: "#f5f5f5", fontSize: 16, fontWeight: "600" },
  rowName: { color: "#aaa", fontSize: 13, marginTop: 2 },
  rowDepotNote: { color: "#60a5fa", fontSize: 12, marginTop: 4 },
  rowNote: { color: "#facc15", fontSize: 12, marginTop: 4, fontStyle: "italic" },
  rowMeta: { color: "#666", fontSize: 11, marginTop: 4 },
  rowStrike: { textDecorationLine: "line-through" },
  noteBtn: { width: 28, height: 40, alignItems: "center", justifyContent: "center" },
  noteBtnText: { color: "#444", fontSize: 18 },
  noteBtnTextActive: { color: "#facc15" },
  dragHandle: { width: 28, height: 40, alignItems: "center", justifyContent: "center" },
  dragHandleText: { color: "#666", fontSize: 22 },

  primary: { backgroundColor: "#facc15", borderRadius: 12, paddingHorizontal: 24, paddingVertical: 14 },
  primaryText: { color: "#0a0a0a", fontSize: 16, fontWeight: "700" },

  footer: { paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1, borderColor: "#1a1a1a" },
  rerouteBtn: {
    paddingVertical: 12, borderRadius: 10, alignItems: "center", marginBottom: 8,
    backgroundColor: "#1a1a1a", borderWidth: 1, borderColor: "#60a5fa",
  },
  rerouteBtnOff: { opacity: 0.4 },
  rerouteText: { color: "#60a5fa", fontSize: 14, fontWeight: "700" },
  footerHint: { color: "#555", fontSize: 11, textAlign: "center" },
  footerBtn: { padding: 8, alignItems: "center" },
  footerText: { color: "#666", fontSize: 12 },
  footerLink: { color: "#60a5fa", fontSize: 13 },
  addWrap: { flex: 1, backgroundColor: "#0a0a0a" },
  addContent: { padding: 16, paddingTop: 48, gap: 8, paddingBottom: 40 },
  addBack: { color: "#60a5fa", fontSize: 15 },
  addTitle: { color: "#f5f5f5", fontSize: 22, fontWeight: "700" },
  addSub: { color: "#888", fontSize: 13, lineHeight: 18, marginBottom: 6 },

  modalWrap: { flex: 1, justifyContent: "flex-end" },
  modalBackdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.6)" },
  modalCard: {
    backgroundColor: "#141414", padding: 20, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderTopWidth: 1, borderColor: "#333", gap: 12,
  },
  modalTitle: { color: "#f5f5f5", fontSize: 20, fontWeight: "700" },
  modalSub: { color: "#888", fontSize: 13 },
  modalInput: {
    backgroundColor: "#0a0a0a", color: "#f5f5f5", padding: 14, borderRadius: 10,
    minHeight: 120, fontSize: 16, textAlignVertical: "top",
    borderWidth: 1, borderColor: "#333",
  },
  pauseRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    padding: 12, borderRadius: 10, backgroundColor: "#1a1a1a",
    borderWidth: 1, borderColor: "#2a2a2a",
  },
  pauseRowOn: { backgroundColor: "#2a1a0a", borderColor: "#facc15" },
  pauseDot: { width: 16, height: 16, borderRadius: 8, backgroundColor: "#333", borderWidth: 2, borderColor: "#555" },
  pauseDotOn: { backgroundColor: "#facc15", borderColor: "#facc15" },
  pauseLabel: { color: "#f5f5f5", fontSize: 14, fontWeight: "600" },
  pauseSub: { color: "#888", fontSize: 12, marginTop: 2 },

  modalActions: { flexDirection: "row", gap: 12, marginTop: 4 },
  modalCancel: { flex: 1, padding: 14, borderRadius: 10, backgroundColor: "#1f1f1f", alignItems: "center" },
  modalCancelText: { color: "#aaa", fontWeight: "600" },
  modalSave: { flex: 1, padding: 14, borderRadius: 10, backgroundColor: "#facc15", alignItems: "center" },
  modalSaveText: { color: "#0a0a0a", fontWeight: "700" },
});
