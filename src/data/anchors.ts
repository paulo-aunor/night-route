// Houses delivered first, in this order, on any shift that includes the route.
// Kept by address (not id) so the rule survives re-importing the route from a PDF.

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();

export const ROUTE_ANCHORS: Record<string, readonly string[]> = {
  C13: [
    "129 ALMA ST N",
    "70 DREW ST",
    "134 ALMA ST N",
    "97 DREW ST",
    "16 JULIA DR",
    "19 JULIA DR",
    "21 JULIA DR",
    "23 JULIA DR",
    "24 JULIA DR",
  ],
};

// Ids of the anchor houses for these routes, in delivery order, found among `subs`.
export function anchorIdsFor(
  routeIds: readonly string[],
  subs: readonly { id: string; routeId: string; address: string }[],
): string[] {
  const out: string[] = [];
  for (const routeId of routeIds) {
    const wanted = ROUTE_ANCHORS[routeId];
    if (!wanted) continue;
    for (const address of wanted) {
      const hit = subs.find((s) => s.routeId === routeId && norm(s.address) === address);
      if (hit) out.push(hit.id);
    }
  }
  return out;
}
