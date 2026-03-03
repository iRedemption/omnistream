const activeStreams = [];
const twitchPlayers = new Map(); // uid -> Twitch.Player instance
let isAllPaused = false;

// ── URL Hash Sync ─────────────────────────────────────────────
// Encodes active streams (and chat/focus state) into the URL hash so
// the page can be refreshed or shared without losing configuration.
// Streams format : #channel1/channel2/yt_VIDEO_ID
// With chat open : #channel1/channel2?chat=channel1
// With focus     : #channel1/channel2?chat=channel1&focus=channel2
function updateUrlHash() {
    if (activeStreams.length === 0) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
        return;
    }
    const parts = activeStreams.map(s => {
        if (s.type === 'youtube') return 'yt_' + s.id;
        return s.id; // Twitch channel name
    });
    let hash = '#' + parts.join('/');

    let queryParts = [];

    // Add ?chat=<streamId> when the chat panel is open
    if (chatVisible && selectedChatUid) {
        const chatStream = activeStreams.find(s => s.uid === selectedChatUid);
        if (chatStream) {
            const chatId = chatStream.type === 'youtube'
                ? 'yt_' + chatStream.id
                : chatStream.id;
            queryParts.push('chat=' + chatId);
        }
    }

    // Add &focus=<streamId> when a stream is focused
    if (focusedStreamId) {
        const focusStream = activeStreams.find(s => s.uid === focusedStreamId);
        if (focusStream) {
            const focusId = focusStream.type === 'youtube'
                ? 'yt_' + focusStream.id
                : focusStream.id;
            queryParts.push('focus=' + focusId);
        }
    }

    if (queryParts.length > 0) {
        hash += '?' + queryParts.join('&');
    }

    history.replaceState(null, '', hash);
}

// Returns { streams: [...], chatStreamId: string|null, focusStreamId: string|null }
function decodeStreamsFromHash() {
    let raw = window.location.hash.slice(1); // remove leading '#'
    if (!raw) return { streams: [], chatStreamId: null, focusStreamId: null };

    // Split off the ?chat= suffix if present
    let chatStreamId = null;
    let focusStreamId = null;
    const qIdx = raw.indexOf('?');
    if (qIdx !== -1) {
        const query = raw.slice(qIdx + 1);
        raw = raw.slice(0, qIdx);

        const params = new URLSearchParams(query);
        chatStreamId = params.get('chat');
        focusStreamId = params.get('focus');
    }

    const streams = raw.split('/').filter(Boolean).map(part => {
        if (part.startsWith('yt_')) {
            const id = part.slice(3);
            return { type: 'youtube', id, label: 'YT: ' + id, uid: Date.now().toString() + Math.random() };
        }
        const id = decodeURIComponent(part).toLowerCase();
        return { type: 'twitch', id, label: id, uid: Date.now().toString() + Math.random() };
    });

    return { streams, chatStreamId, focusStreamId };
}
let focusedStreamId = null;
const streamsContainer = document.getElementById('streams-container');
const streamListEl = document.getElementById('active-streams-list');
const noStreamsMsg = document.getElementById('no-streams-msg');
const errorMsg = document.getElementById('add-error');
const inputEl = document.getElementById('stream-input');
const gapSize = 2; // px

// ── Chat State ───────────────────────────────────────────────
let chatVisible = false;
let selectedChatUid = ''; // uid of the stream whose chat is shown

// ── Stream Groups ───────────────────────────────────────────
let streamGroups = JSON.parse(localStorage.getItem('streamGroups') || '[]');
let expandedGroups = new Set(); // track which group IDs are expanded

// Sidebar toggle logic
const sidebar = document.getElementById('sidebar');
const openSidebarBtn = document.getElementById('open-sidebar-btn');
const closeSidebarBtn = document.getElementById('close-sidebar-btn');

openSidebarBtn.addEventListener('click', () => {
    sidebar.classList.remove('collapsed');
    document.body.classList.add('sidebar-open');
});

closeSidebarBtn.addEventListener('click', () => {
    sidebar.classList.add('collapsed');
    document.body.classList.remove('sidebar-open');
});

// Sidebar Position logic
const sidebarSideSelect = document.getElementById('sidebar-side-select');

function applySidebarSide(side) {
    const floatingControls = document.getElementById('floating-controls');
    if (side === 'right') {
        sidebar.classList.add('side-right');
        if (floatingControls) floatingControls.classList.add('side-right');
    } else {
        sidebar.classList.remove('side-right');
        if (floatingControls) floatingControls.classList.remove('side-right');
    }
}

const savedSidebarSide = localStorage.getItem('sidebarSide') || 'left';
if (sidebarSideSelect) {
    sidebarSideSelect.value = savedSidebarSide;
    applySidebarSide(savedSidebarSide);
    sidebarSideSelect.addEventListener('change', (e) => {
        const side = e.target.value;
        localStorage.setItem('sidebarSide', side);
        applySidebarSide(side);
    });
}

function extractYouTubeId(str) {
    // 1. Standard watch URL with robust parameter matching anywhere in the string
    const vMatch = str.match(/[?&]v=([a-zA-Z0-9_-]{11})(?:&|$)/i);
    if (vMatch) return vMatch[1];

    // 2. Short URL
    const shortMatch = str.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/i);
    if (shortMatch) return shortMatch[1];

    // 3. Live URL
    const liveMatch = str.match(/youtube\.com\/live\/([a-zA-Z0-9_-]{11})/i);
    if (liveMatch) return liveMatch[1];

    // 4. Embed URL
    const embedMatch = str.match(/youtube\.com\/(?:v|embed)\/([a-zA-Z0-9_-]{11})/i);
    if (embedMatch) return embedMatch[1];

    // 5. Shorts URL
    const shortsMatch = str.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/i);
    if (shortsMatch) return shortsMatch[1];

    return null;
}

function parseStreamInput(input) {
    input = input.trim();
    if (!input) return null;

    // If user pasted an <iframe> block, extract the src URL from it first
    const iframeSrcMatch = input.match(/src=["']([^"']+youtube[^"']+)["']/i);
    if (iframeSrcMatch) {
        input = iframeSrcMatch[1];
    }

    const ytId = extractYouTubeId(input);
    if (ytId) {
        return { type: 'youtube', id: ytId, label: `YT: ${ytId}` };
    }

    let twitchMatch = input.match(/(?:twitch\.tv\/)([a-zA-Z0-9_]+)/i);
    if (twitchMatch && twitchMatch[1]) {
        return { type: 'twitch', id: twitchMatch[1].toLowerCase(), label: twitchMatch[1] };
    }

    if (!input.includes(' ') && !input.includes('/') && !input.includes('.')) {
        return { type: 'twitch', id: input.toLowerCase(), label: input };
    }

    return null;
}

document.getElementById('add-stream-btn').addEventListener('click', handleAdd);

inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAdd();
});

function handleAdd() {
    errorMsg.textContent = '';
    const parsed = parseStreamInput(inputEl.value);

    if (!parsed) {
        errorMsg.textContent = 'Invalid channel or URL';
        return;
    }

    if (activeStreams.some(s => s.type === parsed.type && s.id === parsed.id)) {
        errorMsg.textContent = 'Stream already added';
        return;
    }

    const newMode = { ...parsed, uid: Date.now().toString() };
    activeStreams.push(newMode);

    inputEl.value = '';
    updateUrlHash();
    renderApp();
}

function removeStream(uid) {
    if (focusedStreamId === uid) {
        focusedStreamId = null;
    }
    // Destroy Twitch player instance if one exists for this stream
    if (twitchPlayers.has(uid)) {
        twitchPlayers.delete(uid);
    }
    const idx = activeStreams.findIndex(s => s.uid === uid);
    if (idx !== -1) {
        activeStreams.splice(idx, 1);
        updateUrlHash();
        renderApp();
    }
}

// Delete all streams
const clearAllBtn = document.getElementById('clear-all-btn');
if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
        if (activeStreams.length === 0) return;
        if (confirm('Are you sure you want to clear all active streams?')) {
            activeStreams.length = 0;
            focusedStreamId = null;
            isAllPaused = false;
            twitchPlayers.clear();
            updatePauseButtonIcon();
            updateUrlHash();
            renderApp();
        }
    });
}

const pauseAllBtn = document.getElementById('pause-all-btn');
if (pauseAllBtn) {
    pauseAllBtn.addEventListener('click', togglePauseAll);
}

function updatePauseButtonIcon() {
    if (!pauseAllBtn) return;
    if (isAllPaused) {
        pauseAllBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        pauseAllBtn.title = 'Unpause all streams';
    } else {
        pauseAllBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        pauseAllBtn.title = 'Pause all streams';
    }
}

function togglePauseAll() {
    isAllPaused = !isAllPaused;
    updatePauseButtonIcon();

    const iframes = streamsContainer.querySelectorAll('iframe');
    iframes.forEach(iframe => {

        const streamUid = iframe ? iframe.parentElement.dataset.uid : null;
        const stream = activeStreams.find(s => s.uid === streamUid);
        if (!stream) return;

        if (stream.type === 'youtube') {
            const command = isAllPaused ? 'pauseVideo' : 'playVideo';
            iframe.contentWindow.postMessage(JSON.stringify({
                event: 'command',
                func: command,
                args: ''
            }), '*');
        }
    });

    // Control Twitch streams via the SDK player references
    twitchPlayers.forEach((player) => {
        if (isAllPaused) {
            player.pause();
        } else {
            player.play();
        }
    });
}

const fullscreenBtn = document.getElementById('fullscreen-btn');
fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
            console.error(`Error attempting to enable full-screen mode: ${err.message}`);
        });
        fullscreenBtn.innerHTML = '<i class="fa-solid fa-compress"></i>';
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
            fullscreenBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
        }
    }
});

// Update icon when fullscreen state changes (e.g. via Esc key)
document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
        fullscreenBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
    } else {
        fullscreenBtn.innerHTML = '<i class="fa-solid fa-compress"></i>';
    }
    // Small delay to let the browser finish the transition before resizing
    setTimeout(resizeStreams, 100);
});

document.addEventListener('DOMContentLoaded', () => {
    const focusedModeSelect = document.getElementById('focused-mode-select');
    if (focusedModeSelect) {
        const savedFocusedMode = localStorage.getItem('focusedMode') || 'bottom';
        focusedModeSelect.value = savedFocusedMode;
        focusedModeSelect.addEventListener('change', (e) => {
            localStorage.setItem('focusedMode', e.target.value);
            resizeStreams();
        });
    }
    const alignmentSelect = document.getElementById('alignment-select');
    if (alignmentSelect) {
        const savedAlignment = localStorage.getItem('alignmentMode') || 'center';
        alignmentSelect.value = savedAlignment;
        alignmentSelect.addEventListener('change', (e) => {
            localStorage.setItem('alignmentMode', e.target.value);
            resizeStreams();
        });
    }
    const gridSizeSlider = document.getElementById('grid-size-slider');
    const gridSizeValue = document.getElementById('grid-size-value');
    if (gridSizeSlider) {
        // Load saved grid size
        const savedGridSize = localStorage.getItem('gridAreaSize');
        if (savedGridSize) {
            gridSizeSlider.value = savedGridSize;
            if (gridSizeValue) gridSizeValue.textContent = savedGridSize;
        }

        gridSizeSlider.addEventListener('input', () => {
            if (gridSizeValue) gridSizeValue.textContent = gridSizeSlider.value;
            // Save grid size
            localStorage.setItem('gridAreaSize', gridSizeSlider.value);
            resizeStreams();
        });
    }
});

function resizeStreams() {
    const num = activeStreams.length;
    if (num === 0) return;

    const W = streamsContainer.clientWidth;
    const H = streamsContainer.clientHeight;

    const wrappers = [];
    activeStreams.forEach(stream => {
        const el = document.querySelector(`.stream-wrapper[data-uid="${stream.uid}"]`);
        if (el) wrappers.push({ stream, el });
    });

    const focusedModeSelect = document.getElementById('focused-mode-select');
    const layoutMode = focusedModeSelect ? focusedModeSelect.value : 'bottom';

    const alignmentSelect = document.getElementById('alignment-select');
    const alignMode = alignmentSelect ? alignmentSelect.value : 'center';

    let focusedIndex = -1;
    if (focusedStreamId && num > 1) {
        focusedIndex = wrappers.findIndex(w => w.stream.uid === focusedStreamId);
    }

    if (focusedIndex === -1) {
        // NORMAL LAYOUT
        let bestW = 0, bestH = 0, bestCols = 1, bestRows = 1;
        for (let cols = 1; cols <= num; cols++) {
            const rows = Math.ceil(num / cols);
            const totalGapX = (cols + 1) * gapSize;
            const totalGapY = (rows + 1) * gapSize;

            let cellW = (W - totalGapX) / cols;
            let cellH = cellW / (16 / 9);

            if (cellH * rows + totalGapY > H) {
                cellH = (H - totalGapY) / rows;
                cellW = cellH * (16 / 9);
            }

            if (cellW > bestW) {
                bestW = cellW; bestH = cellH; bestCols = cols; bestRows = rows;
            }
        }

        const gridH = bestRows * bestH + (bestRows - 1) * gapSize;
        const startY = (H - gridH) / 2;

        wrappers.forEach((item, i) => {
            const row = Math.floor(i / bestCols);
            const col = i % bestCols;

            const itemsInThisRow = Math.min(bestCols, num - row * bestCols);
            const rowWidth = itemsInThisRow * bestW + (itemsInThisRow - 1) * gapSize;

            let rowStartX;
            if (alignMode === 'left') {
                rowStartX = gapSize;
            } else if (alignMode === 'right') {
                rowStartX = W - rowWidth - gapSize;
            } else {
                rowStartX = (W - rowWidth) / 2;
            }

            const x = rowStartX + col * (bestW + gapSize);
            const y = startY + row * (bestH + gapSize);

            item.el.style.position = 'absolute';
            item.el.style.width = Math.floor(bestW) + 'px';
            item.el.style.height = Math.floor(bestH) + 'px';
            item.el.style.left = Math.floor(x) + 'px';
            item.el.style.top = Math.floor(y) + 'px';
        });

        const gridSizeGroup = document.getElementById('grid-size-group');
        if (gridSizeGroup) gridSizeGroup.style.display = 'none';

    } else {
        // FOCUSED LAYOUT
        const focusedItem = wrappers.splice(focusedIndex, 1)[0];
        const othersCount = wrappers.length;

        const gridSizeGroup = document.getElementById('grid-size-group');
        if (gridSizeGroup) gridSizeGroup.style.display = 'flex';

        let focusArea = { x: 0, y: 0, w: 0, h: 0 };
        let gridArea = { x: 0, y: 0, w: 0, h: 0 };

        const gridSizeSlider = document.getElementById('grid-size-slider');
        const gridPercent = gridSizeSlider ? parseInt(gridSizeSlider.value) / 100 : 0.25;
        const availableW = W - 2 * gapSize;
        const availableH = H - 2 * gapSize;

        if (layoutMode === 'bottom') {
            gridArea.h = availableH * gridPercent;
            gridArea.w = availableW;
            gridArea.x = gapSize;
            gridArea.y = H - gapSize - gridArea.h;

            focusArea.w = availableW;
            focusArea.h = availableH - gridArea.h - gapSize;
            focusArea.x = gapSize;
            focusArea.y = gapSize;
        } else if (layoutMode === 'left') {
            gridArea.w = availableW * gridPercent;
            gridArea.h = availableH;
            gridArea.x = gapSize;
            gridArea.y = gapSize;

            focusArea.w = availableW - gridArea.w - gapSize;
            focusArea.h = availableH;
            focusArea.x = gapSize + gridArea.w + gapSize;
            focusArea.y = gapSize;
        } else if (layoutMode === 'right') {
            gridArea.w = availableW * gridPercent;
            gridArea.h = availableH;
            gridArea.x = W - gapSize - gridArea.w;
            gridArea.y = gapSize;

            focusArea.w = availableW - gridArea.w - gapSize;
            focusArea.h = availableH;
            focusArea.x = gapSize;
            focusArea.y = gapSize;
        }

        // Apply 16:9 to Focused Stream inside FocusArea
        let fw = focusArea.w;
        let fh = fw / (16 / 9);
        if (fh > focusArea.h) {
            fh = focusArea.h;
            fw = fh * (16 / 9);
        }
        const fx = focusArea.x + (focusArea.w - fw) / 2;
        const fy = focusArea.y + (focusArea.h - fh) / 2;

        focusedItem.el.style.position = 'absolute';
        focusedItem.el.style.width = Math.floor(fw) + 'px';
        focusedItem.el.style.height = Math.floor(fh) + 'px';
        focusedItem.el.style.left = Math.floor(fx) + 'px';
        focusedItem.el.style.top = Math.floor(fy) + 'px';

        // Apply grid layout to smaller streams in GridArea
        if (othersCount > 0) {
            let bestW = 0, bestH = 0, bestCols = 1, bestRows = 1;
            for (let cols = 1; cols <= othersCount; cols++) {
                const rows = Math.ceil(othersCount / cols);
                const totalGapX = (cols - 1) * gapSize;
                const totalGapY = (rows - 1) * gapSize;

                let cellW = (gridArea.w - totalGapX) / cols;
                let cellH = cellW / (16 / 9);

                if (cellH * rows + totalGapY > gridArea.h) {
                    cellH = (gridArea.h - totalGapY) / rows;
                    cellW = cellH * (16 / 9);
                }

                if (cellW > bestW) {
                    bestW = cellW; bestH = cellH; bestCols = cols; bestRows = rows;
                }
            }

            const gridH = bestRows * bestH + (bestRows - 1) * gapSize;
            const startY = gridArea.y + (gridArea.h - gridH) / 2;

            wrappers.forEach((item, i) => {
                const row = Math.floor(i / bestCols);
                const col = i % bestCols;

                const itemsInThisRow = Math.min(bestCols, othersCount - row * bestCols);
                const rowWidth = itemsInThisRow * bestW + (itemsInThisRow - 1) * gapSize;

                let rowStartX;
                if (alignMode === 'left') {
                    rowStartX = gridArea.x;
                } else if (alignMode === 'right') {
                    rowStartX = gridArea.x + gridArea.w - rowWidth;
                } else {
                    rowStartX = gridArea.x + (gridArea.w - rowWidth) / 2;
                }

                const x = rowStartX + col * (bestW + gapSize);
                const y = startY + row * (bestH + gapSize);

                item.el.style.position = 'absolute';
                item.el.style.width = Math.floor(bestW) + 'px';
                item.el.style.height = Math.floor(bestH) + 'px';
                item.el.style.left = Math.floor(x) + 'px';
                item.el.style.top = Math.floor(y) + 'px';
            });
        }
    }
}

window.addEventListener('resize', () => {
    clearTimeout(window.resizeTimer);
    window.resizeTimer = setTimeout(resizeStreams, 100);
});

function updateStreamListUI() {
    streamListEl.innerHTML = '';

    if (activeStreams.length === 0) {
        noStreamsMsg.style.display = 'block';
    } else {
        noStreamsMsg.style.display = 'none';

        activeStreams.forEach(stream => {
            const li = document.createElement('li');
            li.className = 'stream-item';

            const info = document.createElement('div');
            info.className = 'stream-item-info';

            const icon = document.createElement('i');
            icon.className = stream.type === 'twitch' ? 'fa-brands fa-twitch' : 'fa-brands fa-youtube';

            const text = document.createElement('span');
            text.textContent = stream.label;

            info.appendChild(icon);
            info.appendChild(text);

            const actions = document.createElement('div');
            actions.className = 'stream-actions';

            const focusBtn = document.createElement('button');
            focusBtn.className = 'focus-stream-btn' + (focusedStreamId === stream.uid ? ' active' : '');
            focusBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
            focusBtn.title = 'Focus Stream';
            focusBtn.onclick = () => {
                if (focusedStreamId === stream.uid) {
                    focusedStreamId = null;
                } else {
                    focusedStreamId = stream.uid;
                }
                updateUrlHash();
                renderApp();
                resizeStreams();
            };

            const btn = document.createElement('button');
            btn.className = 'remove-stream-btn';
            btn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            btn.title = 'Remove Stream';
            btn.onclick = () => removeStream(stream.uid);

            actions.appendChild(focusBtn);
            actions.appendChild(btn);

            li.appendChild(info);
            li.appendChild(actions);

            streamListEl.appendChild(li);
        });
    }
}

function updateStreamsIframes() {
    const currentIframes = new Map();
    Array.from(streamsContainer.children).forEach(el => {
        currentIframes.set(el.dataset.uid, el);
    });

    const parentHostname = window.location.hostname || "localhost";
    const originUrl = (window.location.origin && window.location.origin !== 'null')
        ? window.location.origin
        : "http://localhost"; // Fallback origin for local files

    activeStreams.forEach(stream => {
        if (!currentIframes.has(stream.uid)) {
            const wrapper = document.createElement('div');
            wrapper.className = 'stream-wrapper';
            wrapper.dataset.uid = stream.uid;

            if (stream.type === 'twitch') {
                // Use the Twitch Embed SDK for real pause/play control
                const targetDivId = `twitch-player-${stream.uid}`;
                const targetDiv = document.createElement('div');
                targetDiv.id = targetDivId;
                targetDiv.style.width = '100%';
                targetDiv.style.height = '100%';
                wrapper.appendChild(targetDiv);
                streamsContainer.appendChild(wrapper);

                // The SDK injects a sized iframe into targetDiv.
                // We size it after the player is ready via resizeStreams.
                const player = new Twitch.Player(targetDivId, {
                    channel: stream.id,
                    parent: [parentHostname, '127.0.0.1', 'localhost'],
                    muted: true,
                    autoplay: !isAllPaused,
                    width: '100%',
                    height: '100%',
                });
                twitchPlayers.set(stream.uid, player);
            } else if (stream.type === 'youtube') {
                const iframe = document.createElement('iframe');
                iframe.allowFullscreen = true;
                // Added enablejsapi=1 to allow control via postMessage
                iframe.src = `https://www.youtube.com/embed/${stream.id}?autoplay=${isAllPaused ? 0 : 1}&mute=1&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(originUrl)}`;
                iframe.setAttribute('allow', 'autoplay; encrypted-media; fullscreen');
                wrapper.appendChild(iframe);
                streamsContainer.appendChild(wrapper);
            }
        } else {
            currentIframes.delete(stream.uid);
        }
    });

    currentIframes.forEach(el => {
        streamsContainer.removeChild(el);
    });

    // Make sure we re-apply sizes just in case new iframes were added
    resizeStreams();
}

function renderApp() {
    updateStreamListUI();
    updateStreamsIframes();
    updateChatDropdown();
    renderGroupsUI();
}

// ── Chat feature ────────────────────────────────────────────
function buildChatUrl(stream) {
    if (!stream) return '';
    const hostname = window.location.hostname || 'localhost';
    if (stream.type === 'twitch') {
        // Twitch requires the parent domain in the embed URL
        return `https://www.twitch.tv/embed/${stream.id}/chat?darkpopout&parent=${hostname}`;
    } else if (stream.type === 'youtube') {
        // YouTube requires embed_domain to match the hosting page's domain
        return `https://www.youtube.com/live_chat?v=${stream.id}&embed_domain=${hostname}`;
    }
    return '';
}

function updateChatDropdown() {
    const select = document.getElementById('chat-stream-select');
    if (!select) return;

    // Save prior selection
    const prevUid = select.value;

    select.innerHTML = '<option value="">-- Select a stream --</option>';
    activeStreams.forEach(stream => {
        const opt = document.createElement('option');
        opt.value = stream.uid;
        const prefix = stream.type === 'twitch' ? '🟣' : '🔴';
        opt.textContent = `${prefix} ${stream.label}`;
        select.appendChild(opt);
    });

    // Restore selection if stream still exists
    if (activeStreams.some(s => s.uid === prevUid)) {
        select.value = prevUid;
        selectedChatUid = prevUid;
    } else {
        // Previously-selected stream removed; auto-pick first if possible
        if (activeStreams.length > 0) {
            select.value = activeStreams[0].uid;
            selectedChatUid = activeStreams[0].uid;
        } else {
            select.value = '';
            selectedChatUid = '';
        }
    }

    // If chat is visible, update the iframe src in case the stream changed
    if (chatVisible) {
        refreshChatIframe();
    }

    // Hide chat if no streams left
    if (activeStreams.length === 0 && chatVisible) {
        hideChatPanel();
    }
}

function refreshChatIframe() {
    const stream = activeStreams.find(s => s.uid === selectedChatUid);
    const iframe = document.getElementById('chat-iframe');
    const label = document.getElementById('chat-panel-label');
    if (!iframe) return;

    if (stream) {
        const url = buildChatUrl(stream);
        if (iframe.src !== url) iframe.src = url;
        if (label) {
            const typeIcon = stream.type === 'twitch'
                ? '<i class="fa-brands fa-twitch" style="color:#a970ff;"></i>'
                : '<i class="fa-brands fa-youtube" style="color:#ff0000;"></i>';
            label.innerHTML = `${typeIcon} ${stream.label} — Chat`;
        }
    } else {
        iframe.src = '';
        if (label) label.innerHTML = '<i class="fa-solid fa-comment"></i> Chat';
    }
}

function showChatPanel() {
    if (activeStreams.length === 0) return;
    chatVisible = true;
    const panel = document.getElementById('chat-panel');
    if (panel) panel.style.display = 'flex';
    const btn = document.getElementById('chat-toggle-btn');
    if (btn) { btn.innerHTML = '<i class="fa-solid fa-comment-slash"></i> Hide'; btn.classList.add('active'); }
    refreshChatIframe();
    updateUrlHash();
    // Streams need resizing since the available width changed
    setTimeout(resizeStreams, 50);
}

function hideChatPanel() {
    chatVisible = false;
    const panel = document.getElementById('chat-panel');
    if (panel) panel.style.display = 'none';
    const btn = document.getElementById('chat-toggle-btn');
    if (btn) { btn.innerHTML = '<i class="fa-solid fa-comment"></i> Show'; btn.classList.remove('active'); }
    updateUrlHash();
    setTimeout(resizeStreams, 50);
}

// Wire up chat UI events after DOM is ready
document.getElementById('chat-toggle-btn').addEventListener('click', () => {
    if (chatVisible) hideChatPanel(); else showChatPanel();
});

document.getElementById('chat-close-btn').addEventListener('click', () => {
    hideChatPanel();
});

document.getElementById('chat-stream-select').addEventListener('change', (e) => {
    selectedChatUid = e.target.value;
    if (chatVisible) {
        refreshChatIframe();
        updateUrlHash();
    }
});

// Load streams (and chat/focus state) from URL hash on startup
const { streams: hashStreams, chatStreamId, focusStreamId } = decodeStreamsFromHash();
hashStreams.forEach(s => activeStreams.push(s));

// Sidebar initial state: Show on home page, hide if loading streams
if (activeStreams.length > 0) {
    sidebar.classList.add('collapsed');
    document.body.classList.remove('sidebar-open');
} else {
    sidebar.classList.remove('collapsed');
    document.body.classList.add('sidebar-open');
}

renderApp();
resizeStreams();

// Restore focus state from URL if &focus= was present
if (focusStreamId && activeStreams.length > 0) {
    let focusStream;
    if (focusStreamId.startsWith('yt_')) {
        const ytId = focusStreamId.slice(3);
        focusStream = activeStreams.find(s => s.type === 'youtube' && s.id === ytId);
    } else {
        focusStream = activeStreams.find(s => s.type === 'twitch' && s.id === focusStreamId);
    }
    if (focusStream) {
        focusedStreamId = focusStream.uid;
        // Need to render and resize again to show focus
        renderApp();
        resizeStreams();
    }
}

// Restore chat panel from URL if ?chat= was present
if (chatStreamId && activeStreams.length > 0) {
    let chatStream;
    if (chatStreamId.startsWith('yt_')) {
        const ytId = chatStreamId.slice(3);
        chatStream = activeStreams.find(s => s.type === 'youtube' && s.id === ytId);
    } else {
        chatStream = activeStreams.find(s => s.type === 'twitch' && s.id === chatStreamId);
    }
    if (chatStream) {
        selectedChatUid = chatStream.uid;
        const select = document.getElementById('chat-stream-select');
        if (select) select.value = selectedChatUid;
        showChatPanel();
    }
}

// ═══════════════════════════════════════════════════════════
// Stream Groups
// ═══════════════════════════════════════════════════════════
function saveGroupsToStorage() {
    localStorage.setItem('streamGroups', JSON.stringify(streamGroups));
}

function openSaveGroupModal() {
    const twitchStreams = activeStreams.filter(s => s.type === 'twitch');
    if (twitchStreams.length === 0) {
        // Re-use the add-error element briefly to show feedback
        const err = document.getElementById('add-error');
        err.textContent = 'No Twitch streams to save.';
        setTimeout(() => { err.textContent = ''; }, 2500);
        return;
    }
    const modal = document.getElementById('save-group-modal');
    const input = document.getElementById('group-name-input');
    const errEl = document.getElementById('group-name-error');
    input.value = '';
    errEl.textContent = '';
    modal.style.display = 'flex';
    setTimeout(() => input.focus(), 50);
}

function closeSaveGroupModal() {
    document.getElementById('save-group-modal').style.display = 'none';
}

function confirmSaveGroup() {
    const input = document.getElementById('group-name-input');
    const errEl = document.getElementById('group-name-error');
    const name = input.value.trim();
    if (!name) {
        errEl.textContent = 'Please enter a group name.';
        return;
    }
    const twitchStreams = activeStreams
        .filter(s => s.type === 'twitch')
        .map(s => ({ type: s.type, id: s.id, label: s.label }));

    const group = {
        id: Date.now().toString(),
        name,
        streams: twitchStreams,
    };
    streamGroups.push(group);
    saveGroupsToStorage();
    closeSaveGroupModal();
    renderGroupsUI();
}

function deleteGroup(groupId) {
    streamGroups = streamGroups.filter(g => g.id !== groupId);
    expandedGroups.delete(groupId);
    saveGroupsToStorage();
    renderGroupsUI();
}

function loadGroup(groupId) {
    const group = streamGroups.find(g => g.id === groupId);
    if (!group) return;
    // Overwrite active streams with group streams
    activeStreams.length = 0;
    focusedStreamId = null;
    twitchPlayers.clear();
    group.streams.forEach(s => {
        activeStreams.push({ ...s, uid: Date.now().toString() + Math.random() });
    });
    updateUrlHash();
    renderApp();
    resizeStreams();
}

function addStreamFromGroup(stream) {
    if (activeStreams.some(s => s.type === stream.type && s.id === stream.id)) return;
    activeStreams.push({ ...stream, uid: Date.now().toString() + Math.random() });
    updateUrlHash();
    renderApp();
    resizeStreams();
}

function renderGroupsUI() {
    const list = document.getElementById('groups-list');
    const noMsg = document.getElementById('no-groups-msg');
    if (!list) return;
    list.innerHTML = '';

    if (streamGroups.length === 0) {
        noMsg.style.display = 'block';
        return;
    }
    noMsg.style.display = 'none';

    streamGroups.forEach(group => {
        const isExpanded = expandedGroups.has(group.id);

        // Group row (clickable header)
        const groupEl = document.createElement('div');
        groupEl.className = 'group-item';

        const header = document.createElement('div');
        header.className = 'group-header';

        const chevron = document.createElement('i');
        chevron.className = `fa-solid ${isExpanded ? 'fa-chevron-down' : 'fa-chevron-right'} group-chevron`;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'group-name';
        nameSpan.textContent = group.name;

        const countBadge = document.createElement('span');
        countBadge.className = 'group-count-badge';
        countBadge.textContent = group.streams.length;

        const headerActions = document.createElement('div');
        headerActions.className = 'group-header-actions';

        // Load (overwrite) button
        const loadBtn = document.createElement('button');
        loadBtn.className = 'group-action-btn group-load-btn';
        loadBtn.title = 'Load group (replaces current streams)';
        loadBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        loadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            loadGroup(group.id);
        });

        // Delete button
        const delBtn = document.createElement('button');
        delBtn.className = 'group-action-btn group-delete-btn';
        delBtn.title = 'Delete group';
        delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteGroup(group.id);
        });

        headerActions.appendChild(loadBtn);
        headerActions.appendChild(delBtn);

        const leftSide = document.createElement('div');
        leftSide.className = 'group-header-left';
        leftSide.appendChild(chevron);
        leftSide.appendChild(nameSpan);
        leftSide.appendChild(countBadge);

        header.appendChild(leftSide);
        header.appendChild(headerActions);

        // Toggle expand on header click
        header.addEventListener('click', () => {
            if (expandedGroups.has(group.id)) {
                expandedGroups.delete(group.id);
            } else {
                expandedGroups.add(group.id);
            }
            renderGroupsUI();
        });

        groupEl.appendChild(header);

        // Stream list inside group (shown when expanded)
        if (isExpanded) {
            const streamList = document.createElement('div');
            streamList.className = 'group-stream-list';

            if (group.streams.length === 0) {
                const emptyNote = document.createElement('div');
                emptyNote.className = 'group-empty-note';
                emptyNote.textContent = 'No streams in this group.';
                streamList.appendChild(emptyNote);
            } else {
                group.streams.forEach(stream => {
                    const row = document.createElement('div');
                    row.className = 'group-stream-row';

                    const info = document.createElement('div');
                    info.className = 'group-stream-info';

                    const icon = document.createElement('i');
                    icon.className = 'fa-brands fa-twitch';

                    const label = document.createElement('span');
                    label.textContent = stream.label;

                    info.appendChild(icon);
                    info.appendChild(label);

                    const addBtn = document.createElement('button');
                    addBtn.className = 'group-stream-add-btn';
                    addBtn.title = `Add ${stream.label} to current streams`;
                    addBtn.innerHTML = '<i class="fa-solid fa-plus"></i>';
                    addBtn.addEventListener('click', () => addStreamFromGroup(stream));

                    row.appendChild(info);
                    row.appendChild(addBtn);
                    streamList.appendChild(row);
                });
            }

            groupEl.appendChild(streamList);
        }

        list.appendChild(groupEl);
    });
}

// Modal event wiring
document.getElementById('save-group-btn').addEventListener('click', openSaveGroupModal);
document.getElementById('modal-cancel-btn').addEventListener('click', closeSaveGroupModal);
document.getElementById('modal-save-btn').addEventListener('click', confirmSaveGroup);
document.getElementById('group-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmSaveGroup();
    if (e.key === 'Escape') closeSaveGroupModal();
});
// Click outside modal box to dismiss
document.getElementById('save-group-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('save-group-modal')) closeSaveGroupModal();
});
