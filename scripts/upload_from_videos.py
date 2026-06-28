import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from youtube_helpers import get_youtube_service, load_youtube_map, save_youtube_map
from googleapiclient.http import MediaFileUpload

SRC_DIR = r"C:\Users\netscomm\Videos\DJI"
DEFAULT_PRIVACY = "unlisted"

FILES = [
    "DJI_20260605170524_0179_D.MP4",
    "DJI_20260607161941_0286_D.MP4",
    "DJI_20260609151250_0318_D.MP4",
    "DJI_20260609203625_0361_D.MP4",
    "DJI_20260611113504_0424_D.MP4",
    "DJI_20260612094106_0453_D.MP4",
]


def upload_one(youtube, path, title):
    media = MediaFileUpload(path, chunksize=4 * 1024 * 1024, resumable=True)
    request_body = {
        "snippet": {"title": title},
        "status": {"privacyStatus": DEFAULT_PRIVACY},
    }
    request = youtube.videos().insert(part="snippet,status", body=request_body, media_body=media)
    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            print(f"  progress: {round(status.progress() * 100, 1)}%", flush=True)
    return response["id"]


def main():
    mapping = load_youtube_map()
    youtube = get_youtube_service()

    todo = [f for f in FILES if f not in mapping]
    print(f"{len(FILES)} files total, {len(FILES) - len(todo)} already uploaded, {len(todo)} to go")

    for i, fname in enumerate(todo, 1):
        src = os.path.join(SRC_DIR, fname)
        print(f"[{i}/{len(todo)}] uploading {fname} ...", flush=True)
        try:
            video_id = upload_one(youtube, src, fname)
        except Exception as e:
            print(f"FAILED: {fname}: {e}", flush=True)
            print("Stopping (likely quota exceeded or auth issue). Re-run later to resume.", flush=True)
            break
        mapping[fname] = video_id
        save_youtube_map(mapping)
        print(f"OK: {fname} -> {video_id}", flush=True)

    print("Done.", flush=True)


if __name__ == "__main__":
    main()
