// Commits changes directly to the repo from the browser via GitHub's Git
// Data API (blobs/trees/commits), replacing the old flow of "local server
// writes data.js -> someone runs git push by hand". The PAT is only ever
// held in memory for the current page load (never localStorage/cookies) -
// the user re-enters it each session when first needed.
//
// The simpler Contents API (single PUT with base64 content) only supports
// files under ~1MB for both reading and writing, and data.js is well past
// that (12MB+), so reads fall back to the raw file and writes go through
// the lower-level blob/tree/commit/ref sequence instead.

const GITHUB_REPO = "netscomm/WorldRoadTrip";
const GITHUB_BRANCH = "main";
const GITHUB_API_BASE = `https://api.github.com/repos/${GITHUB_REPO}`;

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

function githubAuthHeaders(extra) {
  return {
    Authorization: `token ${getPAT()}`,
    Accept: "application/vnd.github+json",
    ...extra,
  };
}

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function base64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ""))));
}

async function githubGetFile(path) {
  const res = await fetch(
    `${GITHUB_API_BASE}/contents/${path}?ref=${GITHUB_BRANCH}`,
    { headers: githubAuthHeaders() }
  );
  if (!res.ok) {
    throw new Error(`GitHub API 오류 (${res.status}): ${path} 조회 실패`);
  }
  const data = await res.json();
  if (data.encoding === "none" || !data.content) {
    const rawRes = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${path}`);
    if (!rawRes.ok) {
      throw new Error(`GitHub raw 콘텐츠 조회 실패 (${rawRes.status}): ${path}`);
    }
    return { content: await rawRes.text() };
  }
  return { content: base64ToUtf8(data.content) };
}

async function githubJson(url, options) {
  const res = await fetch(url, {
    ...options,
    headers: githubAuthHeaders({ "Content-Type": "application/json", ...(options && options.headers) }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`GitHub API 오류 (${res.status}): ${body.message || url}`);
  }
  return res.json();
}

// Commits a single file via the Git Data API: read the branch's current
// commit/tree, create a blob for the new content, create a new tree
// layered on the old one with just this path replaced, create a commit
// pointing at it, then fast-forward the branch ref. Works for files of any
// size, unlike the Contents API's single PUT.
async function githubCommitFile(path, newContent, message) {
  const refData = await githubJson(`${GITHUB_API_BASE}/git/ref/heads/${GITHUB_BRANCH}`);
  const latestCommitSha = refData.object.sha;

  const commitData = await githubJson(`${GITHUB_API_BASE}/git/commits/${latestCommitSha}`);
  const baseTreeSha = commitData.tree.sha;

  const blobData = await githubJson(`${GITHUB_API_BASE}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({ content: utf8ToBase64(newContent), encoding: "base64" }),
  });

  const treeData = await githubJson(`${GITHUB_API_BASE}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: [{ path, mode: "100644", type: "blob", sha: blobData.sha }],
    }),
  });

  const newCommitData = await githubJson(`${GITHUB_API_BASE}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: treeData.sha, parents: [latestCommitSha] }),
  });

  await githubJson(`${GITHUB_API_BASE}/git/refs/heads/${GITHUB_BRANCH}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: newCommitData.sha }),
  });

  return newCommitData;
}
