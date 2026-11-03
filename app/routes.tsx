import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ROUTES } from "@/data/routes";
import { managedRoutes, registry, useRegistry } from "@/lib/registry";
import type { RouteEntry } from "@/lib/registry-core";
import { useShift } from "@/lib/shift";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function ManageRoutes() {
  const reg = useRegistry();
  const { state: shift } = useShift();
  const entries = managedRoutes();

  const run = (job: Promise<void>) =>
    job.catch((e: unknown) => Alert.alert("Couldn't do that", errText(e)));

  const onDelete = (entry: RouteEntry) => {
    const id = entry.route.id;
    if (shift?.routeIds.includes(id)) {
      Alert.alert("A shift is using this route", "Finish or reset today's shift first, then delete it.");
      return;
    }
    const builtInExists = ROUTES.some((r) => r.id === id);
    const body = entry.imported
      ? `Erases the ${entry.stops} imported houses on ${id}. You can import the PDF again any time.${builtInExists ? ` The built-in ${id} stays removed and can be restored.` : ""}`
      : `Removes the built-in ${id} from the app's route list. You can restore it from this screen.`;
    Alert.alert(`Delete ${id}?`, body, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void run(registry.remove(id)) },
    ]);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {reg.error && (
        <View style={styles.errorBox}><Text style={styles.errorText}>{reg.error}</Text></View>
      )}

      <Text style={styles.sub}>
        Hide a route from the home screen when you stop delivering it. It waits here until you activate it or delete it.
      </Text>

      {entries.length === 0 && (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Nothing hidden or removed.</Text>
        </View>
      )}

      {entries.map((entry) => {
        const { route, status, imported, stops } = entry;
        return (
          <View key={`${route.id}-${status}`} style={styles.card}>
            <View style={styles.titleRow}>
              <Text style={styles.title}>{route.id}</Text>
              <Text style={[styles.badge, status === "removed" && styles.badgeRemoved]}>
                {status === "hidden" ? "Hidden" : "Removed"}
              </Text>
            </View>
            <Text style={styles.meta}>
              {route.city} · {route.postalPrefix} · {stops} houses · {imported ? "imported from PDF" : "built in"}
            </Text>
            <View style={styles.actions}>
              {status === "hidden" ? (
                <>
                  <Pressable style={styles.activate} onPress={() => void run(registry.activate(route.id))}>
                    <Text style={styles.activateText}>Activate</Text>
                  </Pressable>
                  <Pressable style={styles.delete} onPress={() => onDelete(entry)}>
                    <Text style={styles.deleteText}>Delete</Text>
                  </Pressable>
                </>
              ) : (
                <Pressable style={styles.activate} onPress={() => void run(registry.restore(route.id))}>
                  <Text style={styles.activateText}>Restore</Text>
                </Pressable>
              )}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content: { padding: 16, gap: 12 },
  sub: { color: "#888", fontSize: 13, lineHeight: 19 },
  empty: { padding: 20, backgroundColor: "#161616", borderRadius: 12, borderWidth: 1, borderColor: "#222" },
  emptyText: { color: "#888", fontSize: 14, textAlign: "center" },
  card: { backgroundColor: "#161616", borderRadius: 12, padding: 16, borderWidth: 1, borderColor: "#222", gap: 8 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { color: "#f5f5f5", fontSize: 20, fontWeight: "700" },
  badge: {
    color: "#facc15", fontSize: 11, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase",
    borderWidth: 1, borderColor: "#facc15", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
  },
  badgeRemoved: { color: "#f87171", borderColor: "#f87171" },
  meta: { color: "#aaa", fontSize: 13 },
  actions: { flexDirection: "row", gap: 10, marginTop: 4 },
  activate: { flex: 1, backgroundColor: "#4ade80", borderRadius: 10, padding: 12, alignItems: "center" },
  activateText: { color: "#0a0a0a", fontSize: 14, fontWeight: "700" },
  delete: { flex: 1, backgroundColor: "#1a1a1a", borderRadius: 10, padding: 12, alignItems: "center", borderWidth: 1, borderColor: "#f87171" },
  deleteText: { color: "#f87171", fontSize: 14, fontWeight: "700" },
  errorBox: { backgroundColor: "#2a0f0f", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: "#f87171" },
  errorText: { color: "#fca5a5", fontSize: 13 },
});
