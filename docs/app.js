const UPLOAD_SERVER = 'http://localhost:8765';
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

function uploadToYoutube(media, btn, progressWrap, progressBar, progressText) {
  const winPath = fileUrlToWindowsPath(media.path);
  const basename = getBasename(media);
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '업로드 시작 중...';

  const fail = (message) => {
    btn.disabled = false;
    btn.textContent = originalText;
    progressWrap.classList.add('hidden');
    alert(`업로드 실패: ${message}\n\nscripts/youtube_upload_server.py 가 실행 중인지 확인해주세요.`);
  };

  const poll = (jobId) => {
    fetch(`${UPLOAD_SERVER}/progress/${jobId}`)
      .then((res) => {
        if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
        return res.json();
      })
      .then((job) => {
        if (job.status === 'error') {
          fail(job.error || '알 수 없는 오류');
          return;
        }
        progressBar.style.width = `${job.progress}%`;
        progressText.textContent = `${job.progress}%`;

        if (job.status === 'done') {
          media.youtubeId = job.videoId;
          const marker = markerById[media.id];
          if (marker) marker.setIcon(makeMarkerIcon(media));
          renderPanel(media, true);
          return;
        }
        setTimeout(() => poll(jobId), 1000);
      })
      .catch((err) => fail(err.message));
  };

  fetch(`${UPLOAD_SERVER}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: winPath, basename, title: basename }),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
      return res.json();
    })
    .then((data) => {
      btn.textContent = '업로드 중...';
      progressWrap.classList.remove('hidden');
      progressBar.style.width = '0%';
      progressText.textContent = '0%';
      poll(data.jobId);
    })
    .catch((err) => fail(err.message));
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

const legendTracksEl = document.createElement('div');
legendTracksEl.id = 'legend-tracks';
legendEl.appendChild(legendTracksEl);

TRACKS.forEach((track) => {
  const row = document.createElement('div');
  row.className = 'row clickable';
  row.innerHTML = `<span class="swatch" style="background:${track.color}"></span><span>${track.file}</span>`;
  row.addEventListener('click', () => {
    map.fitBounds(trackLatLngs[track.id], { padding: [20, 20] });
  });
  legendTracksEl.appendChild(row);
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

const youtubeRow = document.createElement('div');
youtubeRow.className = 'row';
youtubeRow.innerHTML = '<span class="swatch" style="background:#ff0000;border-radius:2px;width:9px;height:9px;font-size:6px;color:#fff;display:flex;align-items:center;justify-content:center;">▶</span><span>유튜브 업로드됨</span>';
legendEl.appendChild(youtubeRow);

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
