"""Build a real OSRM /table distance matrix for ~340 coords in chunks and
save it as JSON. The public demo caps a single /table call at ~100 points
total, so request each 100-source batch against ALL destinations by using
`sources=` with up to 100 indices while sending every point in the URL.

Writes night-matrix.json keyed by stop ID (plus 'library' at index 0).
"""
import json, re, urllib.request, ssl, time, sys

# Include every sub in the matrix — "ghost" subs stay deliverable, and the user
# toggles them off per-house via the app's Stop feature.
with open("../src/data/subscribers.geocoded.json") as f: geo = json.load(f)
with open("../src/data/subscribers.ts") as f: src = f.read()
subs = [m.group(1) for m in re.finditer(r'\{ id: "([^"]+)", routeId:', src)]
print(f"stops: {len(subs)}")

ids = ["library"] + subs
coords = [(geo["library"]["lng"], geo["library"]["lat"])] + [(geo["stops"][s]["lng"], geo["stops"][s]["lat"]) for s in subs]
n = len(coords)
print(f"total points: {n}")

ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
def fetch(src_idx, dst_idx):
    pts = sorted(set(src_idx) | set(dst_idx))
    idx_to_pos = {i: p for p, i in enumerate(pts)}
    coord_str = ";".join(f"{coords[i][0]:.6f},{coords[i][1]:.6f}" for i in pts)
    s = ";".join(str(idx_to_pos[i]) for i in src_idx)
    d = ";".join(str(idx_to_pos[i]) for i in dst_idx)
    url = f"http://router.project-osrm.org/table/v1/driving/{coord_str}?sources={s}&destinations={d}&annotations=distance"
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent":"night-route/0.1"})
            data = json.loads(urllib.request.urlopen(req, context=ctx, timeout=120).read())
            if data.get("code") != "Ok": raise RuntimeError(f"osrm: {data}")
            return data["distances"]
        except Exception as e:
            print(f"  retry {attempt+1}: {e}")
            time.sleep(2 ** attempt)
    raise RuntimeError("osrm failed after retries")

# Public /table demo caps on total request size + matrix cells; keep each batch ≤ 50x50
BS = 50
matrix = [[0]*n for _ in range(n)]
batches = 0
for a in range(0, n, BS):
    for b in range(0, n, BS):
        src_idx = list(range(a, min(a+BS, n)))
        dst_idx = list(range(b, min(b+BS, n)))
        dists = fetch(src_idx, dst_idx)
        for si, srow in enumerate(src_idx):
            for di, dcol in enumerate(dst_idx):
                v = dists[si][di]
                matrix[srow][dcol] = int(round(v)) if v is not None else 10**9
        batches += 1
        print(f"batch {batches}: rows {a}-{a+len(src_idx)-1} x cols {b}-{b+len(dst_idx)-1} done")
        time.sleep(0.2)  # be nice to the demo server

with open("night-matrix.json", "w") as f:
    json.dump({"ids": ids, "matrix": matrix}, f)
print(f"\nwrote night-matrix.json ({n}x{n})")
