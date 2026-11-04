#!/usr/bin/env python3
"""Writes a synthetic "ROUTE DELIVERY LIST REPORT" PDF from the demo subscribers, in the layout the
importer reads (src/lib/pdfRouteList.ts). For filming the import; every name and address is invented.

  python3 -m venv venv && venv/bin/pip install reportlab
  venv/bin/python demo/make-depot-pdf.py [--rotate] [out.pdf]

--rotate stores each page rotated 90 degrees, the way the real depot prints them.
"""
import re
import sys
from pathlib import Path
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parent.parent
rotate = "--rotate" in sys.argv
args = [a for a in sys.argv[1:] if not a.startswith("--")]
out = Path(args[0]) if args else ROOT / "demo" / ("night-route-delivery-list-rotated.pdf" if rotate else "night-route-delivery-list.pdf")

ROW = re.compile(r'\{ id: "[^"]+", routeId: "([^"]+)", name: "([^"]+)", address: "([^"]+)", postal: "([^"]+)", city: "([^"]+)", schedule: "([^"]+)"')
subs = [m.groups() for m in map(ROW.search, (ROOT / "src/data/subscribers.ts").read_text().splitlines()) if m]
codes = {}
for line in (ROOT / "src/data/routes.ts").read_text().splitlines():
    m = re.search(r'id: "([^"]+)", code: "([^"]+)"', line)
    if m: codes[m.group(1)] = m.group(2)
by_route = {}
for rid, name, addr, postal, city, sched in subs:
    if postal == "PENDING":   # houses the demo has not given a postal code yet still need a plausible one on paper
        prefix = {"A": "N1E", "B": "N1G", "C": "N1H"}[rid[0]]
        h = sum(ord(ch) for ch in addr + name)
        postal = f"{prefix} {h % 9 + 1}{chr(65 + h % 23)}{(h // 7) % 9 + 1}"
    by_route.setdefault(rid, []).append((name, addr, postal, city, sched))

W, H = 612, 792            # upright page
FONT, SIZE, LEAD = "Courier", 8, 11
X_NAME, X_ADDR, X_SCHED = 36, 190, 440
ROWS_PER_PAGE = 58

c = canvas.Canvas(str(out), pagesize=(W, H))
c.setTitle("Route Delivery List Report (synthetic demo)")

def start_page():
    if rotate:
        # the page is stored as a landscape sheet shown turned 90 degrees clockwise
        c.setPageRotation(90)
        c.transform(0, 1, -1, 0, H, 0)   # upright page space -> sideways sheet (a quarter turn counter-clockwise)
    c.setFont(FONT, SIZE)

def text(x, ytop, s, size=SIZE):
    c.setFont(FONT, size)
    c.drawString(x, H - ytop, s)

def table_head(y):
    text(X_NAME, y, "NAME"); text(X_ADDR, y, "ADDRESS"); text(X_SCHED, y, "SCHEDULE")
    text(X_NAME, y + LEAD, "-" * 30); text(X_ADDR, y + LEAD, "-" * 44); text(X_SCHED, y + LEAD, "-" * 10)
    return y + 2 * LEAD

total = 0
first = True
for rid, rows in by_route.items():
    chunks = [rows[i:i + ROWS_PER_PAGE] for i in range(0, len(rows), ROWS_PER_PAGE)]
    for ci, chunk in enumerate(chunks):
        if not first: c.showPage()
        first = False
        start_page()
        text(X_NAME, 40, "ROUTE DELIVERY LIST REPORT", 11)
        text(X_NAME, 60, "ROUTE:"); text(X_NAME + 90, 60, codes[rid])
        y = table_head(84)
        for name, addr, postal, city, sched in chunk:
            text(X_NAME, y, name[:30]); text(X_ADDR, y, f"{addr} {city.upper()} ON {postal}"); text(X_SCHED, y, sched)
            y += LEAD
        if ci == len(chunks) - 1:
            text(X_NAME, y + LEAD, f"ADDRESSES: {len(rows)}")
    total += len(rows)

c.showPage(); start_page()
text(X_NAME, 40, "ROUTE DELIVERY LIST REPORT", 11)
text(X_NAME, 60, "PUBLICATION:"); text(X_NAME + 110, 60, "NIGHT ROUTE DEMO")
text(X_NAME, 90, f"ADDRESSES: {total}")
c.save()
print(f"wrote {out} ({len(by_route)} routes, {total} addresses)")
