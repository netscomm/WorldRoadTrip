const forceLocalSet = new Set();
// YouTube refuses to embed video in a page loaded from file:// (origin is
// "null"), so on this PC's local copy we always fall back to local
// playback and just offer a link to open YouTube in a new tab instead.
const IS_FILE_ORIGIN = window.location.protocol === 'file:';

function fileUrlToWindowsPath(fileUrl) {
  let p = fileUrl.replace(/^file:\/\/\//, '');
  p = decodeURIComponent(p);
  return p.replace(/\//g, '\\');
}

function getBasename(media) {
  return fileUrlToWindowsPath(media.path).split('\\').pop();
}

MEDIA.forEach((media) => {
  media.youtubeId = (typeof YOUTUBE_MAP !== 'undefined' && YOUTUBE_MAP[getBasename(media)]) || null;
});

// --- New-video/new-track matching, mirroring scripts/build_data.py's
// build_one_media()/build_one_track() now that there's no server to run
// that Python code for us. ---

const BOUNDARY_MATCH_THRESHOLD_MS = 60 * 60 * 1000;
const SLOPE_THRESHOLD_M = 1.5;

const COUNTRY_BOUNDS = [
  ['KR', '한국', 33.0, 39.0, 124.0, 132.0],
  ['IT', '이탈리아', 35.0, 47.5, 6.0, 19.0],
  ['FR', '프랑스', 41.0, 51.5, -5.0, 10.0],
  ['ES', '스페인', 36.0, 44.0, -10.0, 4.0],
  ['US', '미국', 24.0, 49.5, -125.0, -66.0],
];

const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080',
];

function detectCountry(lat, lon) {
  for (const [code, label, latMin, latMax, lonMin, lonMax] of COUNTRY_BOUNDS) {
    if (lat >= latMin && lat <= latMax && lon >= lonMin && lon <= lonMax) return { code, label };
  }
  return { code: 'OTHER', label: '기타' };
}

function nearestTrackPoint(track, dateMs) {
  let best = track.points[0];
  let bestDelta = Math.abs(new Date(best.t).getTime() - dateMs);
  for (const p of track.points) {
    const delta = Math.abs(new Date(p.t).getTime() - dateMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = p;
    }
  }
  return best;
}

function interpolateTrackAt(track, dateMs) {
  const pts = track.points;
  const times = pts.map((p) => new Date(p.t).getTime());
  if (dateMs <= times[0]) return pts[0];
  if (dateMs >= times[times.length - 1]) return pts[pts.length - 1];
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (times[mid] <= dateMs) lo = mid;
    else hi = mid;
  }
  const a = pts[lo];
  const b = pts[hi];
  if (times[lo] === times[hi]) return a;
  const frac = (dateMs - times[lo]) / (times[hi] - times[lo]);
  const lat = a.lat + (b.lat - a.lat) * frac;
  const lon = a.lon + (b.lon - a.lon) * frac;
  const alt = a.alt != null && b.alt != null ? a.alt + (b.alt - a.alt) * frac : null;
  return { lat, lon, alt };
}

function classifySlope(startAlt, endAlt) {
  if (startAlt == null || endAlt == null) return 'unknown';
  const diff = endAlt - startAlt;
  if (diff > SLOPE_THRESHOLD_M) return 'uphill';
  if (diff < -SLOPE_THRESHOLD_M) return 'downhill';
  return 'flat';
}

// Finds where a video belongs on the map: which FIT track covers its
// capture time (or, failing that, the nearest track boundary within an
// hour), plus the slope over its duration.
function matchMediaToTracks(tracks, dateMs, durationSeconds) {
  let covering = tracks.filter((t) => {
    const s = new Date(t.startTime).getTime();
    const e = new Date(t.endTime).getTime();
    return s <= dateMs && dateMs <= e;
  });
  let boundaryMatch = false;
  let bestTrack = null;
  let bestPt = null;
  let bestDelta = null;

  if (covering.length === 0) {
    for (const t of tracks) {
      const p = nearestTrackPoint(t, dateMs);
      const delta = Math.abs(new Date(p.t).getTime() - dateMs);
      if (bestDelta === null || delta < bestDelta) {
        bestDelta = delta;
        bestTrack = t;
        bestPt = p;
      }
    }
    if (bestDelta !== null && bestDelta <= BOUNDARY_MATCH_THRESHOLD_MS) {
      covering = [bestTrack];
      boundaryMatch = true;
    }
  }

  if (covering.length > 0) {
    const track = covering[0];
    const start = interpolateTrackAt(track, dateMs);
    let slope = 'unknown';
    if (durationSeconds) {
      const end = interpolateTrackAt(track, dateMs + durationSeconds * 1000);
      slope = classifySlope(start.alt, end.alt);
    }
    return { lat: start.lat, lon: start.lon, color: track.color, trackId: track.id, estimated: false, slope, boundaryMatch };
  }
  if (bestTrack) {
    return { lat: bestPt.lat, lon: bestPt.lon, color: bestTrack.color, trackId: bestTrack.id, estimated: true, slope: 'unknown', boundaryMatch: false };
  }
  return { lat: null, lon: null, color: '#888888', trackId: null, estimated: true, slope: 'unknown', boundaryMatch: false };
}

function nextMediaId(media) {
  const used = media.filter((m) => m.id.startsWith('media')).map((m) => parseInt(m.id.replace('media', ''), 10));
  return `media${used.length ? Math.max(...used) + 1 : 0}`;
}

function nextTrackId(tracks) {
  const used = tracks.filter((t) => t.id.startsWith('track')).map((t) => parseInt(t.id.replace('track', ''), 10));
  return `track${used.length ? Math.max(...used) + 1 : 0}`;
}

// --- Direct-to-GitHub persistence (replaces "local server writes data.js,
// someone runs git push by hand"). Always re-fetches the file right before
// writing, so a slow upload doesn't commit over someone else's edit. ---

const DATA_JS_PATH = 'docs/data.js';
const YOUTUBE_MAP_PATH = 'docs/youtube_map.js';

function parseDataJs(content) {
  const tracksMatch = content.match(/const TRACKS = (\[.*?\]);(?=\s*const MEDIA = )/s);
  const mediaMatch = content.match(/const MEDIA = (\[.*?\]);\s*\n/s);
  return { tracks: JSON.parse(tracksMatch[1]), media: JSON.parse(mediaMatch[1]) };
}

function buildDataJs(tracks, media) {
  return `const TRACKS = ${JSON.stringify(tracks)};\nconst MEDIA = ${JSON.stringify(media)};\n`;
}

async function commitNewMedia(newMediaWithoutId) {
  const { content } = await githubGetFile(DATA_JS_PATH);
  const { tracks, media } = parseDataJs(content);
  if (media.some((m) => m.path.endsWith('/' + newMediaWithoutId.basename))) {
    throw new Error('이미 추가된 영상입니다.');
  }
  const entry = { id: nextMediaId(media), ...newMediaWithoutId.entry };
  media.push(entry);
  await githubCommitFile(DATA_JS_PATH, buildDataJs(tracks, media), `Add media entry for ${newMediaWithoutId.basename}`);
  return entry;
}

async function commitNewTrack(fname, trackWithoutId) {
  const { content } = await githubGetFile(DATA_JS_PATH);
  const { tracks, media } = parseDataJs(content);
  if (tracks.some((t) => t.file === fname)) {
    throw new Error(`이미 같은 이름(${fname})의 경로가 있습니다.`);
  }
  const entry = { id: nextTrackId(tracks), ...trackWithoutId };
  tracks.push(entry);
  await githubCommitFile(DATA_JS_PATH, buildDataJs(tracks, media), `Add FIT track ${fname}`);
  return entry;
}

async function commitYoutubeMapEntry(basename, videoId) {
  const { content } = await githubGetFile(YOUTUBE_MAP_PATH);
  const m = content.match(/const YOUTUBE_MAP = (\{.*\});/s);
  const map = JSON.parse(m[1]);
  map[basename] = videoId;
  const newContent = `const YOUTUBE_MAP = ${JSON.stringify(map, null, 2)};\n`;
  await githubCommitFile(YOUTUBE_MAP_PATH, newContent, `Add YouTube ID for ${basename}`);
}

const map = L.map('map');

const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19,
}).addTo(map);

const allBounds = [];
const trackLatLngs = {};

TRACKS.forEach((track) => {
  const latlngs = track.points.map((p) => [p.lat, p.lon]);
  L.polyline(latlngs, { color: track.color, weight: 3, opacity: 0.8 }).addTo(map);
  allBounds.push(...latlngs);
  trackLatLngs[track.id] = latlngs;
});

let lockedMedia = null;
const panelEl = document.getElementById('panel');
const panelMediaEl = document.getElementById('panel-media');
const panelInfoEl = document.getElementById('panel-info');
const panelCloseEl = document.getElementById('panel-close');

function addInfoRow(label, value, cls) {
  const row = document.createElement('div');
  row.className = 'info-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'info-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = `info-value ${cls || ''}`;
  valueEl.textContent = value;
  row.appendChild(labelEl);
  row.appendChild(valueEl);
  panelInfoEl.appendChild(row);
  return valueEl;
}

function formatDt(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderPanel(media, locked) {
  panelEl.classList.remove('hidden');
  panelEl.classList.toggle('locked', locked);
  panelMediaEl.innerHTML = '';
  panelInfoEl.innerHTML = '';

  const winPath = fileUrlToWindowsPath(media.path);
  const tag = media.estimated
    ? ' (위치 추정)'
    : media.boundaryMatch
      ? ' (트랙 경계 지점)'
      : '';

  addInfoRow('위도, 경도', `${media.lat.toFixed(6)}, ${media.lon.toFixed(6)}${tag}`);
  addInfoRow('시작 시간', media.time.replace('T', ' '));
  const endValueEl = addInfoRow('종료 시간', media.type === 'photo' ? '-' : '로딩 중...');
  if (media.type === 'video') {
    addInfoRow('경사', SLOPE_LABEL[media.slope] || media.slope);
  }
  if (media.timeSource) {
    addInfoRow('시간 출처', TIME_SOURCE_LABEL[media.timeSource] || media.timeSource);
  }
  addInfoRow('경로', winPath, 'path-text');

  const useYoutube = media.type === 'video' && media.youtubeId && !forceLocalSet.has(media.id) && !IS_FILE_ORIGIN;

  if (media.type === 'photo') {
    const img = document.createElement('img');
    img.src = media.path;
    panelMediaEl.appendChild(img);
  } else if (useYoutube) {
    const iframe = document.createElement('iframe');
    iframe.width = '100%';
    iframe.height = '360';
    iframe.frameBorder = '0';
    iframe.allow = 'autoplay; encrypted-media';
    iframe.allowFullscreen = true;
    const mute = locked ? '0' : '1';
    iframe.src = `https://www.youtube.com/embed/${media.youtubeId}?autoplay=1&mute=${mute}`;
    panelMediaEl.appendChild(iframe);
    endValueEl.textContent = '유튜브 영상 (길이는 유튜브에서 확인)';
  } else {
    const video = document.createElement('video');
    video.src = media.path;
    video.autoplay = true;
    video.muted = !locked;
    video.controls = locked;
    video.loop = !locked;
    video.addEventListener('loadedmetadata', () => {
      if (isFinite(video.duration)) {
        const start = new Date(media.time);
        const end = new Date(start.getTime() + video.duration * 1000);
        endValueEl.textContent = formatDt(end);
      }
    });
    panelMediaEl.appendChild(video);
  }

  if (media.type === 'video') {
    const btnRow = document.createElement('div');
    btnRow.className = 'youtube-btn-row';

    if (media.youtubeId && IS_FILE_ORIGIN) {
      const openBtn = document.createElement('button');
      openBtn.className = 'copy-btn';
      openBtn.textContent = '유튜브에서 보기 (새 탭)';
      openBtn.addEventListener('click', () => {
        window.open(`https://youtu.be/${media.youtubeId}`, '_blank');
      });
      btnRow.appendChild(openBtn);

      const note = document.createElement('div');
      note.className = 'youtube-note';
      note.textContent = 'file://로 연 페이지에서는 유튜브 임베드가 차단되어 로컬 영상으로 재생 중입니다.';
      btnRow.appendChild(note);
    } else if (media.youtubeId) {
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'copy-btn';
      toggleBtn.textContent = forceLocalSet.has(media.id) ? '유튜브로 보기' : '로컬재생';
      toggleBtn.addEventListener('click', () => {
        if (forceLocalSet.has(media.id)) {
          forceLocalSet.delete(media.id);
        } else {
          forceLocalSet.add(media.id);
        }
        renderPanel(media, locked);
      });
      btnRow.appendChild(toggleBtn);
    } else {
      const uploadBtn = document.createElement('button');
      uploadBtn.className = 'copy-btn';
      uploadBtn.textContent = '유튜브에 업로드';

      const progressWrap = document.createElement('div');
      progressWrap.className = 'upload-progress hidden';
      const progressBar = document.createElement('div');
      progressBar.className = 'upload-progress-bar';
      const progressText = document.createElement('span');
      progressText.className = 'upload-progress-text';
      progressWrap.appendChild(progressBar);
      progressWrap.appendChild(progressText);

      uploadBtn.addEventListener('click', () =>
        uploadToYoutube(media, uploadBtn, progressWrap, progressBar, progressText)
      );
      btnRow.appendChild(uploadBtn);
      btnRow.appendChild(progressWrap);
    }

    panelInfoEl.appendChild(btnRow);
  }

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn copy-all-btn';
  copyBtn.textContent = '정보 복사';
  copyBtn.addEventListener('click', () => {
    const lines = Array.from(panelInfoEl.querySelectorAll('.info-row')).map((row) => {
      const label = row.querySelector('.info-label').textContent;
      const value = row.querySelector('.info-value').textContent;
      return `${label}: ${value}`;
    });
    copyPathToClipboard(lines.join('\n'), copyBtn);
  });
  panelInfoEl.appendChild(copyBtn);
}

// Shared by both "유튜브에 업로드" (existing marker) and the new-video file
// picker: uploads to YouTube via OAuth, then commits the YouTube ID.
async function runYoutubeUpload(file, basename, progressBar, progressText) {
  const videoId = await uploadVideoToYoutube(file, basename, (frac) => {
    const pct = Math.round(frac * 100);
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (progressText) progressText.textContent = `업로드 중 ${pct}%`;
  });
  await commitYoutubeMapEntry(basename, videoId);
  return videoId;
}

function uploadToYoutube(media, btn, progressWrap, progressBar, progressText) {
  const basename = getBasename(media);
  const originalText = btn.textContent;

  const fail = (message) => {
    btn.disabled = false;
    btn.textContent = originalText;
    progressWrap.classList.add('hidden');
    alert(`업로드 실패: ${message}`);
  };

  // The browser has no path-based access to local files, so for an
  // existing marker (added by the old local-script flow) we ask the user to
  // re-pick the matching video before we can read its bytes.
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'video/*';
  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    if (!file) return;
    if (file.name !== basename) {
      alert(`선택한 파일이 이 마커와 다릅니다.\n필요한 파일: ${basename}\n선택한 파일: ${file.name}`);
      return;
    }
    btn.disabled = true;
    btn.textContent = '업로드 중...';
    progressWrap.classList.remove('hidden');
    progressBar.style.width = '0%';
    progressText.textContent = '0%';
    try {
      const videoId = await runYoutubeUpload(file, basename, progressBar, progressText);
      media.youtubeId = videoId;
      const marker = markerById[media.id];
      if (marker) marker.setIcon(makeMarkerIcon(media));
      renderPanel(media, true);
    } catch (e) {
      fail(e.message);
    }
  });
  picker.click();
}

function copyPathToClipboard(text, btn) {
  const done = () => {
    const original = btn.textContent;
    btn.textContent = '복사됨!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } finally {
    document.body.removeChild(ta);
  }
}

function hidePanel() {
  panelEl.classList.add('hidden');
  panelEl.classList.remove('locked');
  panelMediaEl.innerHTML = '';
}

function showPreview(media) {
  renderPanel(media, false);
}

function restoreLockedOrHide() {
  if (lockedMedia) {
    renderPanel(lockedMedia, true);
  } else {
    hidePanel();
  }
}

panelCloseEl.addEventListener('click', () => {
  lockedMedia = null;
  hidePanel();
});

const SLOPE_SYMBOL = {
  uphill: '▲',
  downhill: '▼',
  flat: '●',
  unknown: '',
};

const SLOPE_LABEL = {
  uphill: '오르막 ▲',
  downhill: '내리막 ▼',
  flat: '평지 ●',
  unknown: '알 수 없음',
};

const TIME_SOURCE_LABEL = {
  metadata: '영상 메타데이터 (creation_time)',
  filename_fallback: '파일명 (메타데이터 없음)',
  exif: '사진 EXIF',
};

function makeMarkerIcon(media) {
  const symbol = SLOPE_SYMBOL[media.slope] || '';
  const borderStyle = media.estimated ? 'dashed' : 'solid';
  const opacity = media.estimated ? 0.55 : 1;
  const badge = media.youtubeId ? '<div class="youtube-badge">▶</div>' : '';
  const html = `<div class="media-marker" style="background:${media.color};border-style:${borderStyle};opacity:${opacity}">${symbol}${badge}</div>`;
  return L.divIcon({ html, className: 'media-marker-wrap', iconSize: [16, 16], iconAnchor: [8, 8] });
}

const markerById = {};

// Several clips that fall outside every FIT track snap to the same nearest
// boundary point (see matchMediaToTracks's estimated/boundaryMatch path),
// which stacks their markers exactly on top of each other - the one on top
// hides the rest with no visual sign anything else is there. Nudge each
// marker after the first sharing a coordinate out along a small ring so
// they're all clickable. media.lat/lon (the real matched position) is left
// untouched; only the marker's plotted position moves.
const overlapGroupCounts = {};
function getDisplayPosition(media) {
  const key = `${media.lat},${media.lon}`;
  const idx = overlapGroupCounts[key] || 0;
  overlapGroupCounts[key] = idx + 1;
  if (idx === 0) {
    media._displayLat = media.lat;
    media._displayLon = media.lon;
    return [media.lat, media.lon];
  }
  const ringSize = 8;
  const radiusMeters = 20 * Math.ceil(idx / ringSize);
  const angle = ((idx - 1) % ringSize) * ((2 * Math.PI) / ringSize);
  const dLat = (radiusMeters / 111320) * Math.cos(angle);
  const dLon = (radiusMeters / (111320 * Math.cos((media.lat * Math.PI) / 180))) * Math.sin(angle);
  media._displayLat = media.lat + dLat;
  media._displayLon = media.lon + dLon;
  return [media._displayLat, media._displayLon];
}

function focusMedia(media) {
  // 18, not 15: at the old default zoom a 20m nudge (see getDisplayPosition)
  // wasn't visually distinguishable from the marker it was separated from.
  map.setView([media._displayLat ?? media.lat, media._displayLon ?? media.lon], Math.max(map.getZoom(), 18));
  lockedMedia = media;
  renderPanel(media, true);
}

MEDIA.forEach((media) => {
  addMediaMarker(media);
  allBounds.push([media.lat, media.lon]);
});

if (allBounds.length) {
  map.fitBounds(allBounds, { padding: [20, 20] });
} else {
  map.setView([46.4, 11.3], 9);
}

const legendEl = document.getElementById('legend');

const legendHeaderEl = document.createElement('div');
legendHeaderEl.id = 'legend-header';
const legendTitle = document.createElement('div');
legendTitle.className = 'legend-title';
legendTitle.textContent = 'FIT 트랙 (클릭하면 해당 구간으로 이동)';
const legendToggleBtn = document.createElement('button');
legendToggleBtn.id = 'legend-toggle';
legendHeaderEl.appendChild(legendTitle);
legendHeaderEl.appendChild(legendToggleBtn);
legendEl.appendChild(legendHeaderEl);

const legendBodyEl = document.createElement('div');
legendBodyEl.id = 'legend-body';
legendEl.appendChild(legendBodyEl);

const LEGEND_COLLAPSED_KEY = 'legendCollapsed';
function setLegendCollapsed(collapsed) {
  legendEl.classList.toggle('collapsed', collapsed);
  legendToggleBtn.textContent = collapsed ? '▸' : '▾';
  localStorage.setItem(LEGEND_COLLAPSED_KEY, collapsed ? '1' : '0');
}
legendToggleBtn.addEventListener('click', () => {
  setLegendCollapsed(!legendEl.classList.contains('collapsed'));
});
setLegendCollapsed(localStorage.getItem(LEGEND_COLLAPSED_KEY) === '1');

const legendCountryTabsEl = document.createElement('div');
legendCountryTabsEl.id = 'legend-country-tabs';
legendBodyEl.appendChild(legendCountryTabsEl);

const legendTracksEl = document.createElement('div');
legendTracksEl.id = 'legend-tracks';
legendBodyEl.appendChild(legendTracksEl);

const countries = [];
TRACKS.forEach((track) => {
  if (!countries.some((c) => c.code === track.country)) {
    countries.push({ code: track.country, label: track.countryLabel });
  }
});

let activeCountry = countries.length ? countries[0].code : null;

function renderTrackRows(country) {
  legendTracksEl.innerHTML = '';
  TRACKS.filter((track) => track.country === country).forEach((track) => {
    const row = document.createElement('div');
    row.className = 'row clickable';
    row.innerHTML = `<span class="swatch" style="background:${track.color}"></span><span>${track.file}</span>`;
    row.addEventListener('click', () => {
      map.fitBounds(trackLatLngs[track.id], { padding: [20, 20] });
    });
    legendTracksEl.appendChild(row);
  });
}

function renderCountryTabs() {
  legendCountryTabsEl.innerHTML = '';
  if (countries.length === 0) {
    return; // no tracks at all, nothing to show tabs for
  }
  countries.forEach((c) => {
    const tab = document.createElement('button');
    tab.className = 'country-tab' + (c.code === activeCountry ? ' active' : '');
    tab.textContent = c.label;
    tab.addEventListener('click', () => {
      activeCountry = c.code;
      renderCountryTabs();
      renderTrackRows(activeCountry);
    });
    legendCountryTabsEl.appendChild(tab);
  });
}

renderCountryTabs();
if (activeCountry) {
  renderTrackRows(activeCountry);
}
const estRow = document.createElement('div');
estRow.className = 'row';
estRow.innerHTML = '<span class="swatch" style="background:#ccc;border:1px dashed #fff"></span><span>위치 추정 (가장 가까운 FIT 트랙과 1시간 이상 차이)</span>';
legendBodyEl.appendChild(estRow);

const slopeTitle = document.createElement('div');
slopeTitle.className = 'legend-title';
slopeTitle.textContent = '마커 모양 (경사)';
legendBodyEl.appendChild(slopeTitle);

[['uphill', '오르막'], ['downhill', '내리막'], ['flat', '평지'], ['unknown', '알 수 없음 (구간 밖)']].forEach(([key, label]) => {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<span class="swatch slope-swatch">${SLOPE_SYMBOL[key]}</span><span>${label}</span>`;
  legendBodyEl.appendChild(row);
});

const youtubeRow = document.createElement('div');
youtubeRow.className = 'row';
youtubeRow.innerHTML = '<span class="swatch" style="background:#ff0000;border-radius:2px;width:9px;height:9px;font-size:6px;color:#fff;display:flex;align-items:center;justify-content:center;">▶</span><span>유튜브 업로드됨</span>';
legendBodyEl.appendChild(youtubeRow);

const unknownMedia = MEDIA.filter((m) => m.slope === 'unknown');
const unknownBtn = document.createElement('div');
unknownBtn.className = 'row clickable unknown-toggle';
unknownBtn.innerHTML = `<span class="swatch slope-swatch">${SLOPE_SYMBOL.unknown || '○'}</span><span>미분류 목록 보기 (${unknownMedia.length})</span>`;
legendBodyEl.appendChild(unknownBtn);

const unknownListEl = document.getElementById('unknown-list');
const unknownListBodyEl = document.getElementById('unknown-list-body');
const unknownListTitleEl = document.getElementById('unknown-list-title');
const unknownListCloseEl = document.getElementById('unknown-list-close');

unknownListTitleEl.textContent = `미분류 영상 (${unknownMedia.length}개)`;
unknownMedia.forEach((media) => {
  const winPath = fileUrlToWindowsPath(media.path);
  const fileName = winPath.split('\\').pop();
  const row = document.createElement('div');
  row.className = 'unknown-row';
  row.innerHTML = `
    <div class="unknown-row-name">${fileName}</div>
    <div class="unknown-row-time">${media.time.replace('T', ' ')}</div>
  `;
  row.addEventListener('click', () => focusMedia(media));
  unknownListBodyEl.appendChild(row);
});

unknownBtn.addEventListener('click', () => {
  unknownListEl.classList.toggle('hidden');
});
unknownListCloseEl.addEventListener('click', () => {
  unknownListEl.classList.add('hidden');
});

function addMediaMarker(media) {
  const marker = L.marker(getDisplayPosition(media), { icon: makeMarkerIcon(media) }).addTo(map);
  markerById[media.id] = marker;
  marker.on('mouseover', () => showPreview(media));
  marker.on('mouseout', () => restoreLockedOrHide());
  marker.on('click', () => focusMedia(media));
  return marker;
}

const fileUploadInput = document.createElement('input');
fileUploadInput.type = 'file';
fileUploadInput.accept = 'video/*';
fileUploadInput.style.display = 'none';

const fileUploadRow = document.createElement('div');
fileUploadRow.className = 'row';
const fileUploadBtn = document.createElement('button');
fileUploadBtn.className = 'copy-btn';
fileUploadBtn.textContent = '영상 파일 선택';
fileUploadBtn.addEventListener('click', () => fileUploadInput.click());

const fileUploadProgressWrap = document.createElement('div');
fileUploadProgressWrap.className = 'upload-progress hidden';
const fileUploadProgressBar = document.createElement('div');
fileUploadProgressBar.className = 'upload-progress-bar';
const fileUploadProgressText = document.createElement('span');
fileUploadProgressText.className = 'upload-progress-text';
fileUploadProgressWrap.appendChild(fileUploadProgressBar);
fileUploadProgressWrap.appendChild(fileUploadProgressText);

fileUploadRow.appendChild(fileUploadBtn);
fileUploadRow.appendChild(fileUploadInput);
legendBodyEl.appendChild(fileUploadRow);
legendBodyEl.appendChild(fileUploadProgressWrap);

fileUploadInput.addEventListener('change', () => {
  const file = fileUploadInput.files[0];
  if (!file) return;
  uploadVideoFile(file, fileUploadBtn, fileUploadProgressWrap, fileUploadProgressBar, fileUploadProgressText);
  fileUploadInput.value = '';
});

const trackTitleInput = document.createElement('input');
trackTitleInput.type = 'text';
trackTitleInput.placeholder = '경로 이름 (예: 알프듀에즈)';
trackTitleInput.className = 'track-title-input';

const trackFileInput = document.createElement('input');
trackFileInput.type = 'file';
trackFileInput.accept = '.fit';
trackFileInput.style.display = 'none';

const trackUploadRow = document.createElement('div');
trackUploadRow.className = 'row';
const trackUploadBtn = document.createElement('button');
trackUploadBtn.className = 'copy-btn';
trackUploadBtn.textContent = 'FIT 경로 추가';
trackUploadBtn.addEventListener('click', () => {
  if (!trackTitleInput.value.trim()) {
    alert('경로 이름을 먼저 입력해주세요.');
    trackTitleInput.focus();
    return;
  }
  trackFileInput.click();
});

const trackUploadProgressWrap = document.createElement('div');
trackUploadProgressWrap.className = 'upload-progress hidden';
const trackUploadProgressBar = document.createElement('div');
trackUploadProgressBar.className = 'upload-progress-bar';
const trackUploadProgressText = document.createElement('span');
trackUploadProgressText.className = 'upload-progress-text';
trackUploadProgressWrap.appendChild(trackUploadProgressBar);
trackUploadProgressWrap.appendChild(trackUploadProgressText);

trackUploadRow.appendChild(trackTitleInput);
trackUploadRow.appendChild(trackUploadBtn);
trackUploadRow.appendChild(trackFileInput);
legendBodyEl.appendChild(trackUploadRow);
legendBodyEl.appendChild(trackUploadProgressWrap);

trackFileInput.addEventListener('change', () => {
  const file = trackFileInput.files[0];
  if (!file) return;
  uploadTrackFile(file, trackTitleInput.value.trim(), trackUploadBtn, trackUploadProgressWrap);
  trackFileInput.value = '';
});

function addTrackToMap(track) {
  const latlngs = track.points.map((p) => [p.lat, p.lon]);
  L.polyline(latlngs, { color: track.color, weight: 3, opacity: 0.8 }).addTo(map);
  trackLatLngs[track.id] = latlngs;
  TRACKS.push(track);

  if (!countries.some((c) => c.code === track.country)) {
    countries.push({ code: track.country, label: track.countryLabel });
  }
  renderCountryTabs();
  renderTrackRows(activeCountry);
}

async function uploadTrackFile(file, title, btn, progressWrap) {
  btn.disabled = true;
  btn.textContent = '추가 중...';
  progressWrap.classList.remove('hidden');

  const fail = (message) => {
    btn.disabled = false;
    btn.textContent = 'FIT 경로 추가';
    progressWrap.classList.add('hidden');
    alert(`추가 실패: ${message}`);
  };

  try {
    const buf = await file.arrayBuffer();
    const points = parseFit(buf);
    if (!points.length) {
      fail('FIT 파일에서 GPS 포인트를 찾지 못했습니다.');
      return;
    }
    const { code, label } = detectCountry(points[0].lat, points[0].lon);
    const dateStr = points[0].t.slice(0, 10).replace(/-/g, '');
    const safeTitle = title.replace(/[<>:"/\\|?*]/g, '_');
    const fname = `${dateStr}_${safeTitle}.fit`;

    const track = await commitNewTrack(fname, {
      file: fname,
      color: PALETTE[TRACKS.length % PALETTE.length],
      points,
      startTime: points[0].t,
      endTime: points[points.length - 1].t,
      country: code,
      countryLabel: label,
    });
    addTrackToMap(track);

    trackTitleInput.value = '';
    btn.disabled = false;
    btn.textContent = 'FIT 경로 추가';
    progressWrap.classList.add('hidden');
  } catch (e) {
    fail(e.message);
  }
}

async function uploadVideoFile(file, btn, progressWrap, progressBar, progressText) {
  btn.disabled = true;
  btn.textContent = '분석 중...';
  progressWrap.classList.remove('hidden');
  progressBar.style.width = '0%';
  progressText.textContent = '';

  const fail = (message) => {
    btn.disabled = false;
    btn.textContent = '영상 파일 선택';
    progressWrap.classList.add('hidden');
    alert(`실패: ${message}`);
  };

  try {
    const basename = file.name;
    if (MEDIA.some((m) => m.path.endsWith('/' + basename))) {
      fail('이미 추가된 영상입니다.');
      return;
    }

    const creationTimeUtc = await getMp4CreationTime(file);
    if (!creationTimeUtc) {
      fail('영상에서 촬영 시각 메타데이터를 찾지 못했습니다.');
      return;
    }
    const duration = await getVideoDurationSeconds(file);
    const localDt = new Date(creationTimeUtc.getTime() + FIT_TO_LOCAL_OFFSET_MS);
    const match = matchMediaToTracks(TRACKS, localDt.getTime(), duration);

    const entry = {
      type: 'video',
      path: `file:///F:/DCIM/DJI_001/${basename}`,
      time: localDt.toISOString().replace('.000Z', '').replace('Z', ''),
      duration,
      lat: match.lat,
      lon: match.lon,
      color: match.color,
      trackId: match.trackId,
      estimated: match.estimated,
      slope: match.slope,
      timeSource: 'metadata',
      boundaryMatch: match.boundaryMatch,
    };

    btn.textContent = '업로드 중...';
    const videoId = await runYoutubeUpload(file, basename, progressBar, progressText);
    entry.youtubeId = videoId;

    btn.textContent = '저장 중...';
    const newMedia = await commitNewMedia({ basename, entry });

    MEDIA.push(newMedia);
    addMediaMarker(newMedia);
    allBounds.push([newMedia.lat, newMedia.lon]);

    btn.disabled = false;
    btn.textContent = '영상 파일 선택';
    progressWrap.classList.add('hidden');
  } catch (e) {
    fail(e.message);
  }
}
