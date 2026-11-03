import { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import {
  addDays, deleteRecord, delivered, duePayCents, kmText, minText, nightLabel, nightOf, nightRecords, paperLabel, payCents,
  routeTotals, totalsOf, useHistory, weekLabel, weekReport, weekStart, type ShiftRecord, type Totals,
} from "@/lib/history";
import { usePaused } from "@/lib/paused";
import { forgetClosed } from "@/lib/reopen";
import { formatMoney, parseDollars, useRate } from "@/lib/settings";
import { useShift } from "@/lib/shift";

const hoursText = (h: number) => {
  const m = Math.round(h * 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const perHour = (v: number | null, f: (n: number) => string) => (v === null ? "n/a" : `${f(v)}/h`);

// "+$3.15", "-0.4 h"; nothing to compare when either side has no figure.
function change(now: number | null, before: number | null, f: (n: number) => string): string | null {
  if (now === null || before === null) return null;
  const d = now - before;
  if (Math.abs(d) < 1e-9) return "same";
  return `${d > 0 ? "+" : "-"}${f(Math.abs(d))}`;
}

function Line({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <View style={styles.lineRight}>
        <Text style={styles.lineValue}>{value}</Text>
        {note ? <Text style={styles.lineNote}>{note}</Text> : null}
      </View>
    </View>
  );
}

function TotalsCard({ title, t, before }: { title: string; t: Totals; before?: Totals | null }) {
  const vs = before && before.shifts > 0 ? before : null;
  const planned = t.plannedM === null ? "n/a" : kmText(t.plannedM) + (t.plannedPartial ? " (some shifts not planned)" : "");
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Line label="Earned" value={formatMoney(t.payCents)} note={vs ? change(t.payCents, vs.payCents, formatMoney) : null} />
      <Line label="Due if every house delivered" value={formatMoney(t.duePayCents)} />
      <Line
        label="Delivered"
        value={`${t.delivered} of ${t.due}`}
        note={t.counted > 0 ? `${t.counted} counted at Shift done` : null}
      />
      <Line label="Stopped houses left out" value={String(t.stopped)} />
      <Line label="Skipped" value={String(t.skipped)} />
      <Line label="Time" value={t.shifts === 0 ? "n/a" : hoursText(t.hours)} note={vs ? change(t.hours, vs.hours, hoursText) : null} />
      <Line
        label="Houses per hour"
        value={perHour(t.housesPerHour, (n) => n.toFixed(1))}
        note={vs ? change(t.housesPerHour, vs.housesPerHour, (n) => n.toFixed(1)) : null}
      />
      <Line
        label="Earnings per hour"
        value={perHour(t.centsPerHour, formatMoney)}
        note={vs ? change(t.centsPerHour, vs.centsPerHour, formatMoney) : null}
      />
      <Line
        label="Distance moved (GPS)"
        value={t.drivenM === null ? "not recorded" : kmText(t.drivenM) + (t.drivenPartial ? " (some shifts not recorded)" : "")}
        note={vs ? change(t.drivenM, vs.drivenM, kmText) : null}
      />
      <Line
        label="Distance covered (estimate)"
        value={t.coveredM === null ? "n/a" : kmText(t.coveredM) + (t.coveredPartial ? " (some shifts not measured)" : "")}
        note={vs ? change(t.coveredM, vs.coveredM, kmText) : null}
      />
      <Line label="Distance per house" value={t.kmPerHouse === null ? "n/a" : `${(t.kmPerHouse * 1000).toFixed(0)} m`} note={vs && t.kmPerHouse !== null && vs.kmPerHouse !== null ? change(t.kmPerHouse * 1000, vs.kmPerHouse * 1000, (n) => `${n.toFixed(0)} m`) : null} />
      <Line label="Planned road distance" value={planned} note={vs ? change(t.plannedM, vs.plannedM, kmText) : null} />
      <Line
        label="Saved by optimizing"
        value={t.optimizations === 0 ? "none" : t.savedM > 50 ? `${kmText(t.savedM)}, ${minText(t.savedM)}` : "no saving"}
        note={t.optimizations === 0 ? null : `${t.optimizations} time${t.optimizations === 1 ? "" : "s"}`}
      />
    </View>
  );
}

// One block per route: how it went by itself, however many routes the shift mixed.
function RouteRows({ records }: { records: readonly ShiftRecord[] }) {
  const totals = routeTotals(records);
  return (
    <>
      {Object.keys(totals).sort().map((route) => {
        const t = totals[route];
        return (
          <View key={route} style={styles.routeRow}>
            <View style={styles.routeHead}>
              <Text style={styles.routeName}>{route}</Text>
              <Text style={styles.routePay}>{formatMoney(t.payCents)}</Text>
            </View>
            <Text style={styles.shiftMeta}>
              {t.delivered} of {t.due} delivered (due {formatMoney(t.duePayCents)})
              {t.minutes === null ? " · time n/a" : ` · ${hoursText(t.minutes / 60)}${t.minutesPartial ? " (some shifts not timed)" : ""}`}
              {t.housesPerHour !== null ? ` · ${t.housesPerHour.toFixed(1)} houses/h` : ""}
              {t.centsPerHour !== null ? ` · ${formatMoney(Math.round(t.centsPerHour))}/h` : ""}
              {t.drivenM !== null ? ` · ${kmText(t.drivenM)} GPS` : ""}
              {t.coveredM !== null ? ` · ${kmText(t.coveredM)} covered` : ""}
              {t.kmPerHouse !== null ? ` · ${Math.round(t.kmPerHouse * 1000)} m per house` : ""}
            </Text>
          </View>
        );
      })}
    </>
  );
}

function RouteTable({ title, records }: { title: string; records: readonly ShiftRecord[] }) {
  if (records.every((r) => Object.keys(r.byRoute).length === 0)) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      <RouteRows records={records} />
      <Text style={styles.hint}>Time and distance go to the route of the house each leg ends at. The drive home isn't counted.</Text>
    </View>
  );
}

function ShiftRow({ r, onRemove }: { r: ShiftRecord; onRemove: (r: ShiftRecord) => void }) {
  const hours = (r.finishedAt - r.startedAt) / 3_600_000;
  return (
    <View style={styles.shiftRow}>
      <Text style={styles.shiftRoutes}>{r.routeIds.join(" · ")}</Text>
      <Text style={styles.shiftMeta}>
        {delivered(r)} of {r.due} delivered · {formatMoney(payCents(r))} of {formatMoney(duePayCents(r))} · {hoursText(hours)}
        {r.drivenM !== null ? ` · ${kmText(r.drivenM)} moved (GPS)` : ""}
        {r.coveredM !== null ? ` · ${kmText(r.coveredM)} covered` : ""}
        {r.plannedM !== null ? ` · ${kmText(r.plannedM)} planned` : ""}
        {r.savedM > 50 ? ` · saved ${kmText(r.savedM)}` : ""}
      </Text>
      <Pressable onPress={() => onRemove(r)} hitSlop={8}>
        <Text style={styles.removeText}>Remove from reports</Text>
      </Pressable>
    </View>
  );
}

export default function Earnings() {
  const history = useHistory();
  const { rateCents, ready: rateReady, error: rateError, setRateCents } = useRate();
  const { state } = useShift();
  const { paused } = usePaused();
  const [tab, setTab] = useState<"night" | "week">("night");
  const [weekBack, setWeekBack] = useState(0);
  const [rateText, setRateText] = useState<string | null>(null);

  useFocusEffect(useCallback(() => { history.reload(); }, [history.reload]));

  // For a shift started by mistake. It stops counting in every total; there is no way to bring it back.
  const removeShift = (r: ShiftRecord) => {
    Alert.alert(
      "Remove this shift from the reports?",
      `${r.routeIds.join(" · ")}, ${nightLabel(r.night)}: ${delivered(r)} of ${r.due} delivered, ${formatMoney(payCents(r))}. It stops counting in every total and can't be brought back.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteRecord(r.id);
              await forgetClosed(r.id);
            } catch (e) {
              Alert.alert("Couldn't remove the shift", e instanceof Error ? e.message : String(e));
            }
            history.reload();
          },
        },
      ],
    );
  };

  const tonight = nightOf(Date.now());
  const thisWeek = weekStart(tonight);
  const start = addDays(thisWeek, -7 * weekBack);
  const week = useMemo(() => weekReport(history.records, start), [history.records, start]);
  const lastWeek = useMemo(() => weekReport(history.records, addDays(start, -7)), [history.records, start]);
  const done = useMemo(() => nightRecords(history.records, tonight), [history.records, tonight]);

  // the shift still in progress counts toward tonight too
  const live = state && !state.finishedAt && state.startedAt !== null && nightOf(state.startedAt) === tonight ? state : null;
  const liveDue = live ? live.orderedIds.filter((id) => !paused[id]).length : 0;
  const liveDelivered = live ? live.deliveredIds.length : 0;
  const nightTotals = useMemo(() => totalsOf(done), [done]);

  const saveRate = async () => {
    const cents = parseDollars(rateText ?? "");
    if (cents === null) {
      Alert.alert("That isn't an amount", "Type the pay per house, like 0.35.");
      return;
    }
    try {
      await setRateCents(cents);
      setRateText(null);
    } catch (e) {
      Alert.alert("Couldn't save the rate", e instanceof Error ? e.message : String(e));
    }
  };

  if (!history.ready || !rateReady) {
    return <View style={styles.center}><Text style={styles.dim}>Loading…</Text></View>;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {(history.error || rateError) && (
        <View style={styles.errorBox}><Text style={styles.errorText}>{history.error ?? rateError}</Text></View>
      )}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Pay per house</Text>
        {rateText === null ? (
          <View style={styles.rateRow}>
            <Text style={styles.rateValue}>{formatMoney(rateCents)}</Text>
            <Pressable onPress={() => setRateText((rateCents / 100).toFixed(2))} hitSlop={10}>
              <Text style={styles.linkText}>Change</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.rateRow}>
            <TextInput
              style={styles.input}
              value={rateText}
              onChangeText={setRateText}
              keyboardType="decimal-pad"
              autoFocus
              selectTextOnFocus
            />
            <Pressable onPress={saveRate} hitSlop={10}><Text style={styles.linkText}>Save</Text></Pressable>
            <Pressable onPress={() => setRateText(null)} hitSlop={10}><Text style={styles.dim}>Cancel</Text></Pressable>
          </View>
        )}
        <Text style={styles.hint}>A finished shift keeps the rate it was paid at, so changing this never rewrites old shifts.</Text>
      </View>

      <View style={styles.tabs}>
        {([["night", "Tonight"], ["week", "This week"]] as const).map(([key, label]) => (
          <Pressable key={key} style={[styles.tab, tab === key && styles.tabOn]} onPress={() => setTab(key)}>
            <Text style={[styles.tabText, tab === key && styles.tabTextOn]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      {tab === "night" && (
        <>
          <Text style={styles.section}>{nightLabel(tonight)}</Text>
          {live && (
            <View style={[styles.card, styles.liveCard]}>
              <Text style={styles.liveTitle}>In progress</Text>
              <Text style={styles.liveMeta}>
                {liveDelivered} of {liveDue} delivered · {formatMoney(liveDelivered * rateCents)} earned of {formatMoney(liveDue * rateCents)} due
              </Text>
            </View>
          )}
          {done.length === 0 && !live && <Text style={styles.empty}>No shift recorded for this night yet.</Text>}
          {done.length > 0 && (
            <>
              <TotalsCard title={`${paperLabel(done[0].paperDay)}, finished shifts`} t={nightTotals} />
              <RouteTable title="By route" records={done} />
              {done.map((r) => <ShiftRow key={r.id} r={r} onRemove={removeShift} />)}
            </>
          )}
        </>
      )}

      {tab === "week" && (
        <>
          <View style={styles.weekNav}>
            <Pressable onPress={() => setWeekBack(weekBack + 1)} hitSlop={12}><Text style={styles.navArrow}>‹</Text></Pressable>
            <Text style={styles.weekTitle}>{weekLabel(start)}</Text>
            <Pressable onPress={() => setWeekBack(Math.max(0, weekBack - 1))} hitSlop={12} disabled={weekBack === 0}>
              <Text style={[styles.navArrow, weekBack === 0 && styles.navOff]}>›</Text>
            </Pressable>
          </View>
          {week.nights.length === 0 && <Text style={styles.empty}>No finished shifts in this week.</Text>}
          {week.nights.length > 0 && (
            <>
              <TotalsCard title="Week so far" t={week.totals} before={lastWeek.totals} />
              {lastWeek.nights.length === 0 && <Text style={styles.hint}>No shifts the week before to compare with.</Text>}
              <RouteTable title="Week by route" records={week.nights.flatMap((n) => n.records)} />
              <Text style={styles.section}>By night</Text>
              {week.nights.map((n) => (
                <View key={n.night} style={styles.card}>
                  <Text style={styles.cardTitle}>{nightLabel(n.night)} · {paperLabel(n.paperDay)}</Text>
                  <Text style={styles.nightPay}>{formatMoney(n.totals.payCents)} of {formatMoney(n.totals.duePayCents)} due</Text>
                  {n.records.map((r) => <ShiftRow key={r.id} r={r} onRemove={removeShift} />)}
                  <RouteRows records={n.records} />
                </View>
              ))}
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content: { padding: 16, gap: 12 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0a0a0a" },
  dim: { color: "#888" },
  section: { color: "#aaa", fontSize: 14, textTransform: "uppercase", letterSpacing: 1, marginTop: 8 },
  card: { backgroundColor: "#161616", borderRadius: 12, padding: 16, borderWidth: 1, borderColor: "#222", gap: 8 },
  cardTitle: { color: "#f5f5f5", fontSize: 16, fontWeight: "700" },
  hint: { color: "#777", fontSize: 12, lineHeight: 17 },
  empty: { color: "#888", textAlign: "center", paddingVertical: 20 },
  line: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 },
  lineLabel: { color: "#aaa", fontSize: 14, flexShrink: 1 },
  lineRight: { alignItems: "flex-end" },
  lineValue: { color: "#f5f5f5", fontSize: 14, fontWeight: "600" },
  lineNote: { color: "#60a5fa", fontSize: 12, marginTop: 2 },
  routeRow: { borderTopWidth: 1, borderTopColor: "#222", paddingTop: 8, gap: 2 },
  routeHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  routeName: { color: "#f5f5f5", fontSize: 16, fontWeight: "700" },
  routePay: { color: "#4ade80", fontSize: 15, fontWeight: "700" },
  shiftRow: { borderTopWidth: 1, borderTopColor: "#222", paddingTop: 8, gap: 2 },
  shiftRoutes: { color: "#f5f5f5", fontSize: 14, fontWeight: "600" },
  shiftMeta: { color: "#888", fontSize: 12, lineHeight: 17 },
  nightPay: { color: "#4ade80", fontSize: 15, fontWeight: "700" },
  liveCard: { borderColor: "#facc15", backgroundColor: "#1a1305" },
  liveTitle: { color: "#facc15", fontSize: 16, fontWeight: "700" },
  liveMeta: { color: "#c9a83a", fontSize: 14 },
  tabs: { flexDirection: "row", gap: 6 },
  tab: { flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: "#161616", borderWidth: 1, borderColor: "#222", alignItems: "center" },
  tabOn: { backgroundColor: "#facc15", borderColor: "#facc15" },
  tabText: { color: "#aaa", fontSize: 14, fontWeight: "600" },
  tabTextOn: { color: "#0a0a0a", fontWeight: "700" },
  weekNav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  weekTitle: { color: "#f5f5f5", fontSize: 14, fontWeight: "600", flexShrink: 1, textAlign: "center" },
  navArrow: { color: "#60a5fa", fontSize: 30, paddingHorizontal: 8 },
  navOff: { color: "#333" },
  rateRow: { flexDirection: "row", alignItems: "center", gap: 16 },
  rateValue: { color: "#4ade80", fontSize: 22, fontWeight: "700", flex: 1 },
  input: { flex: 1, backgroundColor: "#0a0a0a", color: "#f5f5f5", borderWidth: 1, borderColor: "#333", borderRadius: 8, padding: 10, fontSize: 18 },
  linkText: { color: "#60a5fa", fontSize: 15 },
  removeText: { color: "#f87171", fontSize: 12, marginTop: 4 },
  errorBox: { backgroundColor: "#2a0f0f", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: "#f87171" },
  errorText: { color: "#fca5a5", fontSize: 13 },
});
