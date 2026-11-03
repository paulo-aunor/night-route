import type { Subscriber } from "@/types";

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

// Houses whose address, name or postal code contain every word typed, in any order. Words that start a word in the
// address rank first ("12 king" finds 12 King St before 112 Kingsway Dr), then address order.
export function searchHouses(houses: readonly Subscriber[], query: string, limit = 40): Subscriber[] {
  const words = norm(query).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const scored: { h: Subscriber; score: number }[] = [];
  for (const h of houses) {
    const hay = ` ${norm(`${h.address} ${h.name} ${h.postal} ${h.city}`)}`;
    if (!words.every((w) => hay.includes(w))) continue;
    scored.push({ h, score: words.filter((w) => hay.includes(` ${w}`)).length });
  }
  scored.sort((a, b) => b.score - a.score || a.h.address.localeCompare(b.h.address, "en", { numeric: true }));
  return scored.slice(0, limit).map((x) => x.h);
}
