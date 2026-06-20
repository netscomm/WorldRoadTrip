import json
import os
import shutil
import subprocess
from datetime import datetime, timedelta

DJI_DIR = r"F:\DCIM\DJI_001"
BACKUP_DIR = r"F:\DCIM\DJI_001_metadata_backup"

FFMPEG_DIR = (
    r"C:\Users\netscomm\AppData\Local\Microsoft\WinGet\Packages"
    r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
    r"\ffmpeg-8.1.1-full_build\bin"
)
FFMPEG_PATH = shutil.which("ffmpeg") or os.path.join(FFMPEG_DIR, "ffmpeg.exe")
FFPROBE_PATH = shutil.which("ffprobe") or os.path.join(FFMPEG_DIR, "ffprobe.exe")

# DJI camera clock recorded creation_time 1h later than the real capture
# time for the rest of the trip from 6/10 through 6/12 (confirmed by the
# user against actual video content, first noticed on the 0610_코르티나담페초
# ride), so we shift those back by 1h.
CORRECTION = timedelta(hours=-1)
TARGET_DATE_PREFIXES = ("DJI_20260610", "DJI_20260611", "DJI_20260612")

TARGET_FILES = sorted(
    f for f in os.listdir(DJI_DIR)
    if f.upper().endswith(".MP4") and f.startswith(TARGET_DATE_PREFIXES)
)


def read_creation_time(path):
    out = subprocess.run(
        [FFPROBE_PATH, "-v", "quiet", "-show_entries", "format_tags=creation_time",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return datetime.strptime(out, "%Y-%m-%dT%H:%M:%S.%fZ")


def read_duration(path):
    out = subprocess.run(
        [FFPROBE_PATH, "-v", "quiet", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(out)


def fix_one(fname):
    src = os.path.join(DJI_DIR, fname)
    if not os.path.exists(src):
        print(f"SKIP (not found): {fname}")
        return
    if os.path.exists(os.path.join(BACKUP_DIR, fname)):
        print(f"SKIP (already fixed, backup exists): {fname}")
        return

    old_time = read_creation_time(src)
    new_time = old_time + CORRECTION
    new_time_str = new_time.strftime("%Y-%m-%dT%H:%M:%S.000000Z")

    tmp = src + ".fixtmp.mp4"
    if os.path.exists(tmp):
        os.remove(tmp)

    result = subprocess.run(
        [FFMPEG_PATH, "-y", "-i", src, "-map_metadata", "0", "-c", "copy",
         "-metadata", f"creation_time={new_time_str}",
         "-metadata:s:v:0", f"creation_time={new_time_str}",
         "-metadata:s:a:0", f"creation_time={new_time_str}",
         tmp],
        capture_output=True, text=True,
    )
    if result.returncode != 0 or not os.path.exists(tmp):
        print(f"FAIL: {fname}\n{result.stderr[-2000:]}")
        return

    orig_duration = read_duration(src)
    new_duration = read_duration(tmp)
    if abs(new_duration - orig_duration) > 0.2:
        print(f"FAIL (duration mismatch {new_duration} vs {orig_duration}): {fname}")
        os.remove(tmp)
        return

    verify_time = read_creation_time(tmp)
    if verify_time != new_time:
        print(f"FAIL (verify mismatch {verify_time} != {new_time}): {fname}")
        os.remove(tmp)
        return

    os.makedirs(BACKUP_DIR, exist_ok=True)
    backup_path = os.path.join(BACKUP_DIR, fname)
    shutil.move(src, backup_path)
    shutil.move(tmp, src)
    print(f"OK: {fname}  {old_time.isoformat()}Z -> {new_time.isoformat()}Z  (backup: {backup_path})")


def main():
    for fname in TARGET_FILES:
        fix_one(fname)


if __name__ == "__main__":
    main()
