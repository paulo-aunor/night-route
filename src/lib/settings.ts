import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Pay per delivered house, in cents so sums stay exact. Stored with each finished shift, so changing
// the rate later never rewrites old earnings.
const KEY = "@rr/settings/v1";
export const DEFAULT_RATE_CENTS = 35;

type Settings = { rateCents: number };

function parse(raw: string): Settings {
  const v = JSON.parse(raw) as Partial<Settings>;
  if (!v || typeof v.rateCents !== "number" || !Number.isInteger(v.rateCents) || v.rateCents < 0) {
    throw new Error("The saved pay rate isn't in the expected shape.");
  }
  return { rateCents: v.rateCents };
}

export async function loadRateCents(): Promise<number> {
  const raw = await AsyncStorage.getItem(KEY);
  return raw ? parse(raw).rateCents : DEFAULT_RATE_CENTS;
}

export async function saveRateCents(rateCents: number): Promise<void> {
  if (!Number.isInteger(rateCents) || rateCents < 0) throw new Error("The rate must be a whole number of cents, zero or more.");
  await AsyncStorage.setItem(KEY, JSON.stringify({ rateCents }));
}

export const formatMoney = (cents: number): string => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

// "0.35", ".35" or "35c" style input to cents; null when it isn't a money amount.
export function parseDollars(text: string): number | null {
  const m = /^\s*\$?\s*(\d*)(?:\.(\d{0,2}))?\s*$/.exec(text);
  if (!m || (m[1] === "" && (m[2] === undefined || m[2] === ""))) return null;
  const dollars = m[1] === "" ? 0 : parseInt(m[1], 10);
  const cents = m[2] === undefined || m[2] === "" ? 0 : parseInt(m[2].padEnd(2, "0"), 10);
  return dollars * 100 + cents;
}

export function useRate() {
  const [rateCents, setRate] = useState(DEFAULT_RATE_CENTS);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRateCents()
      .then(setRate)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setReady(true));
  }, []);

  const setRateCents = useCallback(async (cents: number) => {
    await saveRateCents(cents);
    setRate(cents);
  }, []);

  return { rateCents, ready, error, setRateCents };
}
