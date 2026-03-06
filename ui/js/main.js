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
    syncVods,
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

import { initSidebarCollapsibility } from './collapsible.js';
import { initFollowedChannels } from './followed_channels.js';

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
const sidebarSideToggle = document.getElementById('sidebar-side-toggle');

function updateToggleGroupUI(groupId, value) {
    const group = document.getElementById(groupId);
    if (!group) return;
    const buttons = group.querySelectorAll('.toggle-btn');
    buttons.forEach(btn => {
        if (btn.dataset.value === value) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

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
if (sidebarSideToggle) {
    updateToggleGroupUI('sidebar-side-toggle', savedSidebarSide);
    applySidebarSide(savedSidebarSide);

    sidebarSideToggle.addEventListener('click', (e) => {
        const btn = e.target.closest('.toggle-btn');
        if (!btn) return;
        const side = btn.dataset.value;
        localStorage.setItem('sidebarSide', side);
        applySidebarSide(side);
        updateToggleGroupUI('sidebar-side-toggle', side);
    });
}

// ── Add Stream Controls ───────────────────────────────────
const addStreamBtn = document.getElementById('add-stream-btn');
const inputEl = document.getElementById('stream-input');
const vodUsernamesInput = document.getElementById('vod-usernames-input');

// Stream type toggle logic
const streamTypeToggle = document.getElementById('stream-type-toggle');
const vodUsernamesContainer = document.getElementById('vod-usernames-container');
const streamGroupsSection = document.getElementById('stream-groups-section');

if (streamTypeToggle) {
    streamTypeToggle.addEventListener('click', (e) => {
        const btn = e.target.closest('.toggle-btn');
        if (!btn) return;
        streamTypeToggle.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (btn.dataset.value === 'vod') {
            vodUsernamesContainer.style.display = 'block';
            if (streamGroupsSection) streamGroupsSection.style.display = 'none';
        } else {
            vodUsernamesContainer.style.display = 'none';
            if (streamGroupsSection) streamGroupsSection.style.display = 'block';
        }
    });
}

addStreamBtn.addEventListener('click', () => handleAdd(parseStreamInput));
inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAdd(parseStreamInput);
});

// Helper to setup platform icon toggle logic
function setupPlatformToggle(iconContainerId, inputElId) {
    const container = document.getElementById(iconContainerId);
    const inputEl = document.getElementById(inputElId);
    if (!container || !inputEl) return;

    container.addEventListener('click', () => {
        const currentIcon = container.querySelector('i');
        const isTwitch = currentIcon.classList.contains('fa-twitch');

        if (isTwitch) {
            container.innerHTML = '<i class="fa-brands fa-youtube" style="color: #ff0000;"></i>';
        } else {
            container.innerHTML = '<i class="fa-brands fa-twitch" style="color: #a970ff;"></i>';
        }
        inputEl.placeholder = 'Username / URL';
    });

    inputEl.addEventListener('input', () => {
        const val = inputEl.value.trim().toLowerCase();
        const parsed = parseStreamInput(val);

        let type = null;
        if (parsed && parsed.type === 'youtube') {
            type = 'youtube';
        } else if (val.includes('youtube.com') || val.includes('youtu.be')) {
            type = 'youtube';
        } else if (val.includes('twitch.tv')) {
            type = 'twitch';
        }

        if (type === 'youtube') {
            container.innerHTML = '<i class="fa-brands fa-youtube" style="color: #ff0000;"></i>';
            inputEl.placeholder = 'Username / URL';
        } else if (type === 'twitch') {
            container.innerHTML = '<i class="fa-brands fa-twitch" style="color: #a970ff;"></i>';
            inputEl.placeholder = 'Username / URL';
        }
    });
}


setupPlatformToggle('platform-icon-container', 'stream-input');
setupPlatformToggle('follow-platform-icon-container', 'follow-input');

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
const syncVodsBtn = document.getElementById('sync-vods-btn');

if (pauseAllBtn) {
    pauseAllBtn.addEventListener('click', togglePauseAll);
}

if (syncVodsBtn) {
    syncVodsBtn.addEventListener('click', syncVods);
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

const focusedModeToggle = document.getElementById('focused-mode-toggle');
if (focusedModeToggle) {
    const savedFocusedMode = localStorage.getItem('focusedMode') || 'bottom';
    updateToggleGroupUI('focused-mode-toggle', savedFocusedMode);
    focusedModeToggle.addEventListener('click', (e) => {
        const btn = e.target.closest('.toggle-btn');
        if (!btn) return;
        const mode = btn.dataset.value;
        localStorage.setItem('focusedMode', mode);
        updateToggleGroupUI('focused-mode-toggle', mode);
        resizeStreams();
    });
}

const alignmentToggle = document.getElementById('alignment-toggle');
if (alignmentToggle) {
    const savedAlignment = localStorage.getItem('alignmentMode') || 'center';
    updateToggleGroupUI('alignment-toggle', savedAlignment);
    alignmentToggle.addEventListener('click', (e) => {
        const btn = e.target.closest('.toggle-btn');
        if (!btn) return;
        const align = btn.dataset.value;
        localStorage.setItem('alignmentMode', align);
        updateToggleGroupUI('alignment-toggle', align);
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

// Initialize collapsible sidebar sections
initSidebarCollapsibility();

// Initialize Followed Channels
initFollowedChannels();

