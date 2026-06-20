import json
import os
import re
from datetime import timedelta

import fitparse
from mutagen.mp4 import MP4

SLOPE_THRESHOLD_M = 1.5  # min elevation change over a clip to call it uphill/downhill

FIT_DIR = r"F:\DCIM\FIT files"
DJI_DIR = r"F:\DCIM\DJI_001"
OUT_PATH = r"F:\DCIM\italyroadtrip\docs\data.js"

from datetime import datetime as _datetime

FIT_TO_ITALY = timedelta(hours=2)   # FIT timestamp is UTC -> CEST

# DJI camera clock was set to Korea local time (UTC+9) for the first part of the
# trip, needing a -7h shift to Italy local (CEST, UTC+2). Sometime between
# 2026-06-09 and 2026-06-10 the camera clock switched to (near) Italy local
# time but 1 hour fast (likely CET/UTC+1 instead of CEST/UTC+2), confirmed by
# the user against real capture times for clips on 6/10 and 6/12 (the Carezza
# clip lines up much better with FIT -- 4.25km vs 7.3km from the lake -- once
# shifted back by 1h).
DJI_OFFSET_CUTOVER = _datetime(2026, 6, 10, 0, 0, 0)
DJI_TO_ITALY_BEFORE = timedelta(hours=-7)
DJI_TO_ITALY_AFTER = timedelta(hours=-1)

PALETTE = [
    "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
    "#46f0f0", "#f032e6", "#bcf60c", "#fabebe", "#008080",
]

SEMI_TO_DEG = 180.0 / (2 ** 31)

DJI_NAME_RE = re.compile(r"^DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_(\d+)_D(?:_1)?\.MP4$")


def parse_fit_file(path, color):
    fp = fitparse.FitFile(path)
    points = []
    for rec in fp.get_messages("record"):
        vals = rec.get_values()
        lat = vals.get("position_lat")
        lon = vals.get("position_long")
        ts = vals.get("timestamp")
        alt = vals.get("enhanced_altitude")
        if alt is None:
            alt = vals.get("altitude")
        if lat is None or lon is None or ts is None:
            continue
        local_t = ts + FIT_TO_ITALY
        points.append({
            "t": local_t.isoformat(),
            "lat": lat * SEMI_TO_DEG,
            "lon": lon * SEMI_TO_DEG,
            "alt": alt,
        })
    points.sort(key=lambda p: p["t"])
    return points


def build_tracks():
    tracks = []
    files = sorted(f for f in os.listdir(FIT_DIR) if f.lower().endswith(".fit"))
    for i, fname in enumerate(files):
        color = PALETTE[i % len(PALETTE)]
        points = parse_fit_file(os.path.join(FIT_DIR, fname), color)
        if not points:
            print(f"WARN: no points found in {fname}")
            continue
        tracks.append({
            "id": f"track{i}",
            "file": fname,
            "color": color,
            "points": points,
            "startTime": points[0]["t"],
            "endTime": points[-1]["t"],
        })
        print(f"{fname}: {len(points)} points, {points[0]['t']} -> {points[-1]['t']}")
    return tracks


def nearest_point(track, t_dt):
    from datetime import datetime
    pts = track["points"]
    best = min(pts, key=lambda p: abs(datetime.fromisoformat(p["t"]) - t_dt))
    return best


def interpolate_dt(track, t_dt):
    """Returns (lat, lon, alt) at t_dt, clamped to the track's time range. alt is None
    if altitude data isn't available at the surrounding points."""
    from datetime import datetime
    pts = track["points"]
    times = [datetime.fromisoformat(p["t"]) for p in pts]
    if t_dt <= times[0]:
        return pts[0]["lat"], pts[0]["lon"], pts[0]["alt"]
    if t_dt >= times[-1]:
        return pts[-1]["lat"], pts[-1]["lon"], pts[-1]["alt"]
    lo, hi = 0, len(times) - 1
    while lo < hi - 1:
        mid = (lo + hi) // 2
        if times[mid] <= t_dt:
            lo = mid
        else:
            hi = mid
    a, b = pts[lo], pts[hi]
    ta, tb = times[lo], times[hi]
    if ta == tb:
        return a["lat"], a["lon"], a["alt"]
    frac = (t_dt - ta).total_seconds() / (tb - ta).total_seconds()
    lat = a["lat"] + (b["lat"] - a["lat"]) * frac
    lon = a["lon"] + (b["lon"] - a["lon"]) * frac
    alt = None
    if a["alt"] is not None and b["alt"] is not None:
        alt = a["alt"] + (b["alt"] - a["alt"]) * frac
    return lat, lon, alt


def get_video_duration(path):
    try:
        return MP4(path).info.length
    except Exception as e:
        print(f"WARN: could not read duration for {path}: {e}")
        return None


def classify_slope(start_alt, end_alt):
    if start_alt is None or end_alt is None:
        return "unknown"
    diff = end_alt - start_alt
    if diff > SLOPE_THRESHOLD_M:
        return "uphill"
    if diff < -SLOPE_THRESHOLD_M:
        return "downhill"
    return "flat"


def build_media(tracks):
    from datetime import datetime

    media = []
    files = sorted(f for f in os.listdir(DJI_DIR) if f.upper().endswith(".MP4"))
    matched = 0
    estimated = 0
    for i, fname in enumerate(files):
        m = DJI_NAME_RE.match(fname)
        if not m:
            print(f"WARN: filename doesn't match pattern: {fname}")
            continue
        y, mo, d, h, mi, s, idx = m.groups()
        camera_dt = datetime(int(y), int(mo), int(d), int(h), int(mi), int(s))
        offset = DJI_TO_ITALY_BEFORE if camera_dt < DJI_OFFSET_CUTOVER else DJI_TO_ITALY_AFTER
        italy_dt = camera_dt + offset

        full_path = os.path.join(DJI_DIR, fname)
        duration = get_video_duration(full_path)

        # find a track whose range contains italy_dt
        covering = [t for t in tracks if t["startTime"] <= italy_dt.isoformat() <= t["endTime"]]
        if covering:
            track = covering[0]
            lat, lon, start_alt = interpolate_dt(track, italy_dt)
            slope = "unknown"
            if duration:
                _, _, end_alt = interpolate_dt(track, italy_dt + timedelta(seconds=duration))
                slope = classify_slope(start_alt, end_alt)
            est = False
            matched += 1
        else:
            # nearest point across all tracks
            best_track, best_pt, best_delta = None, None, None
            for t in tracks:
                p = nearest_point(t, italy_dt)
                delta = abs(datetime.fromisoformat(p["t"]) - italy_dt)
                if best_delta is None or delta < best_delta:
                    best_delta, best_track, best_pt = delta, t, p
            track = best_track
            lat, lon = best_pt["lat"], best_pt["lon"]
            slope = "unknown"
            est = True
            estimated += 1

        path = full_path.replace("\\", "/")
        file_url = "file:///" + path

        media.append({
            "id": f"media{i}",
            "type": "video",
            "path": file_url,
            "time": italy_dt.isoformat(),
            "duration": duration,
            "lat": lat,
            "lon": lon,
            "color": track["color"] if track else "#888888",
            "trackId": track["id"] if track else None,
            "estimated": est,
            "slope": slope,
        })

    print(f"media total={len(media)} matched={matched} estimated={estimated}")
    return media


def main():
    tracks = build_tracks()
    media = build_media(tracks)

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write("const TRACKS = ")
        json.dump(tracks, f, ensure_ascii=False)
        f.write(";\nconst MEDIA = ")
        json.dump(media, f, ensure_ascii=False)
        f.write(";\n")
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
