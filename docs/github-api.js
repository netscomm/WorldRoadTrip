// Commits changes directly to the repo from the browser via GitHub's
// Contents API, replacing the old flow of "local server writes data.js ->
// someone runs git push by hand". The PAT is only ever held in memory for
// the current page load (never localStorage/cookies) - the user re-enters
// it each session when first needed.

const GITHUB_REPO = "netscomm/WorldRoadTrip";
const GITHUB_BRANCH = "main";

let cachedPAT = null;

function getPAT() {
  if (cachedPAT) return cachedPAT;
  const token = window.prompt(
    "GitHub Personal Access Token을 입력하세요 (이 저장소의 Contents 쓰기 권한 필요, 이 페이지를 새로고침하면 다시 입력해야 합니다):"
  );
  if (!token) throw new Error("GitHub 토큰이 필요합니다.");
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
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`,
    { headers: { Authorization: `token ${getPAT()}`, Accept: "application/vnd.github+json" } }
  );
  if (!res.ok) {
    throw new Error(`GitHub API 오류 (${res.status}): ${path} 조회 실패`);
  }
  const data = await res.json();
  return { content: base64ToUtf8(data.content), sha: data.sha };
}

async function githubPutFile(path, newContent, sha, message) {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `token ${getPAT()}`,
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
