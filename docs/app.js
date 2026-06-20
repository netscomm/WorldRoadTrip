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
  const tag = media.estimated ? ' (위치 추정)' : '';

  addInfoRow('위도, 경도', `${media.lat.toFixed(6)}, ${media.lon.toFixed(6)}${tag}`);
  addInfoRow('시작 시간', media.time.replace('T', ' '));
  const endValueEl = addInfoRow('종료 시간', media.type === 'photo' ? '-' : '로딩 중...');
  if (media.type === 'video') {
    addInfoRow('경사', SLOPE_LABEL[media.slope] || media.slope);
  }
  addInfoRow('경로', winPath, 'path-text');

  if (media.type === 'photo') {
    const img = document.createElement('img');
    img.src = media.path;
    panelMediaEl.appendChild(img);
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

function fileUrlToWindowsPath(fileUrl) {
  let p = fileUrl.replace(/^file:\/\/\//, '');
  p = decodeURIComponent(p);
  return p.replace(/\//g, '\\');
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

function makeMarkerIcon(media) {
  const symbol = SLOPE_SYMBOL[media.slope] || '';
  const borderStyle = media.estimated ? 'dashed' : 'solid';
  const opacity = media.estimated ? 0.55 : 1;
  const html = `<div class="media-marker" style="background:${media.color};border-style:${borderStyle};opacity:${opacity}">${symbol}</div>`;
  return L.divIcon({ html, className: 'media-marker-wrap', iconSize: [16, 16], iconAnchor: [8, 8] });
}

const markerById = {};

function focusMedia(media) {
  map.setView([media.lat, media.lon], Math.max(map.getZoom(), 15));
  lockedMedia = media;
  renderPanel(media, true);
}

MEDIA.forEach((media) => {
  const marker = L.marker([media.lat, media.lon], { icon: makeMarkerIcon(media) }).addTo(map);
  markerById[media.id] = marker;

  allBounds.push([media.lat, media.lon]);

  marker.on('mouseover', () => showPreview(media));
  marker.on('mouseout', () => restoreLockedOrHide());
  marker.on('click', () => focusMedia(media));
});

if (allBounds.length) {
  map.fitBounds(allBounds, { padding: [20, 20] });
} else {
  map.setView([46.4, 11.3], 9);
}

const legendEl = document.getElementById('legend');
const legendTitle = document.createElement('div');
legendTitle.className = 'legend-title';
legendTitle.textContent = 'FIT 트랙 (클릭하면 해당 구간으로 이동)';
legendEl.appendChild(legendTitle);

TRACKS.forEach((track) => {
  const row = document.createElement('div');
  row.className = 'row clickable';
  row.innerHTML = `<span class="swatch" style="background:${track.color}"></span><span>${track.file}</span>`;
  row.addEventListener('click', () => {
    map.fitBounds(trackLatLngs[track.id], { padding: [20, 20] });
  });
  legendEl.appendChild(row);
});
const estRow = document.createElement('div');
estRow.className = 'row';
estRow.innerHTML = '<span class="swatch" style="background:#ccc;border:1px dashed #fff"></span><span>위치 추정 (FIT 트랙 범위 밖)</span>';
legendEl.appendChild(estRow);

const slopeTitle = document.createElement('div');
slopeTitle.className = 'legend-title';
slopeTitle.textContent = '마커 모양 (경사)';
legendEl.appendChild(slopeTitle);

[['uphill', '오르막'], ['downhill', '내리막'], ['flat', '평지'], ['unknown', '알 수 없음 (구간 밖)']].forEach(([key, label]) => {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<span class="swatch slope-swatch">${SLOPE_SYMBOL[key]}</span><span>${label}</span>`;
  legendEl.appendChild(row);
});

const unknownMedia = MEDIA.filter((m) => m.slope === 'unknown');
const unknownBtn = document.createElement('div');
unknownBtn.className = 'row clickable unknown-toggle';
unknownBtn.innerHTML = `<span class="swatch slope-swatch">${SLOPE_SYMBOL.unknown || '○'}</span><span>미분류 목록 보기 (${unknownMedia.length})</span>`;
legendEl.appendChild(unknownBtn);

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
