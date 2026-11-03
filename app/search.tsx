import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { searchHouses } from "@/lib/houseSearch";
import { usePaused } from "@/lib/paused";
import { allSubscribers, isAddedHouse, registry, useRegistry } from "@/lib/registry";
import { useShift } from "@/lib/shift";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Find any house without starting a shift: stop it when its paper is cancelled, resume it when it is back.
export default function SearchHouses() {
  const router = useRouter();
  const reg = useRegistry();
  const { paused, togglePaused } = usePaused();
  const { state: shift } = useShift();
  const [query, setQuery] = useState("");
  const results = useMemo(() => searchHouses(allSubscribers(), query), [query, reg.state]);

  const remove = (id: string, address: string) => {
    if (shift) {
      Alert.alert("A shift is open", "Finish or reset tonight's shift before removing a house you added.");
      return;
    }
    Alert.alert("Remove this house?", `${address} was added by hand. Removing it takes it off its route.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => registry.removeAddedHouse(id).catch((e) => Alert.alert("Couldn't remove it", errText(e))) },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Pressable style={styles.backBtn} onPress={() => router.back()}>
        <Text style={styles.backText}>‹ Back</Text>
      </Pressable>
      <Text style={styles.title}>Search houses</Text>
      <Text style={styles.sub}>Stop or resume any house without starting a shift. Stopped houses are left out of every shift.</Text>

      <TextInput
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        placeholder="Address, name or postal code"
        placeholderTextColor="#555"
        autoFocus
        autoCorrect={false}
      />

      {query.trim() !== "" && results.length === 0 && (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No house matches. Is it a new start?</Text>
          <Pressable onPress={() => router.push("/add-house" as never)}><Text style={styles.link}>Add a house</Text></Pressable>
        </View>
      )}

      {results.map((s) => {
        const stopped = !!paused[s.id];
        return (
          <View key={s.id} style={[styles.row, stopped && styles.rowStopped]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.address}>{s.address}</Text>
              <Text style={styles.name}>{s.name}</Text>
              <Text style={styles.meta}>
                {s.routeId} · {s.city}{s.postal ? ` · ${s.postal}` : ""}{s.schedule ? ` · ${s.schedule}` : ""}{stopped ? " · STOPPED" : ""}
              </Text>
              {isAddedHouse(s.id) && (
                <Pressable onPress={() => remove(s.id, s.address)} hitSlop={8}>
                  <Text style={styles.removeText}>Added by hand · Remove</Text>
                </Pressable>
              )}
            </View>
            <Pressable style={[styles.btn, stopped ? styles.resumeBtn : styles.stopBtn]} onPress={() => togglePaused(s.id)} hitSlop={8}>
              <Text style={[styles.btnText, stopped ? styles.resumeText : styles.stopText]}>{stopped ? "Resume" : "Stop"}</Text>
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content: { padding: 16, gap: 10, paddingBottom: 40 },
  backBtn: { paddingVertical: 6, marginBottom: 4 },
  backText: { color: "#60a5fa", fontSize: 15 },
  title: { color: "#f5f5f5", fontSize: 22, fontWeight: "700" },
  sub: { color: "#888", fontSize: 13, marginBottom: 6 },
  input: { backgroundColor: "#161616", color: "#f5f5f5", borderRadius: 10, borderWidth: 1, borderColor: "#222", paddingHorizontal: 12, paddingVertical: 12, fontSize: 16 },
  empty: { padding: 16, backgroundColor: "#161616", borderRadius: 12, borderWidth: 1, borderColor: "#222", gap: 8, alignItems: "center" },
  emptyText: { color: "#888", fontSize: 14 },
  link: { color: "#60a5fa", fontSize: 15 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, backgroundColor: "#161616", borderRadius: 12, borderWidth: 1, borderColor: "#222" },
  rowStopped: { borderColor: "#5b4a0a", backgroundColor: "#1a1708" },
  address: { color: "#f5f5f5", fontSize: 15, fontWeight: "600" },
  name: { color: "#aaa", fontSize: 13, marginTop: 2 },
  meta: { color: "#666", fontSize: 11, marginTop: 4 },
  removeText: { color: "#f87171", fontSize: 11, marginTop: 6 },
  btn: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  stopBtn: { backgroundColor: "#2a1212", borderWidth: 1, borderColor: "#7f1d1d" },
  resumeBtn: { backgroundColor: "#facc15" },
  btnText: { fontSize: 13, fontWeight: "700" },
  stopText: { color: "#f87171" },
  resumeText: { color: "#0a0a0a" },
});
