// Commits changes directly to the repo from the browser via GitHub's
// Contents API, replacing the old flow of "local server writes data.js ->
// someone runs git push by hand". The PAT is only ever held in memory for
// the current page load (never localStorage/cookies) - the user re-enters
// it each session when first needed.

const GITHUB_REPO = "netscomm/WorldRoadTrip";
const GITHUB_BRANCH = "main";

let cachedPAT = null;
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
    input.value = "";
    input.focus();
  });
}

async function getPAT() {
  if (cachedPAT) return cachedPAT;
  const token = await _showPatModal();
  if (!token || !token.trim()) throw new Error("GitHub 토큰이 필요합니다.");
  cachedPAT = token.trim();
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
    { headers: { Authorization: `token ${pat}`, Accept: "application/vnd.github+json" } }
  );
  if (!res.ok) {
    throw new Error(`GitHub API 오류 (${res.status}): ${path} 조회 실패`);
  }
  const data = await res.json();
  // The Contents API only inlines base64 content in the GET response for
  // files under 1MB; data.js is well past that, so fall back to the raw
  // file for anything larger (data.encoding === "none" in that case). The
  // sha is still present either way and PUT itself has no such size limit.
  if (data.encoding === "none" || !data.content) {
    const rawRes = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${path}`);
    if (!rawRes.ok) {
      throw new Error(`GitHub raw 콘텐츠 조회 실패 (${rawRes.status}): ${path}`);
    }
    return { content: await rawRes.text(), sha: data.sha };
  }
  return { content: base64ToUtf8(data.content), sha: data.sha };
}

async function githubPutFile(path, newContent, sha, message) {
  const pat = await getPAT();
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `token ${pat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message,
      content: utf8ToBase64(newContent),
      sha,
      branch: GITHUB_BRANCH,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`GitHub API 오류 (${res.status}): ${body.message || path + " 커밋 실패"}`);
  }
  return res.json();
}
