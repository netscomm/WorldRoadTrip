import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from youtube_helpers import (  # noqa: E402
    get_youtube_service, load_youtube_map, save_youtube_map,
)
from googleapiclient.http import MediaFileUpload  # noqa: E402

DJI_DIR = r"F:\DCIM\DJI_001"
DEFAULT_PRIVACY = "unlisted"


def upload_one(youtube, fname):
    path = os.path.join(DJI_DIR, fname)
    media = MediaFileUpload(path, chunksize=-1, resumable=True)
    request_body = {
        "snippet": {"title": fname},
        "status": {"privacyStatus": DEFAULT_PRIVACY},
    }
    request = youtube.videos().insert(part="snippet,status", body=request_body, media_body=media)
    response = request.execute()
    return response["id"]


def main():
    files = sorted(
        f for f in os.listdir(DJI_DIR)
        if f.upper().endswith(".MP4")
    )
    mapping = load_youtube_map()
    youtube = get_youtube_service()

    todo = [f for f in files if f not in mapping]
    print(f"{len(files)} files total, {len(files) - len(todo)} already uploaded, {len(todo)} to go")

    for i, fname in enumerate(todo, 1):
        print(f"[{i}/{len(todo)}] uploading {fname} ...", flush=True)
        try:
            video_id = upload_one(youtube, fname)
        except Exception as e:
            print(f"FAILED: {fname}: {e}", flush=True)
            print("Stopping (likely API quota exceeded or auth issue). "
                  "Re-run this script later to resume from where it left off.", flush=True)
            break
        mapping[fname] = video_id
        save_youtube_map(mapping)
        print(f"OK: {fname} -> {video_id}", flush=True)

    print("Done.", flush=True)


if __name__ == "__main__":
    main()
