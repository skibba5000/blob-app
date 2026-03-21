/* ── State ── */
let currentUrl = '';
let currentTitle = '';
let ffmpegAvailable = true;
let currentMode = 'video'; // 'video' | 'images' | 'channel'
let scannedProfile = null;   // { profile_name, platform, image_count, images: [...] }
let selectedImages = new Set(); // indices of selected images
let albumGroupsList = [];    // [{ name: string|null, indices: number[] }]
let lightboxIndex = 0;
const activeDownloads = {}; // downloadId → { pollTimer }
const tabUrls = { video: '', images: '', channel: '' };

// Channel mode state
let scannedChannel = null;  // { channel_name, video_count, videos: [...] }
let selectedVideos = new Set(); // indices of selected videos

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  checkStatus();
  loadHistory();
  loadSettings();

  const input = document.getElementById('url-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onFetch();
  });

  input.addEventListener('paste', () => {
    setTimeout(() => {
      const val = input.value.trim();
      if (val.startsWith('http') && currentMode === 'video') onFetch();
    }, 50);
  });

  // Also allow Enter to trigger in channel mode
  // (already handled by onFetch via keydown listener above)
});

/* ── Mode switching ── */
function switchMode(mode) {
  // Save current URL for this tab before switching
  tabUrls[currentMode] = document.getElementById('url-input').value;
  currentMode = mode;
  document.getElementById('tab-video').classList.toggle('active', mode === 'video');
  document.getElementById('tab-images').classList.toggle('active', mode === 'images');
  document.getElementById('tab-channel').classList.toggle('active', mode === 'channel');

  const label = document.getElementById('url-label');
  const btnText = document.getElementById('fetch-btn-text');
  const input = document.getElementById('url-input');
  const hint = document.getElementById('cookie-hint');

  // Hide all mode-specific sections first
  hideEl('video-info');
  hideEl('formats-section');
  hideEl('profile-section');
  hideEl('image-grid-section');
  hideEl('channel-section');
  hideEl('video-grid-section');
  document.getElementById('deep-scan-row').classList.add('hidden');
  document.getElementById('rate-limit-row').classList.add('hidden');
  hint.classList.add('hidden');

  if (mode === 'video') {
    label.textContent = 'Paste a video URL';
    btnText.textContent = 'Fetch Formats';
    input.placeholder = 'https://www.youtube.com/watch?v=...';
  } else if (mode === 'images') {
    label.textContent = 'Paste a profile URL';
    btnText.textContent = 'Scan Profile';
    input.placeholder = 'https://www.instagram.com/username/';
    hint.classList.remove('hidden');
    document.getElementById('deep-scan-row').classList.remove('hidden');
    document.getElementById('rate-limit-row').classList.remove('hidden');
  } else if (mode === 'channel') {
    label.textContent = 'Paste a YouTube channel or playlist URL';
    btnText.textContent = 'Scan Channel';
    input.placeholder = 'https://www.youtube.com/@channelname/videos';
  }

  // Restore URL for the new tab
  document.getElementById('url-input').value = tabUrls[mode] || '';
  hideEl('fetch-error');
}

/* ── Status ── */
async function checkStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    ffmpegAvailable = data.ffmpeg_available;

    const ffmpegIndicator = document.getElementById('ffmpeg-indicator');
    ffmpegIndicator.className = 'badge ' + (ffmpegAvailable ? 'badge-ok' : 'badge-warn');
    ffmpegIndicator.textContent = ffmpegAvailable ? 'FFmpeg ready' : 'No FFmpeg';

    const gdlIndicator = document.getElementById('gallery-dl-indicator');
    if (data.gallery_dl_available) {
      gdlIndicator.className = 'badge badge-ok';
      gdlIndicator.textContent = 'gallery-dl ready';
    } else {
      gdlIndicator.className = 'badge badge-warn';
      gdlIndicator.textContent = 'No gallery-dl';
    }

    document.getElementById('yt-dlp-version').textContent = 'yt-dlp ' + data.yt_dlp_version;

    if (!ffmpegAvailable) {
      document.getElementById('ffmpeg-banner').classList.remove('hidden');
    }
  } catch (e) {
    console.error('Status check failed', e);
  }
}

/* ── Unified fetch button handler ── */
function onFetch() {
  if (currentMode === 'images') {
    onScanProfile();
  } else if (currentMode === 'channel') {
    onScanChannel();
  } else {
    onFetchFormats();
  }
}

/* ── Fetch Formats (video mode) ── */
async function onFetchFormats() {
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
  const labels = { video: ['Fetching…', 'Fetch Formats'], images: ['Scanning…', 'Scan Profile'], channel: ['Scanning…', 'Scan Channel'] };
  const [loadingText, idleText] = labels[currentMode] || labels.video;
  document.getElementById('fetch-btn-text').textContent = loading ? loadingText : idleText;
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

  formats.forEach(fmt => {
    const disableBtn = fmt.needs_merge && !ffmpegAvailable;

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>
        <div class="res-cell">
          <span class="res-badge">${friendlyResolution(fmt)}</span>
        </div>
      </td>
      <td>${fmt.ext.toUpperCase()}</td>
      <td>${fmt.filesize}</td>
      <td>${fmt.fps ? fmt.fps + ' fps' : '—'}</td>
      <td>${typeChip(fmt.type, fmt.needs_merge)}</td>
      <td>
        <div class="action-cell">
          <button
            class="btn btn-download"
            ${disableBtn ? 'disabled title="Requires FFmpeg"' : ''}
            onclick="startDownload('${fmt.format_id}', '${esc(fmt.resolution)}', ${fmt.needs_merge})"
          >Download</button>
          ${fmt.needs_merge ? `<button class="btn btn-video-only" onclick="startDownload('${fmt.format_id}', '${esc(fmt.resolution)}', false, true)">Video only</button>` : ''}
          ${disableBtn ? '<div class="ffmpeg-note">Needs FFmpeg to add audio</div>' : ''}
        </div>
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

function typeChip(type, needsMerge) {
  // Video-only formats are downloaded with best audio when FFmpeg is available,
  // so show them as "Video + Audio" — the merge happens automatically.
  if (type === 'video-only' && needsMerge && ffmpegAvailable) {
    return `<span class="type-chip type-va">Video + Audio</span>`;
  }
  const map = {
    'video+audio': ['type-va', 'Video + Audio'],
    'video-only':  ['type-vo', 'Video only'],
    'audio-only':  ['type-ao', 'Audio only'],
  };
  const [cls, label] = map[type] || ['', type];
  return `<span class="type-chip ${cls}">${label}</span>`;
}

/* ── Video Download ── */
async function startDownload(formatId, resolution, needsMerge, videoOnly = false) {
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
        video_only: videoOnly,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      showToast('Error: ' + (data.error || 'Download failed'));
      return;
    }

    createDownloadCard(data.download_id, currentTitle, 'video');
    pollProgress(data.download_id);
  } catch (e) {
    showToast('Network error starting download');
  }
}

/* ── Scan Profile (images mode) ── */
async function onScanProfile() {
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
  hideEl('profile-section');
  hideEl('image-grid-section');
  scannedProfile = null;
  selectedImages = new Set();
  albumGroupsList = [];

  // Start scan, get scan_id back immediately
  let scanId;
  try {
    const deepScan = document.getElementById('deep-scan-checkbox').checked;
    const sleepRequest = parseFloat(document.getElementById('sleep-request').value) || 0;
    const batchSize = parseInt(document.getElementById('batch-size').value, 10) || 0;
    const res = await fetch('/api/scrape-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, deep_scan: deepScan, sleep_request: sleepRequest, batch_size: batchSize }),
    });
    const data = await res.json();
    if (!res.ok) {
      showError('fetch-error', data.error || 'Failed to start scan');
      setFetchLoading(false);
      return;
    }
    scanId = data.scan_id;
  } catch (e) {
    showError('fetch-error', 'Network error — is the server running?');
    setFetchLoading(false);
    return;
  }

  // Show timer and poll for progress
  const timerEl = document.getElementById('scan-timer');
  timerEl.classList.remove('hidden');
  timerEl.textContent = '0s';
  const scanStart = Date.now();

  const pollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/scan-progress/' + scanId);
      const data = await res.json();

      // Update timer + live count
      const sec = Math.floor((Date.now() - scanStart) / 1000);
      const timeStr = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
      const stepLabel = data.scan_label ? `${data.scan_label} · ` : '';
      timerEl.textContent = data.found > 0
        ? `${stepLabel}${timeStr} · ${data.found} image${data.found !== 1 ? 's' : ''} found`
        : stepLabel + timeStr;

      if (data.status === 'done') {
        clearInterval(pollTimer);
        timerEl.classList.add('hidden');
        scannedProfile = data;
        data.images.forEach((_, i) => selectedImages.add(i));
        renderProfileCard(data);
        renderImageGrid(data.images);
        setFetchLoading(false);
      } else if (data.status === 'error') {
        clearInterval(pollTimer);
        timerEl.classList.add('hidden');
        showError('fetch-error', data.error || 'Scan failed');
        setFetchLoading(false);
      }
    } catch (e) { /* network hiccup, keep polling */ }
  }, 500);
}

/* ── Profile Card ── */
function renderProfileCard(data) {
  document.getElementById('profile-name').textContent = data.profile_name;
  document.getElementById('profile-meta').textContent =
    `${data.platform} · ${data.image_count} image${data.image_count !== 1 ? 's' : ''} found`;
  updateSelectionUI();
  showEl('profile-section');
}

/* ── Image Grid ── */
function renderImageGrid(images) {
  const container = document.getElementById('image-grid');
  container.innerHTML = '';
  albumGroupsList = [];

  // Build groups
  const groupMap = new Map();
  images.forEach((img, i) => {
    const key = img.album || '';
    if (!groupMap.has(key)) groupMap.set(key, { name: img.album || null, indices: [] });
    groupMap.get(key).indices.push(i);
  });

  const hasAlbums = groupMap.size > 1 || (groupMap.size === 1 && !groupMap.has(''));

  if (!hasAlbums) {
    // Flat grid — no albums detected
    container.className = 'image-grid';
    const group = groupMap.get('') || { name: null, indices: [] };
    albumGroupsList.push(group);
    group.indices.forEach(i => container.appendChild(createImageCell(images[i], i)));
  } else {
    container.className = '';
    // No-album photos first, then albums sorted alphabetically
    const noAlbumGroup = groupMap.get('');
    const albumKeys = [...groupMap.keys()].filter(k => k !== '').sort();
    const orderedKeys = noAlbumGroup ? ['', ...albumKeys] : albumKeys;

    orderedKeys.forEach(key => {
      const group = groupMap.get(key);
      const groupIdx = albumGroupsList.length;
      albumGroupsList.push(group);

      const section = document.createElement('div');
      section.className = 'album-section';

      const header = document.createElement('div');
      header.className = 'album-header';

      const nameEl = document.createElement('span');
      nameEl.className = 'album-name';
      nameEl.textContent = group.name
        ? `${group.name} (${group.indices.length})`
        : `Photos (${group.indices.length})`;

      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary btn-sm album-toggle-btn';
      btn.dataset.albumIdx = groupIdx;
      btn.textContent = 'Deselect';
      btn.onclick = () => toggleAlbum(groupIdx);

      header.appendChild(nameEl);
      header.appendChild(btn);

      const grid = document.createElement('div');
      grid.className = 'image-grid';
      group.indices.forEach(i => grid.appendChild(createImageCell(images[i], i)));

      section.appendChild(header);
      section.appendChild(grid);
      container.appendChild(section);
    });
  }

  showEl('image-grid-section');
}

function createImageCell(img, i) {
  const cell = document.createElement('div');
  cell.className = 'image-cell selected';
  cell.dataset.index = i;
  cell.onclick = () => openLightbox(i);

  const imgEl = document.createElement('img');
  imgEl.src = img.thumbnail;
  imgEl.alt = img.filename;
  imgEl.loading = 'lazy';

  const check = document.createElement('div');
  check.className = 'image-check';
  check.textContent = '✓';
  check.onclick = (e) => { e.stopPropagation(); toggleImageSelection(i); };

  cell.appendChild(imgEl);
  cell.appendChild(check);
  return cell;
}

/* ── Lightbox ── */
function openLightbox(idx) {
  if (!scannedProfile || !scannedProfile.images.length) return;
  lightboxIndex = idx;
  updateLightbox();
  document.getElementById('lightbox').classList.remove('hidden');
  document.addEventListener('keydown', lightboxKeyHandler);
}

function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.removeEventListener('keydown', lightboxKeyHandler);
}

function navigateLightbox(delta) {
  const total = scannedProfile ? scannedProfile.images.length : 0;
  if (!total) return;
  lightboxIndex = (lightboxIndex + delta + total) % total;
  updateLightbox();
}

function updateLightbox() {
  const img = scannedProfile.images[lightboxIndex];
  document.getElementById('lightbox-img').src = img.thumbnail;
  document.getElementById('lightbox-counter').textContent =
    `${lightboxIndex + 1} / ${scannedProfile.images.length}`;
}

function lightboxKeyHandler(e) {
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') navigateLightbox(-1);
  else if (e.key === 'ArrowRight') navigateLightbox(1);
}

/* ── Image Selection ── */
function toggleImageSelection(idx) {
  const cell = document.querySelector(`.image-cell[data-index="${idx}"]`);
  if (selectedImages.has(idx)) {
    selectedImages.delete(idx);
    cell && cell.classList.remove('selected');
  } else {
    selectedImages.add(idx);
    cell && cell.classList.add('selected');
  }
  updateSelectionUI();
}

function toggleAllImages() {
  if (!scannedProfile) return;
  const allSelected = selectedImages.size === scannedProfile.images.length;

  if (allSelected) {
    selectedImages.clear();
    document.querySelectorAll('.image-cell').forEach(c => c.classList.remove('selected'));
  } else {
    scannedProfile.images.forEach((_, i) => selectedImages.add(i));
    document.querySelectorAll('.image-cell').forEach(c => c.classList.add('selected'));
  }
  updateSelectionUI();
}

function updateSelectionUI() {
  const count = selectedImages.size;
  document.getElementById('selected-count').textContent = count;
  document.getElementById('download-images-btn').disabled = count === 0;
  if (scannedProfile) {
    document.getElementById('select-toggle-btn').textContent =
      selectedImages.size === scannedProfile.images.length ? 'Deselect All' : 'Select All';
  }
  updateAllAlbumButtons();
}

/* ── Album selection ── */
function toggleAlbum(groupIdx) {
  const group = albumGroupsList[groupIdx];
  if (!group) return;
  const allSelected = group.indices.every(i => selectedImages.has(i));
  if (allSelected) {
    group.indices.forEach(i => {
      selectedImages.delete(i);
      const cell = document.querySelector(`.image-cell[data-index="${i}"]`);
      if (cell) cell.classList.remove('selected');
    });
  } else {
    group.indices.forEach(i => {
      selectedImages.add(i);
      const cell = document.querySelector(`.image-cell[data-index="${i}"]`);
      if (cell) cell.classList.add('selected');
    });
  }
  updateSelectionUI();
}

function updateAllAlbumButtons() {
  albumGroupsList.forEach((group, idx) => {
    const btn = document.querySelector(`.album-toggle-btn[data-album-idx="${idx}"]`);
    if (!btn) return;
    const allSelected = group.indices.every(i => selectedImages.has(i));
    btn.textContent = allSelected ? 'Deselect' : 'Select';
  });
}

/* ── Image Download ── */
async function startImageDownload() {
  if (!scannedProfile || selectedImages.size === 0) return;

  const imagesToDownload = Array.from(selectedImages).map(i => scannedProfile.images[i]);

  try {
    const res = await fetch('/api/download-images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: currentUrl,
        profile_name: scannedProfile.profile_name,
        images: imagesToDownload,
        sleep_request: parseFloat(document.getElementById('sleep-request').value) || 0,
        batch_size: parseInt(document.getElementById('batch-size').value, 10) || 0,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      showToast('Error: ' + (data.error || 'Download failed'));
      return;
    }

    createDownloadCard(data.download_id, scannedProfile.profile_name, 'images', imagesToDownload.length);
    pollProgress(data.download_id);

    // Clear scan UI so user can immediately scan another profile
    scannedProfile = null;
    selectedImages = new Set();
    closeLightbox();
    hideEl('profile-section');
    hideEl('image-grid-section');
    document.getElementById('url-input').value = '';
  } catch (e) {
    showToast('Network error starting download');
  }
}

/* ── Scan Channel ── */
async function onScanChannel() {
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
  hideEl('channel-section');
  hideEl('video-grid-section');
  scannedChannel = null;
  selectedVideos = new Set();

  let scanId;
  try {
    const res = await fetch('/api/scan-channel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) {
      showError('fetch-error', data.error || 'Failed to start scan');
      setFetchLoading(false);
      return;
    }
    scanId = data.scan_id;
  } catch (e) {
    showError('fetch-error', 'Network error — is the server running?');
    setFetchLoading(false);
    return;
  }

  const timerEl = document.getElementById('scan-timer');
  timerEl.classList.remove('hidden');
  timerEl.textContent = '0s';
  const scanStart = Date.now();

  const pollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/scan-progress/' + scanId);
      const data = await res.json();

      const sec = Math.floor((Date.now() - scanStart) / 1000);
      const timeStr = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
      timerEl.textContent = data.found > 0
        ? `${timeStr} · ${data.found} video${data.found !== 1 ? 's' : ''} found`
        : timeStr;

      if (data.status === 'done') {
        clearInterval(pollTimer);
        timerEl.classList.add('hidden');
        scannedChannel = data;
        data.videos.forEach((_, i) => selectedVideos.add(i));
        renderChannelCard(data);
        renderVideoGrid(data.videos);
        setFetchLoading(false);
      } else if (data.status === 'error') {
        clearInterval(pollTimer);
        timerEl.classList.add('hidden');
        showError('fetch-error', data.error || 'Scan failed');
        setFetchLoading(false);
      }
    } catch (e) { /* network hiccup, keep polling */ }
  }, 500);
}

/* ── Channel Card ── */
function renderChannelCard(data) {
  document.getElementById('channel-name').textContent = data.channel_name || 'Channel';
  document.getElementById('channel-meta').textContent =
    `${data.video_count} video${data.video_count !== 1 ? 's' : ''} found`;
  updateChannelSelectionUI();
  showEl('channel-section');
}

/* ── Video Grid ── */
function renderVideoGrid(videos) {
  const grid = document.getElementById('video-grid');
  grid.innerHTML = '';
  videos.forEach((v, i) => grid.appendChild(createVideoCard(v, i)));
  showEl('video-grid-section');
}

function createVideoCard(video, i) {
  const card = document.createElement('div');
  card.className = 'video-card selected';
  card.dataset.index = i;

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'video-thumb-wrap';

  const img = document.createElement('img');
  img.src = video.thumbnail;
  img.alt = video.title;
  img.loading = 'lazy';
  thumbWrap.appendChild(img);

  if (video.duration) {
    const dur = document.createElement('span');
    dur.className = 'video-duration-badge';
    dur.textContent = formatDuration(video.duration);
    thumbWrap.appendChild(dur);
  }

  const check = document.createElement('div');
  check.className = 'video-check';
  check.textContent = '✓';
  check.onclick = (e) => { e.stopPropagation(); toggleVideoSelection(i); };
  thumbWrap.appendChild(check);

  const info = document.createElement('div');
  info.className = 'video-card-info';

  const title = document.createElement('div');
  title.className = 'video-card-title';
  title.textContent = video.title;
  info.appendChild(title);

  if (video.upload_date && video.upload_date.length === 8) {
    const d = video.upload_date;
    const date = document.createElement('div');
    date.className = 'video-card-date';
    date.textContent = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    info.appendChild(date);
  }

  const resSelect = document.createElement('select');
  resSelect.className = 'video-res-select';
  resSelect.dataset.index = i;
  resSelect.title = 'Quality for this video';
  resSelect.onclick = (e) => e.stopPropagation();
  [
    { value: 'best', label: 'Best quality' },
    { value: '2160', label: '4K (2160p)' },
    { value: '1440', label: '1440p' },
    { value: '1080', label: '1080p' },
    { value: '720', label: '720p' },
    { value: '480', label: '480p' },
    { value: '360', label: '360p' },
    { value: 'audio', label: 'Audio only' },
  ].forEach(opt => {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    resSelect.appendChild(o);
  });
  info.appendChild(resSelect);

  card.appendChild(thumbWrap);
  card.appendChild(info);
  card.onclick = () => toggleVideoSelection(i);
  return card;
}

/* ── Video Selection ── */
function toggleVideoSelection(idx) {
  const card = document.querySelector(`.video-card[data-index="${idx}"]`);
  if (selectedVideos.has(idx)) {
    selectedVideos.delete(idx);
    card && card.classList.remove('selected');
  } else {
    selectedVideos.add(idx);
    card && card.classList.add('selected');
  }
  updateChannelSelectionUI();
}

function toggleAllVideos() {
  if (!scannedChannel) return;
  const allSelected = selectedVideos.size === scannedChannel.videos.length;
  if (allSelected) {
    selectedVideos.clear();
    document.querySelectorAll('.video-card').forEach(c => c.classList.remove('selected'));
  } else {
    scannedChannel.videos.forEach((_, i) => selectedVideos.add(i));
    document.querySelectorAll('.video-card').forEach(c => c.classList.add('selected'));
  }
  updateChannelSelectionUI();
}

function updateChannelSelectionUI() {
  const count = selectedVideos.size;
  document.getElementById('channel-selected-count').textContent = count;
  document.getElementById('download-channel-btn').disabled = count === 0;
  if (scannedChannel) {
    document.getElementById('channel-select-toggle-btn').textContent =
      selectedVideos.size === scannedChannel.videos.length ? 'Deselect All' : 'Select All';
  }
}

/* ── Channel Download ── */
async function startChannelDownload() {
  if (!scannedChannel || selectedVideos.size === 0) return;

  const videos = Array.from(selectedVideos).sort((a, b) => a - b).map(i => {
    const v = scannedChannel.videos[i];
    const resSelect = document.querySelector(`.video-res-select[data-index="${i}"]`);
    const res = resSelect ? resSelect.value : 'best';
    let formatSpec = 'bestvideo+bestaudio/best';
    if (res !== 'best' && res !== 'audio') {
      formatSpec = `bestvideo[height<=${res}]+bestaudio/best[height<=${res}]`;
    } else if (res === 'audio') {
      formatSpec = 'bestaudio/best';
    }
    return { url: v.url, title: v.title, format_spec: formatSpec };
  });

  try {
    const res = await fetch('/api/start-channel-downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel_name: scannedChannel.channel_name,
        videos,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      showToast('Error: ' + (data.error || 'Download failed'));
      return;
    }

    const cardTitle = `${scannedChannel.channel_name} — ${videos.length} video${videos.length !== 1 ? 's' : ''}`;
    createDownloadCard(data.download_id, cardTitle, 'channel', videos.length);
    pollProgress(data.download_id);

    // Clear so user can scan another channel immediately
    scannedChannel = null;
    selectedVideos = new Set();
    hideEl('channel-section');
    hideEl('video-grid-section');
    document.getElementById('url-input').value = '';
  } catch (e) {
    showToast('Network error starting download');
  }
}

/* ── Per-download card ── */
function createDownloadCard(downloadId, title, type, total) {
  const panel = document.getElementById('downloads-panel');
  const card = document.createElement('div');
  card.className = 'card download-card';
  card.id = 'card-' + downloadId;

  if (type === 'images') {
    card.innerHTML = `
      <div class="download-card-header">
        <span class="download-card-title" title="${esc(title)}">${truncate(title, 60)}</span>
        <span class="download-card-type-badge">Images</span>
        <button class="download-card-dismiss hidden" onclick="dismissCard('${downloadId}')">✕</button>
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-bar" id="bar-${downloadId}" style="width:0%"></div>
      </div>
      <div class="progress-meta">
        <span id="pct-${downloadId}">0%</span>
        <span id="img-count-${downloadId}" class="img-count">0 / ${total || '?'}</span>
        <span id="sts-${downloadId}" class="progress-status">Starting…</span>
      </div>
      <div id="cur-file-${downloadId}" class="current-file"></div>
    `;
  } else if (type === 'channel') {
    card.innerHTML = `
      <div class="download-card-header">
        <span class="download-card-title" title="${esc(title)}">${truncate(title, 60)}</span>
        <span class="download-card-type-badge">Videos</span>
        <button class="download-card-dismiss hidden" onclick="dismissCard('${downloadId}')">✕</button>
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-bar" id="bar-${downloadId}" style="width:0%"></div>
      </div>
      <div class="progress-meta">
        <span id="pct-${downloadId}">0%</span>
        <span id="vid-count-${downloadId}" class="img-count">0 / ${total || '?'}</span>
        <span id="sts-${downloadId}" class="progress-status">Starting…</span>
      </div>
      <div id="cur-video-${downloadId}" class="current-file"></div>
      <div class="sub-progress-wrap" id="sub-wrap-${downloadId}">
        <div class="sub-progress-bar" id="sub-bar-${downloadId}" style="width:0%"></div>
      </div>
    `;
  } else if (type === 'convert') {
    card.innerHTML = `
      <div class="download-card-header">
        <span class="download-card-title" title="${esc(title)}">${truncate(title, 60)}</span>
        <span class="download-card-type-badge">MP3</span>
        <button class="download-card-dismiss hidden" onclick="dismissCard('${downloadId}')">✕</button>
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-bar" id="bar-${downloadId}" style="width:50%;animation:pulse 1.5s ease-in-out infinite"></div>
      </div>
      <div class="progress-meta">
        <span id="sts-${downloadId}" class="progress-status">Converting to MP3…</span>
      </div>
    `;
  } else {
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
  }

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

/* ── Progress polling ── */
function pollProgress(downloadId) {
  const timer = setInterval(async () => {
    try {
      const res = await fetch('/api/progress/' + downloadId);
      const data = await res.json();
      if (!res.ok) { clearInterval(timer); return; }

      updateCardUI(downloadId, data);

      if (data.status === 'finished' || data.status === 'partial') {
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
  if (!bar) return;

  bar.style.width = data.percent + '%';
  const pct = document.getElementById('pct-' + downloadId);
  if (pct) pct.textContent = data.percent + '%';

  if (data.type === 'images') {
    const imgCount = document.getElementById('img-count-' + downloadId);
    const sts = document.getElementById('sts-' + downloadId);
    const curFile = document.getElementById('cur-file-' + downloadId);

    if (imgCount) imgCount.textContent = `${data.completed} / ${data.total}${data.failed > 0 ? ` (${data.failed} failed)` : ''}`;
    if (sts) {
      if (data.status === 'starting') sts.textContent = 'Starting…';
      else if (data.status === 'downloading') sts.textContent = 'Downloading…';
      else if (data.status === 'finished') sts.textContent = 'Done!';
      else if (data.status === 'partial') sts.textContent = 'Done (with errors)';
    }
    if (curFile) curFile.textContent = data.current_file || '';
  } else if (data.type === 'channel') {
    const vidCount = document.getElementById('vid-count-' + downloadId);
    const sts = document.getElementById('sts-' + downloadId);
    const curVideo = document.getElementById('cur-video-' + downloadId);
    const subBar = document.getElementById('sub-bar-' + downloadId);

    if (vidCount) vidCount.textContent = `${data.completed} / ${data.total}${data.failed > 0 ? ` (${data.failed} failed)` : ''}`;
    if (sts) {
      if (data.status === 'starting') sts.textContent = 'Starting…';
      else if (data.status === 'downloading') sts.textContent = 'Downloading…';
      else if (data.status === 'finished') sts.textContent = 'Done!';
      else if (data.status === 'partial') sts.textContent = 'Done (with errors)';
    }
    if (curVideo) curVideo.textContent = data.current_title || '';
    if (subBar) subBar.style.width = (data.current_percent || 0) + '%';
  } else if (data.type === 'convert') {
    const sts = document.getElementById('sts-' + downloadId);
    if (sts) {
      if (data.status === 'converting') sts.textContent = 'Converting to MP3…';
      else if (data.status === 'finished') sts.textContent = 'Done — ' + (data.filename || '');
    }
  } else {
    const spd = document.getElementById('spd-' + downloadId);
    const eta = document.getElementById('eta-' + downloadId);
    const sts = document.getElementById('sts-' + downloadId);

    if (data.status === 'downloading') {
      if (spd) spd.textContent = data.speed || '';
      if (eta) eta.textContent = data.eta ? 'ETA ' + data.eta : '';
      if (sts) sts.textContent = data.downloaded && data.total ? data.downloaded + ' / ' + data.total : 'Downloading…';
    } else if (data.status === 'merging') {
      if (spd) spd.textContent = '';
      if (eta) eta.textContent = '';
      if (sts) sts.textContent = 'Merging…';
    } else if (data.status === 'starting') {
      if (sts) sts.textContent = 'Starting…';
    } else if (data.status === 'finished') {
      if (sts) sts.textContent = 'Done!';
      if (spd) spd.textContent = '';
      if (eta) eta.textContent = '';
    }
  }
}

function onDownloadFinished(downloadId, data) {
  const bar = document.getElementById('bar-' + downloadId);
  if (bar) bar.style.background = data.status === 'partial' ? 'var(--warning)' : 'var(--success)';

  if (data.type === 'images') {
    const sts = document.getElementById('sts-' + downloadId);
    if (sts) sts.textContent = data.status === 'partial'
      ? `Done — ${data.completed} saved, ${data.failed} failed`
      : `Done — ${data.completed} image${data.completed !== 1 ? 's' : ''} saved`;
    const curFile = document.getElementById('cur-file-' + downloadId);
    if (curFile) curFile.textContent = data.folder ? `Saved to: downloads/${data.folder}/` : '';
  } else if (data.type === 'channel') {
    const sts = document.getElementById('sts-' + downloadId);
    if (sts) sts.textContent = data.status === 'partial'
      ? `Done — ${data.completed} saved, ${data.failed} failed`
      : `Done — ${data.completed} video${data.completed !== 1 ? 's' : ''} saved`;
    const curVideo = document.getElementById('cur-video-' + downloadId);
    if (curVideo) curVideo.textContent = '';
    const subWrap = document.getElementById('sub-wrap-' + downloadId);
    if (subWrap) subWrap.style.display = 'none';
  } else {
    const titleEl = document.querySelector('#card-' + downloadId + ' .download-card-title');
    if (titleEl && data.filename) titleEl.textContent = data.filename;
    if (ffmpegAvailable && data.filename) {
      const card = document.getElementById('card-' + downloadId);
      if (card) {
        const convertBtn = document.createElement('button');
        convertBtn.className = 'btn btn-secondary btn-sm convert-mp3-btn';
        convertBtn.textContent = 'Convert to MP3';
        convertBtn.onclick = () => convertToMp3(data.filename, convertBtn);
        card.querySelector('.download-card-header').appendChild(convertBtn);
      }
    }
  }

  const dismissBtn = document.querySelector('#card-' + downloadId + ' .download-card-dismiss');
  if (dismissBtn) dismissBtn.classList.remove('hidden');

  if (data.type === 'images') {
    showToast(`Images saved: ${data.completed} downloaded${data.failed > 0 ? `, ${data.failed} failed` : ''}`);
  } else if (data.type === 'channel') {
    showToast(`Videos saved: ${data.completed}${data.failed > 0 ? `, ${data.failed} failed` : ''}`);
  } else {
    showToast('Download complete: ' + (data.filename || data.title || ''));
  }

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

async function convertToMp3(filename, btn) {
  btn.disabled = true;
  btn.textContent = 'Converting…';
  try {
    const res = await fetch('/api/convert-to-mp3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast('Error: ' + (data.error || 'Conversion failed'));
      btn.disabled = false;
      btn.textContent = 'Convert to MP3';
      return;
    }
    btn.remove();
    createDownloadCard(data.download_id, filename, 'convert');
    pollProgress(data.download_id);
  } catch (e) {
    showToast('Network error during conversion');
    btn.disabled = false;
    btn.textContent = 'Convert to MP3';
  }
}

/* ── Settings ── */
async function loadSettings() {
  try {
    const res = await fetch('/api/get-settings');
    const data = await res.json();
    const el = document.getElementById('settings-downloads-dir');
    if (el) el.value = data.downloads_dir || '';
  } catch (e) { /* silent */ }
}

function showSettingsModal() {
  loadSettings();
  document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettingsModal() {
  document.getElementById('settings-modal').classList.add('hidden');
}

async function saveSettings() {
  const dir = document.getElementById('settings-downloads-dir').value.trim();
  if (!dir) return;
  const btn = document.getElementById('settings-save-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/set-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloads_dir: dir }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast('Error: ' + (data.error || 'Failed to save'));
    } else {
      document.getElementById('settings-downloads-dir').value = data.downloads_dir;
      showToast('Settings saved');
      closeSettingsModal();
    }
  } catch (e) {
    showToast('Network error saving settings');
  } finally {
    btn.disabled = false;
  }
}

function resetDownloadsDir() {
  // Reset to default ./downloads/ relative to app
  document.getElementById('settings-downloads-dir').value = '';
  showToast('Clear the field and save to reset to default');
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
  t.getBoundingClientRect();
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
