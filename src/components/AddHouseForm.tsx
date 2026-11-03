import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { buildHouse, cleanHouseInput, findRoadTwin, SCHEDULES, type NewHouseInput, type ScheduleValue } from "@/lib/addHouse";
import { findAddress, nominatimJson, type FoundAddress } from "@/lib/geocode";
import { matrixIdOfHouse } from "@/lib/matrixAlias";
import { allSubscribers, knownCoordinates, registry, visibleRoutes } from "@/lib/registry";
import type { Subscriber } from "@/types";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const CITIES = ["Kitchener", "Waterloo"];

// A new start: look the address up, check the match, add it to a route. The caller decides what else happens
// (a shift in progress gets the house inserted into the stops left).
export default function AddHouseForm({ defaultRouteId, onAdded }: {
  defaultRouteId?: string;
  onAdded: (house: Subscriber) => Promise<void> | void;
}) {
  const routes = visibleRoutes();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [postal, setPostal] = useState("");
  const [city, setCity] = useState(routes.find((r) => r.id === defaultRouteId)?.city ?? "Kitchener");
  const [routeId, setRouteId] = useState(defaultRouteId ?? routes[0]?.id ?? "");
  const [schedule, setSchedule] = useState<ScheduleValue>("Mon-Sat");
  const [found, setFound] = useState<{ match: FoundAddress; sig: string } | null>(null);
  const [busy, setBusy] = useState<"find" | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const input = (): NewHouseInput => ({ name, address, postal, city, routeId, schedule });
  const sig = `${address}|${postal}|${city}`;
  const match = found && found.sig === sig ? found.match : null;   // a changed address needs a new lookup

  const find = async () => {
    setError(null);
    setBusy("find");
    try {
      const c = cleanHouseInput(input());
      const m = await findAddress(
        { address: c.address, city: c.city, postal: c.postal },
        { fetchJson: nominatimJson, sleep: wait, known: knownCoordinates() },
      );
      if (!m) throw new Error(`No match for ${c.address}, ${c.city}. Check the number and street spelling, or add the postal code.`);
      setFound({ match: m, sig });
    } catch (e) {
      setFound(null);
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!match) return;
    setError(null);
    setBusy("add");
    try {
      const house = buildHouse(input(), match.coord, Date.now(), findRoadTwin(match.coord, allSubscribers(), matrixIdOfHouse));
      await registry.addHouse(house);
      await onAdded(house);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.form}>
      <Text style={styles.label}>Route</Text>
      <View style={styles.chips}>
        {routes.map((r) => (
          <Pressable key={r.id} style={[styles.chip, routeId === r.id && styles.chipOn]} onPress={() => setRouteId(r.id)}>
            <Text style={[styles.chipText, routeId === r.id && styles.chipTextOn]}>{r.id}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Address</Text>
      <TextInput style={styles.input} value={address} onChangeText={setAddress} placeholder="14 FAIRVIEW BLVD" placeholderTextColor="#555" autoCapitalize="characters" />

      <Text style={styles.label}>City</Text>
      <View style={styles.chips}>
        {CITIES.map((c) => (
          <Pressable key={c} style={[styles.chip, city === c && styles.chipOn]} onPress={() => setCity(c)}>
            <Text style={[styles.chipText, city === c && styles.chipTextOn]}>{c}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.label}>Postal code (optional)</Text>
      <TextInput style={styles.input} value={postal} onChangeText={setPostal} placeholder="N1G 9G5" placeholderTextColor="#555" autoCapitalize="characters" />

      <Text style={styles.label}>Name (optional)</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Shown on the stop; blank says NEW START" placeholderTextColor="#555" autoCapitalize="characters" />

      <Text style={styles.label}>Gets paper</Text>
      <View style={styles.chips}>
        {SCHEDULES.map((o) => (
          <Pressable key={o.value} style={[styles.chip, schedule === o.value && styles.chipOn]} onPress={() => setSchedule(o.value)}>
            <Text style={[styles.chipText, schedule === o.value && styles.chipTextOn]}>{o.label}</Text>
          </Pressable>
        ))}
      </View>

      {match && (
        <View style={styles.matchBox}>
          <Text style={styles.matchTitle}>Found: check this is the right place</Text>
          <Text style={styles.matchText}>{match.label}</Text>
          <Text style={styles.matchHint}>Google Maps is sent the address you typed, so a wrong match only affects where the stop sits in the order.</Text>
        </View>
      )}
      {error && <Text style={styles.error}>{error}</Text>}

      {match ? (
        <Pressable style={[styles.primary, busy !== null && styles.off]} onPress={add} disabled={busy !== null}>
          {busy === "add" ? <ActivityIndicator color="#0a0a0a" /> : <Text style={styles.primaryText}>Add to route {routeId}</Text>}
        </Pressable>
      ) : (
        <Pressable style={[styles.primary, (busy !== null || !address.trim()) && styles.off]} onPress={find} disabled={busy !== null || !address.trim()}>
          {busy === "find" ? <ActivityIndicator color="#0a0a0a" /> : <Text style={styles.primaryText}>Find address</Text>}
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 8 },
  label: { color: "#888", fontSize: 12, marginTop: 6 },
  input: { backgroundColor: "#161616", color: "#f5f5f5", borderRadius: 10, borderWidth: 1, borderColor: "#222", paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, backgroundColor: "#161616", borderWidth: 1, borderColor: "#222" },
  chipOn: { backgroundColor: "#4ade80", borderColor: "#4ade80" },
  chipText: { color: "#aaa", fontSize: 14, fontWeight: "600" },
  chipTextOn: { color: "#0a0a0a" },
  matchBox: { marginTop: 8, padding: 12, borderRadius: 10, backgroundColor: "#0f1f14", borderWidth: 1, borderColor: "#1f4d2e", gap: 4 },
  matchTitle: { color: "#4ade80", fontSize: 12, fontWeight: "700" },
  matchText: { color: "#f5f5f5", fontSize: 14, lineHeight: 19 },
  matchHint: { color: "#888", fontSize: 11, lineHeight: 15 },
  error: { color: "#f87171", fontSize: 13, lineHeight: 18, marginTop: 4 },
  primary: { marginTop: 10, paddingVertical: 14, borderRadius: 12, backgroundColor: "#4ade80", alignItems: "center" },
  primaryText: { color: "#0a0a0a", fontSize: 16, fontWeight: "700" },
  off: { opacity: 0.45 },
});
