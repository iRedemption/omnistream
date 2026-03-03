const activeStreams = [];
const twitchPlayers = new Map(); // uid -> Twitch.Player instance
let isAllPaused = false;
let focusedStreamId = null;
const streamsContainer = document.getElementById('streams-container');
const streamListEl = document.getElementById('active-streams-list');
const streamCountEl = document.getElementById('stream-count');
const noStreamsMsg = document.getElementById('no-streams-msg');
const errorMsg = document.getElementById('add-error');
const inputEl = document.getElementById('stream-input');
const gapSize = 2; // px

// Sidebar toggle logic
const sidebar = document.getElementById('sidebar');
const openSidebarBtn = document.getElementById('open-sidebar-btn');
const closeSidebarBtn = document.getElementById('close-sidebar-btn');

openSidebarBtn.addEventListener('click', () => {
    sidebar.classList.remove('collapsed');
    setTimeout(resizeStreams, 300); // Wait for transition
});

closeSidebarBtn.addEventListener('click', () => {
    sidebar.classList.add('collapsed');
    setTimeout(resizeStreams, 300); // Wait for transition
});

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
        renderApp();
    }
}

document.getElementById('clear-all-btn').addEventListener('click', () => {
    activeStreams.length = 0;
    focusedStreamId = null;
    isAllPaused = false;
    twitchPlayers.clear();
    updatePauseButtonIcon();
    renderApp();
});

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
        focusedModeSelect.addEventListener('change', resizeStreams);
    }
    const alignmentSelect = document.getElementById('alignment-select');
    if (alignmentSelect) {
        alignmentSelect.addEventListener('change', resizeStreams);
    }
    const gridSizeSlider = document.getElementById('grid-size-slider');
    const gridSizeValue = document.getElementById('grid-size-value');
    if (gridSizeSlider) {
        gridSizeSlider.addEventListener('input', () => {
            if (gridSizeValue) gridSizeValue.textContent = gridSizeSlider.value;
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

        const gridW = bestCols * bestW + (bestCols - 1) * gapSize;
        const gridH = bestRows * bestH + (bestRows - 1) * gapSize;
        const startX = (W - gridW) / 2;
        const startY = alignMode === 'top' ? gapSize : (H - gridH) / 2;

        wrappers.forEach((item, i) => {
            const col = i % bestCols;
            const row = Math.floor(i / bestCols);
            const x = startX + col * (bestW + gapSize);
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

            const gridW = bestCols * bestW + (bestCols - 1) * gapSize;
            const gridH = bestRows * bestH + (bestRows - 1) * gapSize;
            const startX = gridArea.x + (gridArea.w - gridW) / 2;
            const startY = alignMode === 'top' ? gridArea.y : gridArea.y + (gridArea.h - gridH) / 2;

            wrappers.forEach((item, i) => {
                const col = i % bestCols;
                const row = Math.floor(i / bestCols);
                const x = startX + col * (bestW + gapSize);
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
    streamCountEl.textContent = activeStreams.length;
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
}

// Init
renderApp();
resizeStreams();