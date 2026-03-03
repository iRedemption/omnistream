// ── Players: Twitch SDK, YouTube iframes, play/pause ──────
import {
    activeStreams,
    twitchPlayers,
    isAllPaused,
    setIsAllPaused,
    chatVisible,
    setChatVisible,
    selectedChatUid,
    focusedStreamId,
    gapSize,
} from './state.js';

import { updateUrlHash } from './urlSync.js';

import {
    calcNormalLayout,
    calcFocusAreas,
    fitAspect,
    calcFocusedGridTiles,
} from './layoutMath.js';

// ── Input Parsing ─────────────────────────────────────────

/**
 * Extract a YouTube video ID from any YouTube URL variant.
 * @param {string} str
 * @returns {string|null}
 */
export function extractYouTubeId(str) {
    const vMatch = str.match(/[?&]v=([a-zA-Z0-9_-]{11})(?:&|$)/i);
    if (vMatch) return vMatch[1];

    const shortMatch = str.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/i);
    if (shortMatch) return shortMatch[1];

    const liveMatch = str.match(/youtube\.com\/live\/([a-zA-Z0-9_-]{11})/i);
    if (liveMatch) return liveMatch[1];

    const embedMatch = str.match(/youtube\.com\/(?:v|embed)\/([a-zA-Z0-9_-]{11})/i);
    if (embedMatch) return embedMatch[1];

    const shortsMatch = str.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/i);
    if (shortsMatch) return shortsMatch[1];

    return null;
}

/**
 * Parse a user-entered stream string into a stream descriptor,
 * or return null if the input is unrecognised.
 *
 * @param {string} input
 * @returns {{ type: 'twitch'|'youtube', id: string, label: string }|null}
 */
export function parseStreamInput(input) {
    input = input.trim();
    if (!input) return null;

    // Handle pasted <iframe> blocks — extract the src URL
    const iframeSrcMatch = input.match(/src=["']([^"']+youtube[^"']+)["']/i);
    if (iframeSrcMatch) {
        input = iframeSrcMatch[1];
    }

    const ytId = extractYouTubeId(input);
    if (ytId) {
        return { type: 'youtube', id: ytId, label: `YT: ${ytId}` };
    }

    const twitchMatch = input.match(/(?:twitch\.tv\/)([a-zA-Z0-9_]+)/i);
    if (twitchMatch && twitchMatch[1]) {
        return { type: 'twitch', id: twitchMatch[1].toLowerCase(), label: twitchMatch[1] };
    }

    if (!input.includes(' ') && !input.includes('/') && !input.includes('.')) {
        return { type: 'twitch', id: input.toLowerCase(), label: input };
    }

    return null;
}

// ── Grid Resize ───────────────────────────────────────────

/**
 * Read DOM elements and settings, then position every .stream-wrapper
 * absolutely to fill the streams container with the optimal layout.
 */
export function resizeStreams() {
    const num = activeStreams.length;
    if (num === 0) return;

    const streamsContainer = document.getElementById('streams-container');
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

    const gridSizeGroup = document.getElementById('grid-size-group');

    if (focusedIndex === -1) {
        // ── Normal layout ─────────────────────────────────
        const positions = calcNormalLayout(num, W, H, gapSize, alignMode);
        wrappers.forEach(({ el }, i) => {
            const p = positions[i];
            el.style.position = 'absolute';
            el.style.width = p.w + 'px';
            el.style.height = p.h + 'px';
            el.style.left = p.x + 'px';
            el.style.top = p.y + 'px';
        });
        if (gridSizeGroup) gridSizeGroup.style.display = 'none';

    } else {
        // ── Focused layout ────────────────────────────────
        const focusedItem = wrappers.splice(focusedIndex, 1)[0];
        const othersCount = wrappers.length;

        if (gridSizeGroup) gridSizeGroup.style.display = 'flex';

        const gridSizeSlider = document.getElementById('grid-size-slider');
        const gridPercent = gridSizeSlider ? parseInt(gridSizeSlider.value) / 100 : 0.25;

        const { focusArea, gridArea } = calcFocusAreas(W, H, gapSize, layoutMode, gridPercent);

        // Position the focused stream (16:9 centred inside focusArea)
        const fp = fitAspect(focusArea);
        focusedItem.el.style.position = 'absolute';
        focusedItem.el.style.width = fp.w + 'px';
        focusedItem.el.style.height = fp.h + 'px';
        focusedItem.el.style.left = fp.x + 'px';
        focusedItem.el.style.top = fp.y + 'px';

        // Position the smaller grid tiles
        if (othersCount > 0) {
            const positions = calcFocusedGridTiles(othersCount, gridArea, gapSize, alignMode);
            wrappers.forEach(({ el }, i) => {
                const p = positions[i];
                el.style.position = 'absolute';
                el.style.width = p.w + 'px';
                el.style.height = p.h + 'px';
                el.style.left = p.x + 'px';
                el.style.top = p.y + 'px';
            });
        }
    }
}

// ── Stream Iframes ────────────────────────────────────────

/**
 * Sync the DOM's .stream-wrapper elements with activeStreams:
 * add new iframes/Twitch embeds, remove stale ones.
 */
export function updateStreamsIframes() {
    const streamsContainer = document.getElementById('streams-container');

    const currentIframes = new Map();
    Array.from(streamsContainer.children).forEach(el => {
        currentIframes.set(el.dataset.uid, el);
    });

    const parentHostname = window.location.hostname || 'localhost';
    const originUrl = (window.location.origin && window.location.origin !== 'null')
        ? window.location.origin
        : 'http://localhost';

    activeStreams.forEach(stream => {
        if (!currentIframes.has(stream.uid)) {
            const wrapper = document.createElement('div');
            wrapper.className = 'stream-wrapper';
            wrapper.dataset.uid = stream.uid;

            if (stream.type === 'twitch') {
                const targetDivId = `twitch-player-${stream.uid}`;
                const targetDiv = document.createElement('div');
                targetDiv.id = targetDivId;
                targetDiv.style.width = '100%';
                targetDiv.style.height = '100%';
                wrapper.appendChild(targetDiv);
                streamsContainer.appendChild(wrapper);

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
                iframe.src = `https://www.youtube.com/embed/${stream.id}?autoplay=${isAllPaused ? 0 : 1}&mute=1&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(originUrl)}`;
                iframe.setAttribute('allow', 'autoplay; encrypted-media; fullscreen');
                wrapper.appendChild(iframe);
                streamsContainer.appendChild(wrapper);
            }
        } else {
            currentIframes.delete(stream.uid);
        }
    });

    // Remove wrappers whose streams are no longer active
    currentIframes.forEach(el => streamsContainer.removeChild(el));

    resizeStreams();
}

// ── Pause / Play ──────────────────────────────────────────

/**
 * Update the pause button's icon to reflect the current paused state.
 */
export function updatePauseButtonIcon() {
    const pauseAllBtn = document.getElementById('pause-all-btn');
    if (!pauseAllBtn) return;
    if (isAllPaused) {
        pauseAllBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        pauseAllBtn.title = 'Unpause all streams';
    } else {
        pauseAllBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        pauseAllBtn.title = 'Pause all streams';
    }
}

/**
 * Toggle the pause/play state for all active streams.
 */
export function togglePauseAll() {
    setIsAllPaused(!isAllPaused);
    updatePauseButtonIcon();

    const streamsContainer = document.getElementById('streams-container');
    const iframes = streamsContainer.querySelectorAll('iframe');

    iframes.forEach(iframe => {
        const streamUid = iframe.parentElement?.dataset.uid;
        const stream = activeStreams.find(s => s.uid === streamUid);
        if (!stream) return;

        if (stream.type === 'youtube') {
            const command = isAllPaused ? 'pauseVideo' : 'playVideo';
            iframe.contentWindow.postMessage(JSON.stringify({
                event: 'command',
                func: command,
                args: '',
            }), '*');
        }
    });

    twitchPlayers.forEach(player => {
        if (isAllPaused) {
            player.pause();
        } else {
            player.play();
        }
    });
}

// ── Chat ──────────────────────────────────────────────────

/**
 * Build the embed chat URL for a given stream descriptor.
 * @param {{ type: string, id: string }} stream
 * @returns {string}
 */
export function buildChatUrl(stream) {
    if (!stream) return '';
    const hostname = window.location.hostname || 'localhost';
    if (stream.type === 'twitch') {
        return `https://www.twitch.tv/embed/${stream.id}/chat?darkpopout&parent=${hostname}`;
    } else if (stream.type === 'youtube') {
        return `https://www.youtube.com/live_chat?v=${stream.id}&embed_domain=${hostname}`;
    }
    return '';
}

/**
 * Reload the chat iframe src to match the currently selected chat stream.
 */
export function refreshChatIframe() {
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

/**
 * Show the chat panel (if there are active streams).
 */
export function showChatPanel() {
    if (activeStreams.length === 0) return;
    setChatVisible(true);
    const panel = document.getElementById('chat-panel');
    if (panel) panel.style.display = 'flex';
    const btn = document.getElementById('chat-toggle-btn');
    if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-comment-slash"></i> Hide';
        btn.classList.add('active');
    }
    refreshChatIframe();
    updateUrlHash();
    setTimeout(resizeStreams, 50);
}

/**
 * Hide the chat panel.
 */
export function hideChatPanel() {
    setChatVisible(false);
    const panel = document.getElementById('chat-panel');
    if (panel) panel.style.display = 'none';
    const btn = document.getElementById('chat-toggle-btn');
    if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-comment"></i> Show';
        btn.classList.remove('active');
    }
    updateUrlHash();
    setTimeout(resizeStreams, 50);
}
