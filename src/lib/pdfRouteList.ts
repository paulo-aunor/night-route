// Parser for the depot's "ROUTE DELIVERY LIST REPORT" PDF.
//
// Input is the text items pdf.js reports for each page, already mapped into
// upright page coordinates (the depot prints these reports rotated 90 degrees,
// so raw PDF coordinates run sideways). Columns are located from the repeated
// NAME / ADDRESS / SCHEDULE header row, so no fixed-width guessing.
//
// Anything it can't read is returned in `problems`; nothing is dropped quietly.

export type PdfItem = { s: string; x: number; y: number; w: number; page: number };

export type ParsedSub = {
  name: string;
  address: string;      // street line, upper case, may include APT/UNIT
  city: string;
  postal: string;       // "N1G 9G5"
  schedule: string;     // "Mon-Sat", "FriSat", ...
  note?: string;        // "Attn: ..." line printed under the subscriber
};

export type ParsedRoute = {
  code: string;         // "N1A00011"
  subs: ParsedSub[];
  expected: number | null;   // the report's own "ADDRESSES: N" footer
};

export type ParseResult = { routes: ParsedRoute[]; problems: string[] };

export class UnsupportedPdfError extends Error {}

const ROW_GAP = 3;           // items closer than this in y belong to the same printed row
const COL_SLACK = 3;         // x tolerance when assigning items to columns

const CITIES = [
  "ST. JACOBS", "ST JACOBS", "NEW HAMBURG", "KITCHENER", "WATERLOO", "CAMBRIDGE",
  "ELMIRA", "BADEN", "WELLESLEY", "BRESLAU", "CONESTOGO", "HEIDELBERG", "LINWOOD",
  "WOOLWICH", "GUELPH", "FERGUS", "ELORA",
];
const ADDRESS_RE = new RegExp(
  `^(.+?)\\s+(${CITIES.map((c) => c.replace(/\./g, "\\.")).join("|")})\\s+ON\\s+([A-Z]\\d[A-Z]\\s?\\d[A-Z]\\d)$`,
  "i",
);

const DAY = "(?:sun|mon|tue|wed|thu|fri|sat)";
const SCHEDULE_RE = new RegExp(`^(?:${DAY}-${DAY}|(?:${DAY})+)$`, "i");

type Row = { page: number; y: number; items: PdfItem[] };

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

function buildRows(items: PdfItem[]): Row[] {
  const byPage = new Map<number, PdfItem[]>();
  for (const it of items) {
    if (it.s.trim() === "") continue;
    const list = byPage.get(it.page);
    if (list) list.push(it);
    else byPage.set(it.page, [it]);
  }
  const rows: Row[] = [];
  for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
    const sorted = byPage.get(page)!.sort((a, b) => a.y - b.y || a.x - b.x);
    let cur: Row | null = null;
    for (const it of sorted) {
      if (cur && Math.abs(it.y - cur.y) <= ROW_GAP) cur.items.push(it);
      else {
        cur = { page, y: it.y, items: [it] };
        rows.push(cur);
      }
    }
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows;
}


// pdf.js merges neighbouring text into one run, so a name that fills its column
// (30 characters) arrives glued to the address. The report font is fixed-width, so
// a run crossing a column boundary is cut at the matching character position.
function splitAtBoundary(items: PdfItem[], boundary: number): PdfItem[] {
  const out: PdfItem[] = [];
  for (const it of items) {
    const crosses = it.s.length > 1 && it.x < boundary - COL_SLACK && it.x + it.w > boundary + COL_SLACK;
    if (!crosses) { out.push(it); continue; }
    const charW = it.w / it.s.length;
    const k = Math.round((boundary - it.x) / charW);
    if (k <= 0 || k >= it.s.length) { out.push(it); continue; }
    out.push({ ...it, s: it.s.slice(0, k), w: k * charW });
    out.push({ ...it, s: it.s.slice(k), x: it.x + k * charW, w: it.w - k * charW });
  }
  return out;
}

function normalizeSchedule(raw: string): string | null {
  if (!SCHEDULE_RE.test(raw)) return null;
  const cap = (d: string) => d.charAt(0).toUpperCase() + d.slice(1).toLowerCase();
  if (raw.includes("-")) return raw.split("-").map(cap).join("-");
  return (raw.match(/.{3}/g) ?? []).map(cap).join("");
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function normalizePostal(raw: string): string {
  const p = raw.toUpperCase().replace(/\s+/g, "");
  return `${p.slice(0, 3)} ${p.slice(3)}`;
}

export function parseRouteListItems(items: PdfItem[]): ParseResult {
  const rows = buildRows(items);
  const problems: string[] = [];
  const routes = new Map<string, ParsedRoute>();

  let sawTitle = false;
  let cols: { addr: number; sched: number } | null = null;
  let inTable = false;
  let current: ParsedRoute | null = null;
  let lastSub: ParsedSub | null = null;
  let lastPage = -1;
  let grandTotal: number | null = null;

  const routeFor = (code: string): ParsedRoute => {
    let r = routes.get(code);
    if (!r) { r = { code, subs: [], expected: null }; routes.set(code, r); }
    return r;
  };

  for (const row of rows) {
    if (row.page !== lastPage) { inTable = false; lastPage = row.page; }
    const texts = row.items.map((i) => i.s.trim());
    const text = texts.join(" ");

    if (/ROUTE DELIVERY LIST REPORT/i.test(text)) sawTitle = true;

    if (texts[0] === "ROUTE:" && texts[1]) {
      current = routeFor(texts[1]);
      lastSub = null;
      inTable = false;
      continue;
    }
    if (texts[0] === "PUBLICATION:") {
      current = null;
      lastSub = null;
      inTable = false;
      continue;
    }
    const total = /^ADDRESSES:\s*(\d+)/.exec(text);
    if (total) {
      if (current) current.expected = Number(total[1]);
      else grandTotal = Number(total[1]);
      inTable = false;
      continue;
    }
    if (texts.includes("NAME") && texts.includes("ADDRESS") && texts.includes("SCHEDULE")) {
      const addr = row.items.find((i) => i.s.trim() === "ADDRESS")!.x;
      const sched = row.items.find((i) => i.s.trim() === "SCHEDULE")!.x;
      cols = { addr, sched };
      inTable = false;
      continue;
    }
    if (cols && texts.length > 0 && texts.every((t) => /^[-\s]+$/.test(t) && t.includes("-"))) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;

    if (!cols) continue;
    const cells = splitAtBoundary(splitAtBoundary(row.items, cols.addr), cols.sched);
    const nameText = collapse(cells.filter((i) => i.x < cols!.addr - COL_SLACK).map((i) => i.s).join(" "));
    const addrItems = cells.filter((i) => i.x >= cols!.addr - COL_SLACK && i.x < cols!.sched - COL_SLACK);
    const addrText = collapse(addrItems.map((i) => i.s).join(" "));
    const schedItems = cells.filter((i) => i.x >= cols!.sched - COL_SLACK);

    if (addrText === "") {
      if (nameText === "") continue;
      if (/^attn:/i.test(nameText) && lastSub) {
        lastSub.note = lastSub.note ? `${lastSub.note}; ${nameText}` : nameText;
        continue;
      }
      problems.push(`Line with no address: "${nameText}"`);
      continue;
    }

    const m = ADDRESS_RE.exec(addrText);
    if (!m) {
      problems.push(`Couldn't read the address: "${addrText}" (${nameText || "no name"})`);
      continue;
    }
    const schedRaw = schedItems[0]?.s.trim() ?? "";
    const schedule = normalizeSchedule(schedRaw);
    if (!schedule) {
      problems.push(`Unknown delivery schedule "${schedRaw}" for ${m[1]}`);
      continue;
    }
    if (!current) {
      problems.push(`Stop before any ROUTE line: ${m[1]}`);
      continue;
    }

    const sub: ParsedSub = {
      name: nameText.toUpperCase().replace(/[‘’]/g, "'"),
      address: collapse(m[1]).toUpperCase(),
      city: titleCase(m[2]),
      postal: normalizePostal(m[3]),
      schedule,
    };
    current.subs.push(sub);
    lastSub = sub;
  }

  if (!sawTitle) {
    throw new UnsupportedPdfError(
      "This isn't a Route Delivery List report. Driving Order and Active Subscriber List PDFs aren't supported yet.",
    );
  }

  const list = [...routes.values()].filter((r) => r.subs.length > 0 || r.expected);
  if (list.length === 0) throw new UnsupportedPdfError("No delivery stops were found in this PDF.");

  for (const r of list) {
    if (r.expected !== null && r.expected !== r.subs.length) {
      problems.push(`${r.code}: the report says ${r.expected} addresses but ${r.subs.length} were read.`);
    }
  }
  if (grandTotal !== null) {
    const sum = list.reduce((n, r) => n + r.subs.length, 0);
    if (sum !== grandTotal) problems.push(`The report total is ${grandTotal} addresses but ${sum} were read across all routes.`);
  }
  return { routes: list, problems };
}

// "N1A00011" -> "A11", "N1C00003" -> "C3". Falls back to the raw code.
export function deriveRouteId(code: string): string {
  const m = /^N\d([A-Z])0*(\d+)$/.exec(code.trim().toUpperCase());
  return m ? `${m[1]}${m[2]}` : code.trim().toUpperCase();
}
