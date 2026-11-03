import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { usePaused } from "@/lib/paused";
import { allSubscribers, useRegistry } from "@/lib/registry";

export default function PausedScreen() {
  const router = useRouter();
  const { paused, togglePaused } = usePaused();
  const reg = useRegistry();

  const pausedSubs = useMemo(
    () => allSubscribers().filter((s) => paused[s.id]).sort((a, b) => a.id.localeCompare(b.id)),
    [paused, reg.state],
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Pressable style={styles.backBtn} onPress={() => router.back()}>
        <Text style={styles.backText}>‹ Back</Text>
      </Pressable>

      <Text style={styles.title}>Stopped houses</Text>
      <Text style={styles.sub}>
        These houses are hidden from every shift until you tap Resume.
      </Text>

      {pausedSubs.length === 0 && (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            No houses stopped. Open any house's note icon in a shift and tap "Stop this house" to pause it.
          </Text>
        </View>
      )}

      {pausedSubs.map((s) => (
        <View key={s.id} style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.address}>{s.address}</Text>
            <Text style={styles.name}>{s.name}</Text>
            <Text style={styles.meta}>{s.routeId} · {s.postal}{s.schedule ? ` · ${s.schedule}` : ""}</Text>
          </View>
          <Pressable style={styles.resumeBtn} onPress={() => togglePaused(s.id)} hitSlop={10}>
            <Text style={styles.resumeText}>Resume</Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content: { padding: 16, gap: 10 },
  backBtn: { paddingVertical: 6, marginBottom: 4 },
  backText: { color: "#60a5fa", fontSize: 15 },
  title: { color: "#f5f5f5", fontSize: 22, fontWeight: "700" },
  sub: { color: "#888", fontSize: 13, marginBottom: 10 },
  empty: {
    padding: 20, backgroundColor: "#161616", borderRadius: 12,
    borderWidth: 1, borderColor: "#222",
  },
  emptyText: { color: "#888", fontSize: 14, lineHeight: 20, textAlign: "center" },
  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    padding: 14, backgroundColor: "#161616", borderRadius: 12,
    borderWidth: 1, borderColor: "#222",
  },
  address: { color: "#f5f5f5", fontSize: 15, fontWeight: "600" },
  name: { color: "#aaa", fontSize: 13, marginTop: 2 },
  meta: { color: "#666", fontSize: 11, marginTop: 4 },
  resumeBtn: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8,
    backgroundColor: "#facc15",
  },
  resumeText: { color: "#0a0a0a", fontSize: 13, fontWeight: "700" },
});
