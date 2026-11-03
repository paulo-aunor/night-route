import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import AddHouseForm from "@/components/AddHouseForm";
import { useRegistry } from "@/lib/registry";
import { useShift } from "@/lib/shift";

export default function AddHouse() {
  const router = useRouter();
  const reg = useRegistry();
  const { state, ready, addToShift } = useShift();

  if (!ready || !reg.ready) return <Text style={styles.dim}>Loading…</Text>;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Add a house</Text>
        <Text style={styles.sub}>
          A new start. It joins the route's order where it adds the least driving, and Google Maps opens it like any other stop.
          {state ? " A shift is open, so it is added to the stops you have left if it is on that shift's routes." : ""}
        </Text>
        <AddHouseForm
          defaultRouteId={state?.routeIds[0]}
          onAdded={async (house) => {
            const inShift = state ? (await addToShift(house.id)) !== null : false;
            Alert.alert(
              "House added",
              `${house.address} is on route ${house.routeId}.${inShift ? " It is in tonight's shift." : " It will be in the order from the next shift you start."}`,
            );
            router.back();
          }}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content: { padding: 16, gap: 8, paddingBottom: 40 },
  dim: { color: "#888", padding: 16 },
  backBtn: { paddingVertical: 6 },
  backText: { color: "#60a5fa", fontSize: 15 },
  title: { color: "#f5f5f5", fontSize: 22, fontWeight: "700" },
  sub: { color: "#888", fontSize: 13, lineHeight: 18, marginBottom: 6 },
});
