import { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { addBlocked, liveRoads, loadBlocked, makeBlocked, removeBlocked, type BlockedRoad } from "@/lib/blocked";
import { allSubscribers, useRegistry } from "@/lib/registry";
import { normalizeStreet, streetOf } from "@/lib/streets";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const DAY = 86_400_000;
const WHEN = [
  { label: "Until I remove it", days: null },
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
] as const;

// Roads you can't use. The map thinks they're open, so the app has to be told.
export default function Blocked() {
  const router = useRouter();
  const reg = useRegistry();
  const [list, setList] = useState<BlockedRoad[] | null>(null);
  const [query, setQuery] = useState("");
  const [days, setDays] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadBlocked().then(setList).catch((e: unknown) => { setError(errText(e)); setList([]); });
  }, []);

  // the streets the routes deliver on, so a name picked here is one the router will match
  const streets = useMemo(() => {
    const seen = new Map<string, { label: string; houses: number }>();
    for (const s of allSubscribers()) {
      const key = streetOf(s.address);
      const at = seen.get(key);
      if (at) at.houses++;
      else seen.set(key, { label: key, houses: 1 });
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [reg.state]);

  const typed = normalizeStreet(query);
  const matches = typed ? streets.filter((s) => s.label.includes(typed)).slice(0, 8) : [];
  const live = list ? liveRoads(list, Date.now()) : [];

  const add = async (label: string) => {
    setError(null);
    try {
      setList(await addBlocked(makeBlocked(label, Date.now(), days === null ? null : Date.now() + days * DAY)));
      setQuery("");
    } catch (e) {
      setError(errText(e));
    }
  };

  const drop = (b: BlockedRoad) => {
    Alert.alert("Open again?", `${b.label} will be used in the route from the next shift you start.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Open again", onPress: () => { removeBlocked(b.id).then(setList).catch((e: unknown) => setError(errText(e))); } },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Pressable style={styles.backBtn} onPress={() => router.back()}>
        <Text style={styles.backText}>‹ Back</Text>
      </Pressable>
      <Text style={styles.title}>Blocked roads</Text>
      <Text style={styles.sub}>
        A road closed for construction, gated, or one you're not allowed down. The order is planned around it from the next shift you
        start, and any stop it can't avoid is flagged on the list.
      </Text>
      <Text style={styles.hint}>
        One-way streets, turn bans and dead ends are already in the map the distances come from, so they don't need to go here.
      </Text>

      {error && <Text style={styles.error}>{error}</Text>}

      <Text style={styles.section}>Block a road</Text>
      <TextInput
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        placeholder="Street name, e.g. Willow St"
        placeholderTextColor="#555"
        autoCorrect={false}
      />
      <View style={styles.chips}>
        {WHEN.map((w) => (
          <Pressable key={w.label} style={[styles.chip, days === w.days && styles.chipOn]} onPress={() => setDays(w.days)}>
            <Text style={[styles.chipText, days === w.days && styles.chipTextOn]}>{w.label}</Text>
          </Pressable>
        ))}
      </View>
      {matches.map((m) => (
        <Pressable key={m.label} style={styles.match} onPress={() => add(m.label)}>
          <Text style={styles.matchName}>{m.label}</Text>
          <Text style={styles.matchMeta}>{m.houses} house{m.houses === 1 ? "" : "s"} on your routes · tap to block</Text>
        </Pressable>
      ))}
      {typed !== "" && !matches.some((m) => m.label === typed) && (
        <Pressable style={styles.match} onPress={() => add(query)}>
          <Text style={styles.matchName}>{typed}</Text>
          <Text style={styles.matchMeta}>No house of yours is on this road. Tap to block it anyway, if you only drive down it.</Text>
        </Pressable>
      )}

      <Text style={styles.section}>Blocked now</Text>
      {list === null && <Text style={styles.dim}>Loading…</Text>}
      {list !== null && live.length === 0 && <Text style={styles.dim}>No roads blocked.</Text>}
      {live.map((b) => (
        <View key={b.id} style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowName}>{b.label}</Text>
            <Text style={styles.rowMeta}>
              {b.until === null ? "until you remove it" : `until ${new Date(b.until).toLocaleDateString()}`}
              {b.street !== b.label.toUpperCase() ? ` · matched as ${b.street}` : ""}
            </Text>
          </View>
          <Pressable style={styles.openBtn} onPress={() => drop(b)} hitSlop={8}>
            <Text style={styles.openText}>Open again</Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content: { padding: 16, gap: 10, paddingBottom: 40 },
  backBtn: { paddingVertical: 6 },
  backText: { color: "#60a5fa", fontSize: 15 },
  title: { color: "#f5f5f5", fontSize: 22, fontWeight: "700" },
  sub: { color: "#aaa", fontSize: 13, lineHeight: 19 },
  hint: { color: "#777", fontSize: 12, lineHeight: 17 },
  dim: { color: "#888", fontSize: 14 },
  error: { color: "#f87171", fontSize: 13, lineHeight: 18 },
  section: { color: "#aaa", fontSize: 13, textTransform: "uppercase", letterSpacing: 1, marginTop: 12 },
  input: { backgroundColor: "#161616", color: "#f5f5f5", borderRadius: 10, borderWidth: 1, borderColor: "#222", paddingHorizontal: 12, paddingVertical: 12, fontSize: 16 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: "#161616", borderWidth: 1, borderColor: "#222" },
  chipOn: { backgroundColor: "#f87171", borderColor: "#f87171" },
  chipText: { color: "#aaa", fontSize: 13, fontWeight: "600" },
  chipTextOn: { color: "#0a0a0a" },
  match: { padding: 12, backgroundColor: "#161616", borderRadius: 10, borderWidth: 1, borderColor: "#222" },
  matchName: { color: "#f5f5f5", fontSize: 15, fontWeight: "600" },
  matchMeta: { color: "#888", fontSize: 12, marginTop: 2, lineHeight: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, backgroundColor: "#1a0f0f", borderRadius: 12, borderWidth: 1, borderColor: "#7f1d1d" },
  rowName: { color: "#f5f5f5", fontSize: 15, fontWeight: "600" },
  rowMeta: { color: "#888", fontSize: 11, marginTop: 4 },
  openBtn: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: "#facc15" },
  openText: { color: "#0a0a0a", fontSize: 13, fontWeight: "700" },
});
