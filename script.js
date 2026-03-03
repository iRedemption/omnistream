const activeStreams = [];
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

function parseStreamInput(input) {
    input = input.trim();
    if (!input) return null;

    let ytMatch = input.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=|live\/)|youtu\.be\/)([^"&?\/\s]{11})/i);
    if (ytMatch && ytMatch[1]) {
        return { type: 'youtube', id: ytMatch[1], label: `YT: ${ytMatch[1]}` };
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
    const idx = activeStreams.findIndex(s => s.uid === uid);
    if (idx !== -1) {
        activeStreams.splice(idx, 1);
        renderApp();
    }
}

document.getElementById('clear-all-btn').addEventListener('click', () => {
    activeStreams.length = 0;
    focusedStreamId = null;
    renderApp();
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

    activeStreams.forEach(stream => {
        if (!currentIframes.has(stream.uid)) {
            const wrapper = document.createElement('div');
            wrapper.className = 'stream-wrapper';
            wrapper.dataset.uid = stream.uid;

            const iframe = document.createElement('iframe');
            iframe.allowFullscreen = true;

            if (stream.type === 'twitch') {
                iframe.src = `https://player.twitch.tv/?channel=${stream.id}&parent=${parentHostname}&parent=127.0.0.1&muted=false`;
            } else if (stream.type === 'youtube') {
                iframe.src = `https://www.youtube.com/embed/${stream.id}?autoplay=1`;
            }

            iframe.setAttribute('allow', 'autoplay; encrypted-media; fullscreen');

            wrapper.appendChild(iframe);
            streamsContainer.appendChild(wrapper);
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
