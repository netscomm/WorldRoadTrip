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

# 0610_코르티나담페초.fit ride: these clips' embedded creation_time is 1h
# later than the real capture time (confirmed by the user against actual
# video content), so we shift it back by 1h.
CORRECTION = timedelta(hours=-1)

TARGET_FILES = [
    "DJI_20260610111002_0362_D.MP4",
    "DJI_20260610111012_0363_D.MP4",
    "DJI_20260610111020_0364_D.MP4",
    "DJI_20260610111127_0365_D.MP4",
    "DJI_20260610111428_0366_D.MP4",
    "DJI_20260610111512_0367_D.MP4",
    "DJI_20260610111517_0368_D.MP4",
    "DJI_20260610111521_0369_D.MP4",
    "DJI_20260610111819_0371_D.MP4",
    "DJI_20260610111909_0372_D.MP4",
    "DJI_20260610111936_0373_D.MP4",
    "DJI_20260610114600_0374_D.MP4",
]


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
