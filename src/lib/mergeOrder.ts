// Merge a preferred order (from last shift or seed) with today's eligible stops.
// Kept stops keep their preferred position; newcomers are spliced next to their
// seed-order neighbors instead of dumped at the end. Without the seed anchor,
// switching from a weekday shift to a Fri/Sat shift dumped the FriSat stops at
// the tail instead of nesting them into their geographically-correct positions.
export function mergeOrder(preferred: string[], eligibleIds: string[], seed: string[] | null): string[] {
  const eligible = new Set(eligibleIds);
  const kept = preferred.filter((id) => eligible.has(id));
  const keptSet = new Set(kept);
  const newcomerIds = eligibleIds.filter((id) => !keptSet.has(id));
  if (!newcomerIds.length) return kept;
  if (!seed || !seed.length) return [...kept, ...newcomerIds];

  const seedIndex = new Map<string, number>();
  seed.forEach((id, i) => seedIndex.set(id, i));

  // Insert newcomers in seed order so earlier ones become anchors for later ones.
  const newcomers = [...newcomerIds].sort((a, b) => {
    const ia = seedIndex.get(a) ?? Number.MAX_SAFE_INTEGER;
    const ib = seedIndex.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });

  const result = [...kept];
  const inResult = new Set(result);
  for (const nc of newcomers) {
    const ncIdx = seedIndex.get(nc);
    if (ncIdx === undefined) {
      result.push(nc);
      inResult.add(nc);
      continue;
    }
    // Walk backwards through the seed for the closest already-placed stop; insert
    // after it. If nothing behind is placed, walk forward and insert before.
    let anchor: string | null = null;
    let after = true;
    for (let i = ncIdx - 1; i >= 0; i--) {
      if (inResult.has(seed[i])) { anchor = seed[i]; after = true; break; }
    }
    if (!anchor) {
      for (let i = ncIdx + 1; i < seed.length; i++) {
        if (inResult.has(seed[i])) { anchor = seed[i]; after = false; break; }
      }
    }
    if (!anchor) {
      result.push(nc);
      inResult.add(nc);
      continue;
    }
    const pos = result.indexOf(anchor);
    result.splice(after ? pos + 1 : pos, 0, nc);
    inResult.add(nc);
  }
  return result;
}
