// Street names, in one form.
//
// The route lists write "BIRCH ST" and "RIVER RD W"; the map writes "Birch Street" and
// "River Road West". A road marked blocked has to be recognised in both, so both are reduced to the
// short, upper-case form: BIRCH ST, RIVER RD W.

const SHORT: Record<string, string> = {
  STREET: "ST", SAINT: "ST", AVENUE: "AVE", ROAD: "RD", DRIVE: "DR", PLACE: "PL", CRESCENT: "CRES",
  BOULEVARD: "BLVD", COURT: "CT", LANE: "LN", TRAIL: "TRL", CIRCLE: "CIR", HIGHWAY: "HWY", PARKWAY: "PKWY",
  TERRACE: "TER", SQUARE: "SQ", GARDENS: "GDNS", HEIGHTS: "HTS", MOUNT: "MT", POINT: "PT", RIDGE: "RDG",
  NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W",
  NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE", SOUTHWEST: "SW",
};

// "River Road West" and "RIVER RD W" both become "RIVER RD W". Empty for a nameless road.
export function normalizeStreet(name: string): string {
  return name
    .toUpperCase()
    .replace(/[.,'’]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => SHORT[w] ?? w)
    .join(" ")
    .trim();
}

// The street part of a delivery address: "208 CEDAR ST E APT A" -> "CEDAR ST E". A half number ("117 1/2 WILLOW ST")
// belongs to the house, not the street.
export function streetOf(address: string): string {
  return normalizeStreet(
    address
      .replace(/^\d+[A-Za-z]?(\s*-\s*\d+[A-Za-z]?)?(\s+\d+\/\d+)?\s+/, "")
      .replace(/\s+(APT|APARTMENT|UNIT|SUITE|STE|#)\s*\S*.*$/i, "")
      .replace(/\s+#\S*.*$/, ""),
  );
}
