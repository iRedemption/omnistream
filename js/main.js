// ── Application Entry Point ───────────────────────────────
// Imports everything, wires up all global event listeners,
// and performs the initial load/render sequence.

import {
    activeStreams,
    twitchPlayers,
    focusedStreamId,
    chatVisible,       // live binding — always reflects the current value
    setFocusedStreamId,
    setIsAllPaused,
    selectedChatUid,
    setSelectedChatUid,
} from './state.js';

import { updateUrlHash, decodeStreamsFromHash } from './urlSync.js';

import {
    resizeStreams,
    togglePauseAll,
    updatePauseButtonIcon,
    showChatPanel,
    hideChatPanel,
    refreshChatIframe,
    parseStreamInput,
} from './players.js';

import {
    renderApp,
    handleAdd,
    removeStream,
    updateStreamListUI,
    updateChatDropdown,
    renderGroupsUI,
    openSaveGroupModal,
    closeSaveGroupModal,
    confirmSaveGroup,
} from './uiRender.js';

// ── Sidebar Toggle ────────────────────────────────────────
const sidebar = document.getElementById('sidebar');
const openSidebarBtn = document.getElementById('open-sidebar-btn');
const closeSidebarBtn = document.getElementById('close-sidebar-btn');
const overlay = document.getElementById('sidebar-overlay');

openSidebarBtn.addEventListener('click', () => {
    sidebar.classList.remove('collapsed');
    document.body.classList.add('sidebar-open');
});

function collapseSidebar() {
    sidebar.classList.add('collapsed');
    document.body.classList.remove('sidebar-open');
}

closeSidebarBtn.addEventListener('click', collapseSidebar);
if (overlay) overlay.addEventListener('click', collapseSidebar);

// ── Sidebar Position ──────────────────────────────────────
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

// ── Add Stream Controls ───────────────────────────────────
const addStreamBtn = document.getElementById('add-stream-btn');
const inputEl = document.getElementById('stream-input');

addStreamBtn.addEventListener('click', () => handleAdd(parseStreamInput));
inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAdd(parseStreamInput);
});

// Update platform icon as the user types
const platformIconContainer = document.getElementById('platform-icon-container');
if (platformIconContainer) {
    inputEl.addEventListener('input', () => {
        const parsed = parseStreamInput(inputEl.value);
        if (!parsed || parsed.type === 'twitch') {
            platformIconContainer.innerHTML = '<i class="fa-brands fa-twitch" style="color: #a970ff;"></i>';
        } else {
            platformIconContainer.innerHTML = '<i class="fa-brands fa-youtube" style="color: #ff0000;"></i>';
        }
    });
}

// ── Clear All Streams ─────────────────────────────────────
const clearAllBtn = document.getElementById('clear-all-btn');
if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
        if (activeStreams.length === 0) return;
        if (confirm('Are you sure you want to clear all active streams?')) {
            activeStreams.length = 0;
            setFocusedStreamId(null);
            setIsAllPaused(false);
            twitchPlayers.clear();
            updatePauseButtonIcon();
            updateUrlHash();
            renderApp();
        }
    });
}

// ── Pause / Fullscreen Buttons ────────────────────────────
const pauseAllBtn = document.getElementById('pause-all-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');

if (pauseAllBtn) {
    pauseAllBtn.addEventListener('click', togglePauseAll);
}

fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
            console.error(`Fullscreen error: ${err.message}`);
        });
        fullscreenBtn.innerHTML = '<i class="fa-solid fa-compress"></i>';
    } else {
        document.exitFullscreen();
        fullscreenBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
    }
});

document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
        fullscreenBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
    } else {
        fullscreenBtn.innerHTML = '<i class="fa-solid fa-compress"></i>';
    }
    setTimeout(resizeStreams, 100);
});

// ── Settings: Focus Mode / Alignment / Slider ────────────
// Note: <script type="module"> is deferred by default, so the DOM is
// already fully parsed by the time this code runs. No DOMContentLoaded
// wrapper is needed.

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
    const savedGridSize = localStorage.getItem('gridAreaSize');
    if (savedGridSize) {
        gridSizeSlider.value = savedGridSize;
        if (gridSizeValue) gridSizeValue.textContent = savedGridSize;
    }
    gridSizeSlider.addEventListener('input', () => {
        if (gridSizeValue) gridSizeValue.textContent = gridSizeSlider.value;
        localStorage.setItem('gridAreaSize', gridSizeSlider.value);
        resizeStreams();
    });
}


// ── Window Resize ─────────────────────────────────────────
window.addEventListener('resize', () => {
    clearTimeout(window.resizeTimer);
    window.resizeTimer = setTimeout(resizeStreams, 100);
});

// ── Chat Controls ─────────────────────────────────────────
document.getElementById('chat-toggle-btn').addEventListener('click', () => {
    // `chatVisible` is a live binding from state.js — always current
    if (chatVisible) hideChatPanel(); else showChatPanel();
});

document.getElementById('chat-close-btn').addEventListener('click', () => {
    hideChatPanel();
});

document.getElementById('chat-stream-select').addEventListener('change', (e) => {
    setSelectedChatUid(e.target.value);
    if (chatVisible) {
        refreshChatIframe();
        updateUrlHash();
    }
});

// ── Save Group Modal ──────────────────────────────────────
document.getElementById('save-group-btn').addEventListener('click', openSaveGroupModal);
document.getElementById('modal-cancel-btn').addEventListener('click', closeSaveGroupModal);
document.getElementById('modal-save-btn').addEventListener('click', confirmSaveGroup);
document.getElementById('group-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmSaveGroup();
    if (e.key === 'Escape') closeSaveGroupModal();
});
document.getElementById('save-group-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('save-group-modal')) closeSaveGroupModal();
});

// ═══════════════════════════════════════════════════════════
// Initialisation: load from URL hash, then render
// ═══════════════════════════════════════════════════════════

const { streams: hashStreams, chatStreamId, focusStreamId } = decodeStreamsFromHash();
hashStreams.forEach(s => activeStreams.push(s));

// Show or hide sidebar depending on whether streams were loaded
if (activeStreams.length > 0) {
    sidebar.classList.add('collapsed');
    document.body.classList.remove('sidebar-open');
} else {
    sidebar.classList.remove('collapsed');
    document.body.classList.add('sidebar-open');
}

renderApp();
resizeStreams();

// Restore focused stream from URL
if (focusStreamId && activeStreams.length > 0) {
    let focusStream;
    if (focusStreamId.startsWith('yt_')) {
        const ytId = focusStreamId.slice(3);
        focusStream = activeStreams.find(s => s.type === 'youtube' && s.id === ytId);
    } else {
        focusStream = activeStreams.find(s => s.type === 'twitch' && s.id === focusStreamId);
    }
    if (focusStream) {
        setFocusedStreamId(focusStream.uid);
        renderApp();
        resizeStreams();
    }
}

// Restore chat panel from URL
if (chatStreamId && activeStreams.length > 0) {
    let chatStream;
    if (chatStreamId.startsWith('yt_')) {
        const ytId = chatStreamId.slice(3);
        chatStream = activeStreams.find(s => s.type === 'youtube' && s.id === ytId);
    } else {
        chatStream = activeStreams.find(s => s.type === 'twitch' && s.id === chatStreamId);
    }
    if (chatStream) {
        setSelectedChatUid(chatStream.uid);
        const select = document.getElementById('chat-stream-select');
        if (select) select.value = chatStream.uid;
        showChatPanel();
    }
}
