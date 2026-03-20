/* ── State ── */
let currentUrl = '';
let currentTitle = '';
let ffmpegAvailable = true;
const activeDownloads = {}; // downloadId → { pollTimer }

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  checkStatus();
  loadHistory();

  const input = document.getElementById('url-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onFetch();
  });

  input.addEventListener('paste', () => {
    setTimeout(() => {
      const val = input.value.trim();
      if (val.startsWith('http')) onFetch();
    }, 50);
  });
});

/* ── Status ── */
async function checkStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    ffmpegAvailable = data.ffmpeg_available;

    const indicator = document.getElementById('ffmpeg-indicator');
    indicator.className = 'badge ' + (ffmpegAvailable ? 'badge-ok' : 'badge-warn');
    indicator.textContent = ffmpegAvailable ? 'FFmpeg ready' : 'No FFmpeg';

    document.getElementById('yt-dlp-version').textContent = 'yt-dlp ' + data.yt_dlp_version;

    if (!ffmpegAvailable) {
      document.getElementById('ffmpeg-banner').classList.remove('hidden');
    }
  } catch (e) {
    console.error('Status check failed', e);
  }
}

/* ── Fetch Formats ── */
async function onFetch() {
  const input = document.getElementById('url-input');
  const url = input.value.trim();

  if (!url) return;
  if (!url.startsWith('http')) {
    showError('fetch-error', 'Please enter a valid URL starting with http:// or https://');
    return;
  }

  currentUrl = url;
  setFetchLoading(true);
  hideEl('fetch-error');
  hideEl('video-info');
  hideEl('formats-section');

  try {
    const res = await fetch('/api/formats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();

    if (!res.ok) {
      showError('fetch-error', data.error || 'Failed to fetch formats');
      return;
    }

    currentTitle = data.title;
    renderVideoInfo(data);
    renderFormats(data.formats);
  } catch (e) {
    showError('fetch-error', 'Network error — is the server running?');
  } finally {
    setFetchLoading(false);
  }
}

function setFetchLoading(loading) {
  const btn = document.getElementById('fetch-btn');
  document.getElementById('fetch-btn-text').textContent = loading ? 'Fetching…' : 'Fetch Formats';
  document.getElementById('fetch-spinner').classList.toggle('hidden', !loading);
  btn.disabled = loading;
}

/* ── Video Info ── */
function renderVideoInfo(data) {
  document.getElementById('video-title').textContent = data.title || 'Unknown title';
  document.getElementById('video-uploader').textContent = data.uploader || '';
  document.getElementById('video-duration').textContent = data.duration ? formatDuration(data.duration) : '';

  const thumb = document.getElementById('video-thumb');
  if (data.thumbnail) {
    thumb.src = data.thumbnail;
    thumb.style.display = '';
  } else {
    thumb.style.display = 'none';
  }

  showEl('video-info');
}

/* ── Format Table ── */
function renderFormats(formats) {
  const tbody = document.getElementById('formats-body');
  tbody.innerHTML = '';

  const bestVA = formats.find(f => f.type === 'video+audio');

  formats.forEach(fmt => {
    const isBest = bestVA && fmt.format_id === bestVA.format_id;
    const disableBtn = fmt.needs_merge && !ffmpegAvailable;

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>
        <div class="res-cell">
          <span class="res-badge">${friendlyResolution(fmt)}</span>
          ${isBest ? '<span class="badge-best">Best</span>' : ''}
        </div>
      </td>
      <td>${fmt.ext.toUpperCase()}</td>
      <td>${fmt.filesize}</td>
      <td>${fmt.fps ? fmt.fps + ' fps' : '—'}</td>
      <td>${typeChip(fmt.type)}</td>
      <td>
        <button
          class="btn btn-download"
          ${disableBtn ? 'disabled title="Requires FFmpeg"' : ''}
          onclick="startDownload('${fmt.format_id}', '${esc(fmt.resolution)}', ${fmt.needs_merge})"
        >Download</button>
        ${disableBtn ? '<div class="ffmpeg-note">Requires FFmpeg</div>' : ''}
      </td>
    `;
    tbody.appendChild(row);
  });

  showEl('formats-section');
}

function friendlyResolution(fmt) {
  if (fmt.type === 'audio-only') return 'Audio only';
  if (fmt.height) return fmt.height + 'p';
  if (fmt.resolution && fmt.resolution !== 'audio') return fmt.resolution;
  return '?';
}

function typeChip(type) {
  const map = {
    'video+audio': ['type-va', 'Video + Audio'],
    'video-only':  ['type-vo', 'Video only'],
    'audio-only':  ['type-ao', 'Audio only'],
  };
  const [cls, label] = map[type] || ['', type];
  return `<span class="type-chip ${cls}">${label}</span>`;
}

/* ── Download ── */
async function startDownload(formatId, resolution, needsMerge) {
  try {
    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: currentUrl,
        format_id: formatId,
        title: currentTitle,
        resolution: resolution,
        needs_merge: needsMerge,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      showToast('Error: ' + (data.error || 'Download failed'));
      return;
    }

    createDownloadCard(data.download_id, currentTitle);
    pollProgress(data.download_id);
  } catch (e) {
    showToast('Network error starting download');
  }
}

/* ── Per-download card ── */
function createDownloadCard(downloadId, title) {
  const panel = document.getElementById('downloads-panel');

  const card = document.createElement('div');
  card.className = 'card download-card';
  card.id = 'card-' + downloadId;
  card.innerHTML = `
    <div class="download-card-header">
      <span class="download-card-title" title="${esc(title)}">${truncate(title, 60)}</span>
      <button class="download-card-dismiss hidden" onclick="dismissCard('${downloadId}')">✕</button>
    </div>
    <div class="progress-bar-wrap">
      <div class="progress-bar" id="bar-${downloadId}" style="width:0%"></div>
    </div>
    <div class="progress-meta">
      <span id="pct-${downloadId}">0%</span>
      <span id="spd-${downloadId}"></span>
      <span id="eta-${downloadId}"></span>
      <span id="sts-${downloadId}" class="progress-status">Starting…</span>
    </div>
  `;

  panel.prepend(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  activeDownloads[downloadId] = { pollTimer: null };
}

function dismissCard(downloadId) {
  const card = document.getElementById('card-' + downloadId);
  if (card) card.remove();
  if (activeDownloads[downloadId]) {
    clearInterval(activeDownloads[downloadId].pollTimer);
    delete activeDownloads[downloadId];
  }
}

/* ── Progress polling (one timer per download) ── */
function pollProgress(downloadId) {
  const timer = setInterval(async () => {
    try {
      const res = await fetch('/api/progress/' + downloadId);
      const data = await res.json();
      if (!res.ok) { clearInterval(timer); return; }

      updateCardUI(downloadId, data);

      if (data.status === 'finished') {
        clearInterval(timer);
        if (activeDownloads[downloadId]) activeDownloads[downloadId].pollTimer = null;
        onDownloadFinished(downloadId, data);
      } else if (data.status === 'error') {
        clearInterval(timer);
        if (activeDownloads[downloadId]) activeDownloads[downloadId].pollTimer = null;
        onDownloadError(downloadId, data);
      }
    } catch (e) { /* network hiccup, keep polling */ }
  }, 500);

  if (activeDownloads[downloadId]) activeDownloads[downloadId].pollTimer = timer;
}

function updateCardUI(downloadId, data) {
  const bar = document.getElementById('bar-' + downloadId);
  const pct = document.getElementById('pct-' + downloadId);
  const spd = document.getElementById('spd-' + downloadId);
  const eta = document.getElementById('eta-' + downloadId);
  const sts = document.getElementById('sts-' + downloadId);
  if (!bar) return;

  bar.style.width = data.percent + '%';
  pct.textContent = data.percent + '%';

  if (data.status === 'downloading') {
    spd.textContent = data.speed || '';
    eta.textContent = data.eta ? 'ETA ' + data.eta : '';
    sts.textContent = data.downloaded && data.total ? data.downloaded + ' / ' + data.total : 'Downloading…';
  } else if (data.status === 'merging') {
    spd.textContent = '';
    eta.textContent = '';
    sts.textContent = 'Merging…';
  } else if (data.status === 'starting') {
    sts.textContent = 'Starting…';
  } else if (data.status === 'finished') {
    sts.textContent = 'Done!';
    spd.textContent = '';
    eta.textContent = '';
  }
}

function onDownloadFinished(downloadId, data) {
  const bar = document.getElementById('bar-' + downloadId);
  if (bar) bar.style.background = 'var(--success)';

  // Update title to actual filename
  const titleEl = document.querySelector('#card-' + downloadId + ' .download-card-title');
  if (titleEl && data.filename) titleEl.textContent = data.filename;

  // Show dismiss button
  const dismissBtn = document.querySelector('#card-' + downloadId + ' .download-card-dismiss');
  if (dismissBtn) dismissBtn.classList.remove('hidden');

  showToast('Download complete: ' + (data.filename || data.title || ''));
  loadHistory();
}

function onDownloadError(downloadId, data) {
  const bar = document.getElementById('bar-' + downloadId);
  if (bar) bar.style.background = 'var(--danger)';

  const sts = document.getElementById('sts-' + downloadId);
  if (sts) sts.textContent = 'Error: ' + (data.error || 'Unknown error');

  const dismissBtn = document.querySelector('#card-' + downloadId + ' .download-card-dismiss');
  if (dismissBtn) dismissBtn.classList.remove('hidden');

  showToast('Download failed: ' + (data.error || 'Unknown error'));
}

/* ── History ── */
async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    renderHistory(await res.json());
  } catch (e) { /* silent */ }
}

function renderHistory(items) {
  const empty = document.getElementById('history-empty');
  const wrap = document.getElementById('history-table-wrap');
  const tbody = document.getElementById('history-body');

  if (!items || items.length === 0) {
    empty.style.display = '';
    wrap.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  wrap.style.display = '';
  tbody.innerHTML = '';

  items.forEach(item => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td title="${esc(item.title)}">${truncate(item.title, 50)}</td>
      <td>${item.resolution || '—'}</td>
      <td>${item.filesize || '—'}</td>
      <td>${item.completed_at}</td>
    `;
    tbody.appendChild(row);
  });
}

async function openDownloadsFolder() {
  await fetch('/api/open-downloads');
}

/* ── FFmpeg modal ── */
function showFfmpegModal() { document.getElementById('ffmpeg-modal').classList.remove('hidden'); }
function closeFfmpegModal() { document.getElementById('ffmpeg-modal').classList.add('hidden'); }

/* ── Toast ── */
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.getBoundingClientRect(); // force reflow
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.classList.add('hidden'), 300);
  }, 3500);
}

/* ── Error display ── */
function showError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.classList.remove('hidden');
}

/* ── Utils ── */
function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}
function esc(str) {
  if (!str) return '';
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function showEl(id) { document.getElementById(id).classList.remove('hidden'); }
function hideEl(id) { document.getElementById(id).classList.add('hidden'); }
