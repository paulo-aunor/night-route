import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { applyReminders } from "@/lib/alerts";
import { DEFAULT_REMINDERS, loadReminders, parseTime, saveReminders, timeText } from "@/lib/reminders";
import { DAY_NAMES, NIGHT_INDEXES, paperDayOfNight } from "@/lib/schedule";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function Reminders() {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [on, setOn] = useState(DEFAULT_REMINDERS.on);
  const [time, setTime] = useState(timeText(DEFAULT_REMINDERS.hour, DEFAULT_REMINDERS.minute));
  const [nights, setNights] = useState<number[]>(DEFAULT_REMINDERS.nights);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadReminders()
      .then((s) => { setOn(s.on); setTime(timeText(s.hour, s.minute)); setNights(s.nights); })
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setLoaded(true));
  }, []);

  const toggleNight = (n: number) => setNights((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]));

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const { hour, minute } = parseTime(time);
      const settings = { on, hour, minute, nights };
      const count = await applyReminders(settings);
      await saveReminders(settings);
      setTime(timeText(hour, minute));
      Alert.alert(on ? "Reminder set" : "Reminder off", on ? `${count} night${count === 1 ? "" : "s"} a week, at ${timeText(hour, minute)}.` : "No reminder will be sent.");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Pressable style={styles.backBtn} onPress={() => router.back()}>
        <Text style={styles.backText}>‹ Back</Text>
      </Pressable>
      <Text style={styles.title}>Notifications</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>During a shift</Text>
        <Text style={styles.body}>
          While a shift is open, one notification shows the next house with Delivered and Navigate buttons. Delivered ticks the house
          even with the app closed. When you come within 100 m of the next house after being further away, it also pops an alert. Both
          need notifications allowed for Night Route, and the alert needs the GPS recording on.
        </Text>
      </View>

      <View style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.cardTitle}>Nightly reminder</Text>
          <Switch value={on} onValueChange={setOn} disabled={!loaded} />
        </View>
        <Text style={styles.label}>Time (12:00 to 23:59, on the evening of the night)</Text>
        <TextInput style={styles.input} value={time} onChangeText={setTime} placeholder="8:00 pm" placeholderTextColor="#555" autoCapitalize="none" />
        <Text style={styles.label}>Nights</Text>
        <View style={styles.chips}>
          {NIGHT_INDEXES.map((n) => (
            <Pressable key={n} style={[styles.chip, nights.includes(n) && styles.chipOn]} onPress={() => toggleNight(n)}>
              <Text style={[styles.chipText, nights.includes(n) && styles.chipTextOn]}>{DAY_NAMES[n]}</Text>
              <Text style={[styles.chipSub, nights.includes(n) && styles.chipTextOn]}>{DAY_NAMES[paperDayOfNight(n)]} paper</Text>
            </Pressable>
          ))}
        </View>
        {error && <Text style={styles.error}>{error}</Text>}
        <Pressable style={[styles.primary, (busy || !loaded) && styles.off]} onPress={save} disabled={busy || !loaded}>
          <Text style={styles.primaryText}>Save</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0a0a0a" },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  backBtn: { paddingVertical: 6 },
  backText: { color: "#60a5fa", fontSize: 15 },
  title: { color: "#f5f5f5", fontSize: 22, fontWeight: "700" },
  card: { backgroundColor: "#161616", borderRadius: 12, borderWidth: 1, borderColor: "#222", padding: 14, gap: 8 },
  cardTitle: { color: "#f5f5f5", fontSize: 16, fontWeight: "700" },
  body: { color: "#aaa", fontSize: 13, lineHeight: 19 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  label: { color: "#888", fontSize: 12, marginTop: 4 },
  input: { backgroundColor: "#0a0a0a", color: "#f5f5f5", borderRadius: 10, borderWidth: 1, borderColor: "#222", paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: "#0a0a0a", borderWidth: 1, borderColor: "#222", alignItems: "center" },
  chipOn: { backgroundColor: "#4ade80", borderColor: "#4ade80" },
  chipText: { color: "#aaa", fontSize: 14, fontWeight: "700" },
  chipSub: { color: "#666", fontSize: 10 },
  chipTextOn: { color: "#0a0a0a" },
  error: { color: "#f87171", fontSize: 13, lineHeight: 18 },
  primary: { marginTop: 6, paddingVertical: 14, borderRadius: 12, backgroundColor: "#4ade80", alignItems: "center" },
  primaryText: { color: "#0a0a0a", fontSize: 16, fontWeight: "700" },
  off: { opacity: 0.45 },
});
