const GITHUB_REPO = "netscomm/WorldRoadTrip";
const GITHUB_BRANCH = "main";
const PAT_STORAGE_KEY = "gh_pat_worldroadtrip";

let cachedPAT = localStorage.getItem(PAT_STORAGE_KEY) || null;
let _patResolve = null;
let _patReject = null;

// Called by the OK/Cancel buttons wired up in app.js initPatModal()
function _patModalSubmit(val) {
  if (_patResolve) { _patResolve(val); _patResolve = _patReject = null; }
}
function _patModalAbort() {
  if (_patReject) { _patReject(new Error("GitHub 토큰 입력이 취소됐습니다.")); _patResolve = _patReject = null; }
}

function _showPatModal() {
  return new Promise((resolve, reject) => {
    _patResolve = resolve;
    _patReject = reject;
    const modal = document.getElementById("pat-modal");
    const input = document.getElementById("pat-modal-input");
    modal.classList.remove("hidden");
    input.value = cachedPAT || "";
    input.focus();
  });
}

async function getPAT() {
  if (cachedPAT) return cachedPAT;
  const token = await _showPatModal();
  if (!token || !token.trim()) throw new Error("GitHub 토큰이 필요합니다.");
  cachedPAT = token.trim();
  localStorage.setItem(PAT_STORAGE_KEY, cachedPAT);
  return cachedPAT;
}

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function base64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ""))));
}

async function githubGetFile(path) {
  const pat = await getPAT();
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`,
    {
      headers: { Authorization: `token ${pat}`, Accept: "application/vnd.github+json" },
      cache: 'no-store',
    }
  );
  if (!res.ok) {
    if (res.status === 401) { cachedPAT = null; localStorage.removeItem(PAT_STORAGE_KEY); }
    throw new Error(`GitHub API 오류 (${res.status}): ${path} 조회 실패`);
  }
  const data = await res.json();
  if (data.encoding === "none" || !data.content) {
    // Git Blobs API: authenticated + sha-pinned, no CDN caching issues.
    const blobRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/git/blobs/${data.sha}`,
      {
        headers: { Authorization: `token ${pat}`, Accept: "application/vnd.github.raw+json" },
        cache: 'no-store',
      }
    );
    if (!blobRes.ok) {
      throw new Error(`GitHub blob 콘텐츠 조회 실패 (${blobRes.status}): ${path}`);
    }
    return { content: await blobRes.text(), sha: data.sha };
  }
  return { content: base64ToUtf8(data.content), sha: data.sha };
}

// Wraps a read-modify-write on a single file with one automatic retry on
// SHA conflict (409). Each attempt re-reads the file for a fresh SHA so a
// concurrent write or a cached-response mismatch resolves itself.
async function githubUpdateFile(path, transform, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { content, sha } = await githubGetFile(path);
    const newContent = transform(content);
    const pat = await getPAT();
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
      method: "PUT",
      headers: {
        Authorization: `token ${pat}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      cache: 'no-store',
      body: JSON.stringify({ message, content: utf8ToBase64(newContent), sha, branch: GITHUB_BRANCH }),
    });
    if (res.ok) return res.json();
    if (res.status === 409 && attempt === 0) continue; // retry once with fresh SHA
    if (res.status === 401) { cachedPAT = null; localStorage.removeItem(PAT_STORAGE_KEY); }
    const body = await res.json().catch(() => ({}));
    throw new Error(`GitHub API 오류 (${res.status}): ${body.message || path + " 커밋 실패"}`);
  }
}

// Legacy single-shot PUT (used when caller already has a fresh sha)
async function githubPutFile(path, newContent, sha, message) {
  const pat = await getPAT();
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `token ${pat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    cache: 'no-store',
    body: JSON.stringify({ message, content: utf8ToBase64(newContent), sha, branch: GITHUB_BRANCH }),
  });
  if (!res.ok) {
    if (res.status === 401) { cachedPAT = null; localStorage.removeItem(PAT_STORAGE_KEY); }
    const body = await res.json().catch(() => ({}));
    throw new Error(`GitHub API 오류 (${res.status}): ${body.message || path + " 커밋 실패"}`);
  }
  return res.json();
}
