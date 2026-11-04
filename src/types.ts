// Built-in routes use their short code (B21, C3, ...); imported routes derive theirs from the PDF.
export type RouteId = string;

export interface Route {
  id: RouteId;
  code: string;
  city: string;
  postalPrefix: string;
}

export interface Subscriber {
  id: string;
  name: string;
  address: string;
  postal: string;
  city: string;
  routeId: RouteId;
  lat: number;
  lng: number;
  schedule?: string;
  note?: string;        // delivery note carried from an imported PDF ("Attn: ...")
  roadTwin?: string;    // a house added by hand: the built-in house whose road distances stand in for it (see addHouse.ts)
}

// One time the order was re-optimized during a shift, with the road distance of the houses still to deliver
// before and after, so the saving can be shown and reported.
export interface Optimization {
  at: number;
  kind: "start" | "reroute";
  houses: number;
  beforeM: number;
  afterM: number;
}

export interface ShiftState {
  date: string;
  routeIds: RouteId[];
  startedAt: number | null;
  finishedAt: number | null;
  deliveredIds: string[];
  deliveredAt?: Record<string, number>;   // when each house was ticked, so time and distance can be told apart by route
  // Compass heading (0-360, degrees from north) the car was travelling when each house was ticked, read from
  // the latest reliable GPS fix on the shift's track. Null means nothing was known at the tick (standing still,
  // no fix yet, or a device that doesn't report heading); Re-route uses it to tell real facing from the inferred one.
  headingAt?: Record<string, number>;
  skippedIds: string[];
  orderedIds: string[];
  deliveryDayIdx?: number;
  // "gps" once the shift started from a live location or was re-routed from one.
  // Those orders are anchored to wherever Paulo was standing, so Shift done does
  // not save them over the library-anchored order for next time.
  startMode?: "library" | "gps";
  startCoord?: { lat: number; lng: number };   // where a shift started from a live location began
  optimizations?: Optimization[];
}
