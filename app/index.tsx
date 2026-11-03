import { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { LIBRARY } from "@/data/routes";
import { getCurrentCoord } from "@/lib/location";
import { usePaused } from "@/lib/paused";
import { canReopen, loadClosed, type ClosedShift } from "@/lib/reopen";
import { countByRoute, countByRouteOn, managedRoutes, registry, useRegistry, visibleRoutes } from "@/lib/registry";
import { DAY_NAMES, NIGHT_INDEXES, nightOfPaperDay, paperDayIndex, paperDayOfNight } from "@/lib/schedule";
import { formatMoney, useRate } from "@/lib/settings";
import { useShift } from "@/lib/shift";
import { startTracking } from "@/lib/tracking";
import type { RouteId } from "@/types";

export default function Home() {
  const router = useRouter();
  const { state, ready, start, reset, reopen } = useShift();
  const { paused } = usePaused();
  const pausedCount = Object.keys(paused).length;
  const reg = useRegistry();
  const routes = visibleRoutes();
  const managedCount = managedRoutes().length;
  const [selected, setSelected] = useState<Set<RouteId>>(new Set());
  const [startFrom, setStartFrom] = useState<"library" | "gps">("library");
  const [busy, setBusy] = useState(false);
  const { rateCents } = useRate();
  // Papers go out the night before: the chips are the nights worked, each showing the paper it delivers.
  const realNight = useMemo(() => nightOfPaperDay(paperDayIndex()), []);
  const [nightIdx, setNightIdx] = useState<number>(realNight);
  const dayIdx = paperDayOfNight(nightIdx);
  const nightText = (n: number) => `${DAY_NAMES[n]} night · ${DAY_NAMES[paperDayOfNight(n)]} paper`;
  const counts = useMemo(() => countByRoute(), [reg.state]);
  const dayCounts = useMemo(() => countByRouteOn(dayIdx), [dayIdx, reg.state]);
  // A route hidden after being ticked must not stay selected.
  const chosen = routes.filter((r) => selected.has(r.id)).map((r) => r.id);

  const toggle = (id: RouteId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(routes.map((r) => r.id)));

  const canStart = chosen.length > 0 && !state && !busy;

  const onStart = async () => {
    setBusy(true);
    try {
      const shift = startFrom === "gps"
        ? await start(chosen, dayIdx, { startCoord: await getCurrentCoord(), excludeIds: Object.keys(paused) })
        : await start(chosen, dayIdx, { excludeIds: Object.keys(paused) });
      // The shift runs either way; without the recording, distance driven isn't measured.
      try {
        if (shift.startedAt !== null) await startTracking(shift.startedAt);
      } catch (e) {
        Alert.alert("GPS recording is off", `${e instanceof Error ? e.message : String(e)}\n\nThe shift runs without it. Distance covered is still estimated from the houses you tick.`);
      }
      router.push("/shift");
    } catch (e) {
      Alert.alert("Couldn't start the shift", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onResume = () => router.push("/shift");

  // The shift that just ended, offered back in case Shift done was tapped by mistake.
  const [closed, setClosed] = useState<ClosedShift | null>(null);
  useFocusEffect(useCallback(() => {
    loadClosed().then(setClosed).catch((e: unknown) =>
      Alert.alert("Couldn't read the last ended shift", e instanceof Error ? e.message : String(e)));
  }, []));
  const onReopen = async () => {
    try {
      const shift = await reopen();
      setClosed(null);
      try {
        if (shift.startedAt !== null) await startTracking(shift.startedAt);
      } catch (e) {
        Alert.alert("GPS recording is off", `${e instanceof Error ? e.message : String(e)}\n\nThe shift is open again without it.`);
      }
      router.push("/shift");
    } catch (e) {
      Alert.alert("Couldn't reopen the shift", e instanceof Error ? e.message : String(e));
    }
  };

  const totalSelected = chosen.reduce((n, id) => n + (dayCounts[id] ?? 0), 0);

  const confirmHide = (id: string) => {
    Alert.alert(
      `Hide ${id}?`,
      "It leaves the route list and Select all until you activate it again from Manage routes. Nothing is deleted.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Hide",
          onPress: () => {
            registry.hide(id).catch((e: unknown) =>
              Alert.alert("Couldn't hide the route", e instanceof Error ? e.message : String(e)));
          },
        },
      ],
    );
  };

  if (!ready || !reg.ready) {
    return (
      <View style={styles.center}>
        <Text style={styles.dim}>Loading…</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {reg.error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{reg.error}</Text>
        </View>
      )}

      {state && !state.finishedAt && (
        <Pressable style={[styles.card, styles.resumeCard]} onPress={onResume}>
          <Text style={styles.resumeTitle}>Shift in progress</Text>
          <Text style={styles.resumeSub}>
            {state.deliveredIds.length} delivered · tap to continue
          </Text>
        </Pressable>
      )}

      {!state && canReopen(closed, Date.now()) && (
        <Pressable style={[styles.card, styles.resumeCard]} onPress={onReopen}>
          <Text style={styles.resumeTitle}>Ended by mistake? Reopen the shift</Text>
          <Text style={styles.resumeSub}>
            {closed.state.routeIds.join(" · ")} ended at {new Date(closed.closedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            {" "}· {closed.state.deliveredIds.length} ticked. Reopening puts it back as it was and takes it out of the reports.
          </Text>
        </Pressable>
      )}

      <Text style={styles.section}>Night you're out</Text>
      <View style={styles.dayRow}>
        {NIGHT_INDEXES.map((i) => {
          const isSelected = i === nightIdx;
          const isRealNight = i === realNight;
          return (
            <Pressable
              key={i}
              style={[styles.dayPill, isSelected && styles.dayPillActive]}
              onPress={() => setNightIdx(i)}
            >
              <Text style={[styles.dayPillText, isSelected && styles.dayPillTextActive]}>{DAY_NAMES[i]}</Text>
              <Text style={[styles.dayPillSub, isSelected && styles.dayPillTextActive]}>{DAY_NAMES[paperDayOfNight(i)]} paper</Text>
              {isRealNight && <View style={[styles.dayPillDot, isSelected && styles.dayPillDotOnActive]} />}
            </Pressable>
          );
        })}
      </View>
      {nightIdx !== realNight && (
        <Pressable style={styles.linkBtn} onPress={() => setNightIdx(realNight)}>
          <Text style={styles.linkText}>Reset to tonight ({nightText(realNight)})</Text>
        </Pressable>
      )}

      <Text style={styles.section}>Pick routes · {nightText(nightIdx)}</Text>

      {routes.map((r) => {
        const isOn = selected.has(r.id);
        const today = dayCounts[r.id] ?? 0;
        const total = counts[r.id] ?? 0;
        const metaText = today === total
          ? `${r.city} · ${r.postalPrefix} · ${total} stops`
          : `${r.city} · ${r.postalPrefix} · ${today} today (of ${total})`;
        return (
          <Pressable
            key={r.id}
            style={[styles.card, isOn && styles.cardOn]}
            onPress={() => toggle(r.id)}
          >
            <View style={styles.rowBetween}>
              <View>
                <Text style={styles.routeCode}>{r.id}</Text>
                <Text style={styles.routeMeta}>{metaText}</Text>
                <Pressable onPress={() => confirmHide(r.id)} hitSlop={10}>
                  <Text style={styles.hideLink}>Hide route</Text>
                </Pressable>
              </View>
              <View style={[styles.checkbox, isOn && styles.checkboxOn]}>
                {isOn && <Text style={styles.checkmark}>✓</Text>}
              </View>
            </View>
          </Pressable>
        );
      })}

      <Pressable style={styles.linkBtn} onPress={selectAll}>
        <Text style={styles.linkText}>Select all {routes.length}</Text>
      </Pressable>

      <Pressable style={styles.addRouteBtn} onPress={() => router.push("/import" as never)}>
        <Text style={styles.addRouteText}>Add route from PDF</Text>
      </Pressable>

      <Pressable style={styles.addRouteBtn} onPress={() => router.push("/search" as never)}>
        <Text style={styles.addRouteText}>Search houses · stop or resume</Text>
      </Pressable>

      <Pressable style={styles.addRouteBtn} onPress={() => router.push("/add-house" as never)}>
        <Text style={styles.addRouteText}>Add a house (new start)</Text>
      </Pressable>

      <Pressable style={styles.addRouteBtn} onPress={() => router.push("/reminders" as never)}>
        <Text style={styles.addRouteText}>Notifications and nightly reminder</Text>
      </Pressable>

      <Pressable style={styles.earningsBtn} onPress={() => router.push("/earnings" as never)}>
        <Text style={styles.earningsText}>Earnings and reports</Text>
      </Pressable>

      <Pressable style={styles.pausedBanner} onPress={() => router.push("/routes" as never)}>
        <Text style={styles.pausedBannerText}>
          {managedCount === 0
            ? "No routes hidden · manage routes"
            : `${managedCount} route${managedCount === 1 ? "" : "s"} hidden or removed · manage routes`}
        </Text>
      </Pressable>

      <Pressable style={styles.pausedBanner} onPress={() => router.push("/paused" as never)}>
        <Text style={styles.pausedBannerText}>
          {pausedCount === 0
            ? "No houses stopped · tap to manage"
            : `${pausedCount} house${pausedCount === 1 ? "" : "s"} stopped · tap to manage`}
        </Text>
      </Pressable>

      <Text style={styles.section}>Start from</Text>
      <View style={styles.dayRow}>
        {([["library", "Library"], ["gps", "My location"]] as const).map(([key, label]) => {
          const isSelected = startFrom === key;
          return (
            <Pressable
              key={key}
              style={[styles.dayPill, isSelected && styles.dayPillActive]}
              onPress={() => setStartFrom(key)}
            >
              <Text style={[styles.dayPillText, isSelected && styles.dayPillTextActive]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.summary}>
        <Text style={styles.summaryText}>
          {chosen.length === 0
            ? "No routes selected"
            : `${totalSelected} stops · ${formatMoney(totalSelected * rateCents)} due · start from ${startFrom === "gps" ? "your current location" : LIBRARY.name}`}
        </Text>
      </View>

      <Pressable
        style={[styles.primary, !canStart && styles.primaryDisabled]}
        onPress={onStart}
        disabled={!canStart}
      >
        <Text style={styles.primaryText}>
          {state ? "Reset first" : busy ? (startFrom === "gps" ? "Finding you…" : "Planning…") : "Start shift"}
        </Text>
      </Pressable>

      {state && (
        <Pressable style={styles.dangerBtn} onPress={reset}>
          <Text style={styles.dangerText}>Reset today's shift</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content: { padding: 16, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0a0a0a" },
  dim: { color: "#888" },
  section: { color: "#aaa", fontSize: 14, textTransform: "uppercase", letterSpacing: 1, marginTop: 8, marginBottom: 4 },
  card: {
    backgroundColor: "#161616",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#222",
  },
  cardOn: { borderColor: "#4ade80", backgroundColor: "#0f1a12" },
  resumeCard: { backgroundColor: "#1a1305", borderColor: "#facc15" },
  resumeTitle: { color: "#facc15", fontSize: 18, fontWeight: "700" },
  resumeSub: { color: "#c9a83a", marginTop: 4 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  routeCode: { color: "#f5f5f5", fontSize: 20, fontWeight: "700" },
  routeMeta: { color: "#888", fontSize: 14, marginTop: 4 },
  checkbox: {
    width: 32, height: 32, borderRadius: 8,
    borderWidth: 2, borderColor: "#333",
    alignItems: "center", justifyContent: "center",
  },
  checkboxOn: { backgroundColor: "#4ade80", borderColor: "#4ade80" },
  checkmark: { color: "#0a0a0a", fontSize: 20, fontWeight: "700" },
  linkBtn: { paddingVertical: 8, alignItems: "center" },
  linkText: { color: "#60a5fa", fontSize: 14 },
  dayRow: { flexDirection: "row", gap: 6, marginTop: 4 },
  dayPill: {
    flex: 1, paddingVertical: 10, borderRadius: 10,
    backgroundColor: "#161616", borderWidth: 1, borderColor: "#222",
    alignItems: "center", justifyContent: "center",
  },
  dayPillActive: { backgroundColor: "#facc15", borderColor: "#facc15" },
  dayPillText: { color: "#aaa", fontSize: 13, fontWeight: "600" },
  dayPillTextActive: { color: "#0a0a0a", fontWeight: "700" },
  dayPillSub: { color: "#666", fontSize: 9, marginTop: 2 },
  dayPillDot: {
    width: 4, height: 4, borderRadius: 2, backgroundColor: "#4ade80", marginTop: 4,
  },
  dayPillDotOnActive: { backgroundColor: "#0a0a0a" },
  pausedBanner: {
    backgroundColor: "#1a1a1a", borderRadius: 10, padding: 12,
    borderWidth: 1, borderColor: "#2a2a2a", alignItems: "center",
  },
  pausedBannerText: { color: "#aaa", fontSize: 13 },
  addRouteBtn: {
    backgroundColor: "#1a1a1a", borderRadius: 10, padding: 14, alignItems: "center",
    borderWidth: 1, borderColor: "#60a5fa",
  },
  addRouteText: { color: "#60a5fa", fontSize: 15, fontWeight: "700" },
  earningsBtn: {
    backgroundColor: "#1a1a1a", borderRadius: 10, padding: 14, alignItems: "center",
    borderWidth: 1, borderColor: "#4ade80",
  },
  earningsText: { color: "#4ade80", fontSize: 15, fontWeight: "700" },
  hideLink: { color: "#666", fontSize: 12, marginTop: 8 },
  errorBox: { backgroundColor: "#2a0f0f", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: "#f87171" },
  errorText: { color: "#fca5a5", fontSize: 13 },

  summary: { paddingVertical: 8 },
  summaryText: { color: "#aaa", textAlign: "center" },
  primary: {
    backgroundColor: "#4ade80",
    borderRadius: 12,
    padding: 18,
    alignItems: "center",
    marginTop: 8,
  },
  primaryDisabled: { backgroundColor: "#333" },
  primaryText: { color: "#0a0a0a", fontSize: 18, fontWeight: "700" },
  dangerBtn: { paddingVertical: 12, alignItems: "center", marginTop: 4 },
  dangerText: { color: "#f87171", fontSize: 14 },
});
