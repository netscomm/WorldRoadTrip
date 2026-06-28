// Uploads a video directly from the browser to YouTube via OAuth (Google
// Identity Services) + the YouTube Data API v3 resumable upload protocol.
// Replaces the old flow of "browser -> local Flask server -> YouTube".
//
// One-time setup (Google Cloud Console, same project as client_secret.json):
// Credentials -> Create Credentials -> OAuth client ID -> Web application ->
// Authorized JavaScript origins: https://netscomm.github.io. The resulting
// Client ID is public (safe to commit) - it's not a secret like the old
// client_secret.json, since this flow never holds a client secret in the
// browser.

const GOOGLE_CLIENT_ID = "REPLACE_WITH_GOOGLE_OAUTH_WEB_CLIENT_ID";
const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024; // must be a multiple of 256KB

let tokenClient = null;
let cachedAccessToken = null;

function getYoutubeAccessToken() {
  return new Promise((resolve, reject) => {
    if (cachedAccessToken) {
      resolve(cachedAccessToken);
      return;
    }
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: YOUTUBE_UPLOAD_SCOPE,
        callback: (resp) => {
          if (resp.error) {
            reject(new Error(`Google 로그인 실패: ${resp.error}`));
            return;
          }
          cachedAccessToken = resp.access_token;
          // Tokens are short-lived; drop the cache a bit before expiry so the
          // next upload re-prompts instead of failing mid-upload.
          setTimeout(() => { cachedAccessToken = null; }, (resp.expires_in - 60) * 1000);
          resolve(cachedAccessToken);
        },
      });
    }
    tokenClient.callback = (resp) => {
      if (resp.error) {
        reject(new Error(`Google 로그인 실패: ${resp.error}`));
        return;
      }
      cachedAccessToken = resp.access_token;
      setTimeout(() => { cachedAccessToken = null; }, (resp.expires_in - 60) * 1000);
      resolve(cachedAccessToken);
    };
    tokenClient.requestAccessToken();
  });
}

async function startResumableSession(accessToken, file, title) {
  const res = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": String(file.size),
      },
      body: JSON.stringify({
        snippet: { title },
        status: { privacyStatus: "unlisted" },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`업로드 세션 시작 실패 (${res.status}): ${await res.text()}`);
  }
  return res.headers.get("Location");
}

async function queryResumeOffset(uploadUrl, totalSize) {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Range": `bytes */${totalSize}` },
  });
  if (res.status === 308) {
    const range = res.headers.get("Range"); // "bytes=0-12345"
    if (range) return Number(range.split("-")[1]) + 1;
    return 0;
  }
  if (res.ok) return totalSize; // already complete
  throw new Error(`업로드 상태 확인 실패 (${res.status})`);
}

async function uploadChunk(uploadUrl, file, start, end, totalSize) {
  const chunk = file.slice(start, end);
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Range": `bytes ${start}-${end - 1}/${totalSize}` },
    body: chunk,
  });
  if (res.status === 308) return { done: false };
  if (res.ok) return { done: true, video: await res.json() };
  throw new Error(`청크 업로드 실패 (${res.status}): ${await res.text()}`);
}

async function uploadVideoToYoutube(file, title, onProgress) {
  const accessToken = await getYoutubeAccessToken();
  const uploadUrl = await startResumableSession(accessToken, file, title);

  let offset = 0;
  const totalSize = file.size;
  while (offset < totalSize) {
    const end = Math.min(offset + UPLOAD_CHUNK_SIZE, totalSize);
    let result;
    try {
      result = await uploadChunk(uploadUrl, file, offset, end, totalSize);
    } catch (e) {
      // One retry after asking YouTube where it actually got to - covers
      // transient network drops mid-chunk without restarting the whole file.
      offset = await queryResumeOffset(uploadUrl, totalSize);
      if (onProgress) onProgress(offset / totalSize);
      continue;
    }
    if (result.done) {
      if (onProgress) onProgress(1);
      return result.video.id;
    }
    offset = end;
    if (onProgress) onProgress(offset / totalSize);
  }
  throw new Error("업로드가 끝나지 않고 종료되었습니다.");
}
