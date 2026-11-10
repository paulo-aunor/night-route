import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { analyzeArchive, loadArchive, type ShiftArchive } from "@/lib/archive";
import type { ShiftAnalysis } from "@/lib/driving";
import { clockText, durationText, kmhText, moreThanPlannedText } from "@/lib/drivingText";
import { kmText, loadHistory, movedOf, nightLabel, paperLabel, type ShiftRecord } from "@/lib/history";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

// One shift, read back from the track it recorded: what was moved against what was planned, where delivery left the
// plan, houses driven past before they were delivered, time, and speed.
export default function Review() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [archive, setArchive] = useState<ShiftArchive | null | undefined>(undefined);
  const [record, setRecord] = useState<ShiftRecord | null>(null);
  const [analysis, setAnalysis] = useState<ShiftAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([loadArchive(String(id)), loadHistory()])
      .then(([a, h]) => {
        setRecord(h.find((r) => r.id === String(id)) ?? null);
        setAnalysis(a ? analyzeArchive(a) : null);
        setArchive(a);
      })
      .catch((e: unknown) => { setError(errText(e)); setArchive(null); });
  }, [id]);

  const back = (
    <Pressable style={styles.backBtn} onPress={() => router.back()}>
      <Text style={styles.backText}>‹ Back</Text>
    </Pressable>
  );
  if (archive === undefined) return <View style={styles.center}><Text style={styles.dim}>Loading…</Text></View>;
  if (error || !archive || !analysis) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {back}
        <Text style={styles.title}>Review</Text>
        <Text style={error ? styles.error : styles.dim}>{error ?? "No GPS track was kept for this shift. Only shifts ended with the recording on, in this version or later, can be reviewed."}</Text>
      </ScrollView>
    );
  }

  const { stats, passes, order, timePerHouse } = analysis;
  const addr = new Map(archive.houses.map((h) => [h.id, h.address]));
  const name = (hid: string) => addr.get(hid) ?? hid;
  const moved = record ? movedOf(record) : null;
  const movedM = moved ? moved.m : stats.movedM;
  const onRoads = moved?.onRoads ?? false;
  const road = archive.road ?? null;
  const plannedM = record?.plannedM ?? null;
  const totalS = (archive.finishedAt - archive.startedAt) / 1000;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {back}
      <Text style={styles.title}>{archive.routeIds.join(" · ")}</Text>
      <Text style={styles.sub}>{record ? `${nightLabel(record.night)} · ${paperLabel(record.paperDay)} · ` : ""}{clockText(archive.startedAt)} to {clockText(archive.finishedAt)}</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Distance</Text>
        <Text style={styles.big}>{kmText(movedM)}</Text>
        <Text style={styles.bigLabel}>
          {onRoads ? "actually moved, along roads a car can use" : "actually moved, straight between GPS fixes"}
        </Text>
        {onRoads && road && <Line label="Straight between GPS fixes" value={kmText(stats.movedM)} note="shorter: it cuts every corner" />}
        {plannedM !== null && (
          <Line label="Planned road distance, for comparison" value={kmText(plannedM)} note={moreThanPlannedText(movedM, plannedM)} />
        )}
        {road === null && (
          <Text style={styles.hint}>Not measured along roads yet. That needs signal and runs when you open the home screen or Earnings, so this figure is straight between the phone's GPS fixes for now.</Text>
        )}
        {road !== null && !onRoads && (
          <Text style={styles.hint}>The routing server could place only {Math.round(road.coverage * 100)}% of the track on roads, too little to use, so this stays the straight-between-fixes figure.</Text>
        )}
        {onRoads && road && road.coverage < 1 && (
          <Text style={styles.hint}>{Math.round(road.coverage * 100)}% of the track was placed on roads; stretches off the map (car parks, private lanes) are left out.</Text>
        )}
        <Text style={styles.hint}>
          Moved counts everything the phone travelled between starting and tapping Shift done: detours, and the drive home if you ended the
          shift at home. Planned is the road distance of the order the app planned, driven exactly, from where the shift started.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Your order against the plan</Text>
        {order === null ? (
          <Text style={styles.hint}>The order planned at the start wasn't kept for this shift.</Text>
        ) : (
          <>
            <Line label="Delivered in the planned order" value={`${order.compared - order.outOfOrder} of ${order.compared}`} note={order.outOfOrder > 0 ? `${order.outOfOrder} out of order` : null} />
            {order.shifts.slice(0, 8).map((s) => (
              <Text key={s.id} style={styles.item}>{name(s.id)}: planned {s.planned + 1}, delivered {s.delivered + 1}</Text>
            ))}
            {order.outOfOrder > 8 && <Text style={styles.hint}>and {order.outOfOrder - 8} more</Text>}
            <Text style={styles.hint}>Houses outside the longest run that stayed in order. Order is by when each house was ticked, so ticking late makes a house look out of place.</Text>
          </>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Houses driven past before delivered</Text>
        <Line label="Houses" value={String(passes.houses)} note={passes.total > passes.houses ? `${passes.total} passes in all` : null} />
        {passes.list.slice(0, 10).map((p) => (
          <Text key={p.id} style={styles.item}>
            {name(p.id)}: {p.before.length} earlier pass{p.before.length === 1 ? "" : "es"}, first at {clockText(p.before[0].t)}, within {Math.round(Math.min(...p.before.map((e) => e.distM)))} m
          </Text>
        ))}
        {passes.houses > 10 && <Text style={styles.hint}>and {passes.houses - 10} more</Text>}
        {passes.unmatched > 0 && <Text style={styles.hint}>{passes.unmatched} ticked house{passes.unmatched === 1 ? "" : "es"} could not be checked: the track never came within 25 m of {passes.unmatched === 1 ? "it" : "them"} near the tick.</Text>}
        <Text style={styles.hint}>A house counts when the track came within 25 m of it, then it was delivered on a later pass. Houses across the street count, and GPS can be 10 m off, so some of these are not real mistakes.</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Time and stops</Text>
        <Line label="Whole shift" value={durationText(totalS)} />
        <Line label="Moving" value={durationText(stats.movingS)} />
        <Line label="Standing in stops of 20 s or more" value={durationText(stats.stoppedS)} note={`${stats.stops} stop${stats.stops === 1 ? "" : "s"}${stats.stops > 0 ? `, longest ${durationText(stats.longestStopS)}` : ""}`} />
        {stats.gapS > 30 && <Line label="No GPS fixes for" value={durationText(stats.gapS)} note="phone asleep, tunnel, or GPS off" />}
        <Line label="Time per house" value={timePerHouse.medianS === null ? "n/a" : `${durationText(timePerHouse.medianS)} typical`} note={timePerHouse.meanS === null ? null : `${durationText(timePerHouse.meanS)} on average over ${timePerHouse.ticked} ticks`} />
        {timePerHouse.slowest.map((h) => <Text key={h.id} style={styles.item}>{name(h.id)}: {durationText(h.s)} since the tick before</Text>)}
        <Text style={styles.hint}>Time per house is the gap between ticks, so it includes the drive to the house. Gaps over 15 minutes are treated as breaks and left out.</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Speed and braking</Text>
        <Line label="Top speed" value={kmhText(stats.topKmh)} />
        <Line label="Average while moving" value={kmhText(stats.avgMovingKmh)} />
        <Line label="Time over 50 km/h" value={durationText(stats.aboveLimitS)} note="the usual city limit; the app has no street speed limits" />
        <Line label="Hard braking" value={String(stats.hardBrakes)} note="slowing by 3 m/s or more each second" />
        <Line label="Hard acceleration" value={String(stats.hardAccels)} />
        <Text style={styles.hint}>The phone reports a position about every 5 seconds, so a short hard stop can be missed or split.</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0a0a0a" },
  dim: { color: "#888", lineHeight: 20 },
  error: { color: "#f87171", lineHeight: 20 },
  backBtn: { paddingVertical: 6 },
  backText: { color: "#60a5fa", fontSize: 15 },
  title: { color: "#f5f5f5", fontSize: 22, fontWeight: "700" },
  sub: { color: "#888", fontSize: 13 },
  card: { backgroundColor: "#161616", borderRadius: 12, padding: 16, borderWidth: 1, borderColor: "#222", gap: 8 },
  cardTitle: { color: "#f5f5f5", fontSize: 16, fontWeight: "700" },
  big: { color: "#4ade80", fontSize: 34, fontWeight: "800" },
  bigLabel: { color: "#aaa", fontSize: 13, marginTop: -6 },
  hint: { color: "#777", fontSize: 12, lineHeight: 17 },
  item: { color: "#bbb", fontSize: 13, lineHeight: 18 },
  line: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12 },
  lineLabel: { color: "#aaa", fontSize: 14, flexShrink: 1 },
  lineRight: { alignItems: "flex-end", flexShrink: 1 },
  lineValue: { color: "#f5f5f5", fontSize: 14, fontWeight: "600" },
  lineNote: { color: "#60a5fa", fontSize: 12, marginTop: 2, textAlign: "right" },
});
