// ── UI Rendering & DOM Mutation ───────────────────────────
// This module owns all functions that mutate the DOM:
//   • the active-streams sidebar list
//   • the chat source dropdown
//   • the stream-groups browser
//   • stream/group action handlers (remove, focus, load, delete, add)
//   • the save-group modal

import {
    activeStreams,
    twitchPlayers,
    expandedGroups,
    focusedStreamId,
    chatVisible,
    setFocusedStreamId,
    setSelectedChatUid,
    setStreamGroups,
    setIsAllPaused,
} from './state.js';

// Namespace import so we can read `state.streamGroups` at call-time (after
// setStreamGroups() replaces the reference the named binding captured).
import * as state from './state.js';

import { updateUrlHash } from './urlSync.js';
import { saveGroupsToStorage } from './storage.js';
import { getFollowedStatus } from './followed_channels.js';
import {
    updateStreamsIframes,
    resizeStreams,
    refreshChatIframe,
    hideChatPanel,
    updatePauseButtonIcon,
} from './players.js';

// ── Top-level render coordinator ──────────────────────────

/**
 * Re-render everything that depends on activeStreams.
 */
export function renderApp() {
    updateStreamListUI();
    updateStreamsIframes();
    updateChatDropdown();
    renderGroupsUI();
    updateLayoutSettingsUI();
}

// ── Active Streams List ───────────────────────────────────

/**
 * Remove a stream by uid, cleaning up player references and
 * triggering a full re-render.
 * @param {string} uid
 */
export function removeStream(uid) {
    if (focusedStreamId === uid) {
        setFocusedStreamId(null);
    }
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

/**
 * Reorder the activeStreams array and sync state.
 * @param {number} oldIdx 
 * @param {number} newIdx 
 */
export function reorderStreams(oldIdx, newIdx) {
    if (oldIdx === newIdx) return;
    const [moved] = activeStreams.splice(oldIdx, 1);
    activeStreams.splice(newIdx, 0, moved);
    updateUrlHash();
    renderApp();
}

/**
 * Rebuild the #active-streams-list `<ul>` element.
 */
export function updateStreamListUI() {
    const streamListEl = document.getElementById('active-streams-list');
    const noStreamsMsg = document.getElementById('no-streams-msg');
    streamListEl.innerHTML = '';

    if (activeStreams.length === 0) {
        noStreamsMsg.style.display = 'block';
        return;
    }

    noStreamsMsg.style.display = 'none';

    activeStreams.forEach((stream, index) => {
        const li = document.createElement('li');
        li.className = 'stream-item draggable-item';
        li.setAttribute('draggable', 'true');
        li.dataset.index = index;

        // Drag & Drop Listeners
        li.addEventListener('dragstart', streamDragStart);
        li.addEventListener('dragover', streamDragOver);
        li.addEventListener('dragleave', streamDragLeave);
        li.addEventListener('drop', streamDrop);
        li.addEventListener('dragend', streamDragEnd);

        // Grip handle icon
        const grip = document.createElement('i');
        grip.className = 'fa-solid fa-grip-vertical drag-handle';
        li.appendChild(grip);

        // Info (icon + label)
        const info = document.createElement('div');
        info.className = 'stream-item-info';

        const icon = document.createElement('i');
        icon.className = stream.type === 'twitch'
            ? 'fa-brands fa-twitch'
            : 'fa-brands fa-youtube';

        const text = document.createElement('span');
        text.textContent = stream.label;

        info.appendChild(icon);
        info.appendChild(text);

        // Actions (focus + remove)
        const actions = document.createElement('div');
        actions.className = 'stream-actions';

        const focusBtn = document.createElement('button');
        focusBtn.className = 'focus-stream-btn' + (focusedStreamId === stream.uid ? ' active' : '');
        focusBtn.innerHTML = '<i class="fa-solid fa-expand"></i>';
        focusBtn.title = 'Focus Stream';
        // Use addEventListener instead of onclick to work correctly within ES module scope
        focusBtn.addEventListener('click', () => {
            setFocusedStreamId(focusedStreamId === stream.uid ? null : stream.uid);
            updateUrlHash();
            renderApp();
            resizeStreams();
        });

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-stream-btn';
        removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        removeBtn.title = 'Remove Stream';
        removeBtn.addEventListener('click', () => removeStream(stream.uid));

        actions.appendChild(focusBtn);
        actions.appendChild(removeBtn);

        li.appendChild(info);
        li.appendChild(actions);
        streamListEl.appendChild(li);
    });
}

/**
 * Enable/Disable layout settings based on focus state
 */
export function updateLayoutSettingsUI() {
    const focusModeGroup = document.getElementById('focused-mode-toggle');
    const gridSizeGroup = document.getElementById('grid-size-group');
    if (!focusModeGroup || !gridSizeGroup) return;

    const buttons = focusModeGroup.querySelectorAll('.toggle-btn');
    const isFocused = !!focusedStreamId;
    const disabledTooltip = 'Focus a stream (using the "Focus" icon in Active Streams) to change these settings';

    if (isFocused) {
        focusModeGroup.classList.remove('disabled');
        focusModeGroup.title = '';
        gridSizeGroup.style.opacity = '1';
        gridSizeGroup.style.pointerEvents = 'auto';
        gridSizeGroup.title = '';
        buttons.forEach(btn => {
            btn.disabled = false;
            const mode = btn.dataset.value;
            btn.title = `Grid at ${mode.charAt(0).toUpperCase() + mode.slice(1)}`;
        });
    } else {
        focusModeGroup.classList.add('disabled');
        focusModeGroup.title = disabledTooltip;
        gridSizeGroup.style.opacity = '0.5';
        gridSizeGroup.style.pointerEvents = 'auto';
        gridSizeGroup.title = disabledTooltip;
        buttons.forEach(btn => {
            btn.disabled = true;
            btn.title = '';
        });
    }
}

// ── Chat Dropdown ─────────────────────────────────────────

/**
 * Rebuild the #chat-stream-select <select> element and keep
 * the previously selected stream (or auto-pick a new one).
 */
export function updateChatDropdown() {
    const select = document.getElementById('chat-stream-select');
    if (!select) return;

    const prevUid = select.value;

    select.innerHTML = '<option value="">-- Select a stream --</option>';
    activeStreams.forEach(stream => {
        const opt = document.createElement('option');
        opt.value = stream.uid;
        const prefix = stream.type === 'twitch' ? '🟣' : '🔴';
        opt.textContent = `${prefix} ${stream.label}`;
        select.appendChild(opt);
    });

    // Restore or auto-select
    if (activeStreams.some(s => s.uid === prevUid)) {
        select.value = prevUid;
        setSelectedChatUid(prevUid);
    } else if (activeStreams.length > 0) {
        select.value = activeStreams[0].uid;
        setSelectedChatUid(activeStreams[0].uid);
    } else {
        select.value = '';
        setSelectedChatUid('');
    }

    if (chatVisible) {
        refreshChatIframe();
    }

    if (activeStreams.length === 0 && chatVisible) {
        hideChatPanel();
    }
}

// ── Stream Groups UI ──────────────────────────────────────

/**
 * Rebuild the #groups-list element from streamGroups state.
 */
const groupStatusCache = new Map(); // id -> { isLive: bool, lastChecked: timestamp }
const fetchingGroups = new Set(); // id -> boolean

export function renderGroupsUI() {
    const list = document.getElementById('groups-list');
    const noMsg = document.getElementById('no-groups-msg');
    if (!list) return;

    list.innerHTML = '';

    if (state.streamGroups.length === 0) {
        noMsg.style.display = 'block';
        return;
    }
    noMsg.style.display = 'none';

    state.streamGroups.forEach(group => {
        const isExpanded = expandedGroups.has(group.id);

        const groupEl = document.createElement('div');
        groupEl.className = 'group-item';

        // Header
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

        const leftSide = document.createElement('div');
        leftSide.className = 'group-header-left';
        leftSide.appendChild(chevron);
        leftSide.appendChild(nameSpan);
        leftSide.appendChild(countBadge);

        // Header action buttons
        const headerActions = document.createElement('div');
        headerActions.className = 'group-header-actions';

        const loadBtn = document.createElement('button');
        loadBtn.className = 'group-action-btn group-load-btn';
        loadBtn.title = 'Load group (replaces current streams)';
        loadBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        loadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            loadGroup(group.id);
        });

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

        header.appendChild(leftSide);
        header.appendChild(headerActions);
        header.addEventListener('click', () => {
            if (expandedGroups.has(group.id)) {
                expandedGroups.delete(group.id);
            } else {
                expandedGroups.add(group.id);
                // Trigger fetching of statuses for group members
                checkGroupLiveStatus(group);
            }
            renderGroupsUI();
        });

        groupEl.appendChild(header);

        // Expanded stream list
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
                    icon.className = stream.type === 'twitch' ? 'fa-brands fa-twitch' : 'fa-brands fa-youtube';
                    if (stream.type === 'youtube') icon.style.color = '#ff0000';

                    const label = document.createElement('span');
                    label.textContent = stream.label;

                    info.appendChild(icon);
                    info.appendChild(label);

                    // Live dot indicator
                    const followedStatus = getFollowedStatus(stream.id, stream.type);
                    let isLive = false;
                    if (followedStatus) {
                        isLive = followedStatus.is_live;
                    } else {
                        const cached = groupStatusCache.get(stream.id + '_' + stream.type);
                        if (cached) isLive = cached.isLive;
                    }

                    if (isLive) {
                        const dot = document.createElement('div');
                        dot.className = 'live-dot';
                        dot.style.marginLeft = '4px';
                        dot.style.width = '6px';
                        dot.style.height = '6px';
                        info.appendChild(dot);
                    }

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

async function checkGroupLiveStatus(group) {
    const now = Date.now();
    const cacheExpiry = 60000 * 3; // 3 minutes

    const streamsToCheck = group.streams.filter(s => {
        // Only check if NOT followed
        if (getFollowedStatus(s.id, s.type)) return false;

        const cached = groupStatusCache.get(s.id + '_' + s.type);
        if (cached && (now - cached.lastChecked) < cacheExpiry) return false;

        return true;
    });

    if (streamsToCheck.length === 0) return;

    // Fetch Twitch
    const tStreams = streamsToCheck.filter(s => s.type === 'twitch');
    if (tStreams.length > 0) {
        const logins = tStreams.map(s => s.id).join(',');
        fetch(`/api/twitch/followed?logins=${logins}`)
            .then(r => r.json())
            .then(data => {
                const liveSet = new Set(data.filter(d => d.is_live).map(d => d.user_login));
                tStreams.forEach(s => {
                    groupStatusCache.set(s.id + '_twitch', {
                        isLive: liveSet.has(s.id),
                        lastChecked: Date.now()
                    });
                });
                renderGroupsUI();
            }).catch(e => console.error('Twitch group status check failed', e));
    }

    // Fetch YouTube
    const yStreams = streamsToCheck.filter(s => s.type === 'youtube');
    if (yStreams.length > 0) {
        const ids = yStreams.map(s => s.id).join(',');
        fetch(`/api/youtube/followed?ids=${ids}`)
            .then(r => r.json())
            .then(data => {
                const liveSet = new Set(data.filter(d => d.is_live).map(d => d.user_login));
                yStreams.forEach(s => {
                    groupStatusCache.set(s.id + '_youtube', {
                        isLive: liveSet.has(s.id),
                        lastChecked: Date.now()
                    });
                });
                renderGroupsUI();
            }).catch(e => console.error('YouTube group status check failed', e));
    }
}

// ── Group Actions ─────────────────────────────────────────

function deleteGroup(groupId) {
    setStreamGroups(state.streamGroups.filter(g => g.id !== groupId));
    expandedGroups.delete(groupId);
    saveGroupsToStorage();
    renderGroupsUI();
}

function loadGroup(groupId) {
    const group = state.streamGroups.find(g => g.id === groupId);
    if (!group) return;
    activeStreams.length = 0;
    setFocusedStreamId(null);
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

// ── Save-Group Modal ──────────────────────────────────────

export function openSaveGroupModal() {
    if (activeStreams.length === 0) {
        const err = document.getElementById('add-error');
        err.textContent = 'No streams to save.';
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

export function closeSaveGroupModal() {
    document.getElementById('save-group-modal').style.display = 'none';
}

export function confirmSaveGroup() {
    const input = document.getElementById('group-name-input');
    const errEl = document.getElementById('group-name-error');
    const name = input.value.trim();
    if (!name) {
        errEl.textContent = 'Please enter a group name.';
        return;
    }
    const streamsToSave = activeStreams
        .map(s => ({ type: s.type, id: s.id, label: s.label }));

    const group = {
        id: Date.now().toString(),
        name,
        streams: streamsToSave,
    };
    state.streamGroups.push(group);
    saveGroupsToStorage();
    closeSaveGroupModal();
    renderGroupsUI();
}

// ── Handle Add Stream ─────────────────────────────────────

export function notify(message) {
    const center = document.getElementById('notification-center');
    if (!center) return;
    const div = document.createElement('div');
    div.style.background = '#1f1f23';
    div.style.borderLeft = '4px solid #a970ff';
    div.style.padding = '12px 20px';
    div.style.borderRadius = '4px';
    div.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
    div.style.pointerEvents = 'auto';
    div.style.maxWidth = '320px';
    div.style.transition = 'all 0.3s ease-out';
    div.textContent = message;
    center.appendChild(div);
    setTimeout(() => {
        div.style.opacity = '0';
        div.style.transform = 'translateY(-20px)';
        setTimeout(() => div.remove(), 500);
    }, 6000);
}

/**
 * Validate and add the stream currently typed in #stream-input.
 * Imported and called from main.js event listeners.
 */
export async function handleAdd(parseStreamInput) {
    const errorMsg = document.getElementById('add-error');
    const inputEl = document.getElementById('stream-input');
    const streamTypeToggle = document.getElementById('stream-type-toggle');
    const platformIconContainer = document.getElementById('platform-icon-container');
    const isYouTubeMode = platformIconContainer?.querySelector('i').classList.contains('fa-youtube');
    const isVod = streamTypeToggle ? !!streamTypeToggle.querySelector('.toggle-btn.active[data-value="vod"]') : false;
    errorMsg.textContent = '';

    if (isVod) {
        const vodUrl = inputEl.value.trim();
        const rawUsernames = document.getElementById('vod-usernames-input')?.value.trim();
        if (!vodUrl) {
            errorMsg.textContent = 'Please provide a base VOD URL.';
            return;
        }

        const streamersList = rawUsernames
            ? rawUsernames.split('\n').map(s => s.trim()).filter(Boolean)
            : [];

        const statusEl = document.getElementById('vod-sync-status');
        if (statusEl) statusEl.style.display = 'block';

        try {
            const res = await fetch('/api/vod-sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: vodUrl, streamers: streamersList })
            });
            const data = await res.json();

            if (statusEl) statusEl.style.display = 'none';
            if (!data.success) {
                errorMsg.textContent = 'Failed to sync VODs: ' + (data.error || 'Unknown error');
                return;
            }

            inputEl.value = '';
            const tArea = document.getElementById('vod-usernames-input');
            if (tArea) tArea.value = '';

            // Add all returned configs as active streams
            data.data.forEach((cfg) => {
                activeStreams.push({
                    type: 'twitch',
                    id: cfg.video, // We can store video ID in `id` 
                    label: cfg.label,
                    uid: Date.now().toString() + Math.random(),
                    isVod: true,
                    time: cfg.time,
                    offset: cfg.offset,
                    total_offset: cfg.total_offset
                });

                if (cfg.offset && cfg.offset !== 0) {
                    const absOff = Math.abs(cfg.offset).toFixed(2);
                    notify(`${cfg.label} was ${absOff}s ${cfg.offset > 0 ? 'ahead of' : 'behind'} original`);
                }
            });

            updateUrlHash();
            setIsAllPaused(true);
            updatePauseButtonIcon();
            renderApp();

        } catch (e) {
            if (statusEl) statusEl.style.display = 'none';
            errorMsg.textContent = 'Network error fetching VOD sync.';
        }

        return;
    }

    // Live stream handling
    let parsed = parseStreamInput(inputEl.value);

    // If not detected as URL, but YouTube icon is selected, treat as YT handle/username
    if (!parsed && isYouTubeMode && inputEl.value.trim()) {
        let q = inputEl.value.trim();
        if (!q.startsWith('@') && !q.startsWith('UC')) q = '@' + q;
        parsed = { type: 'youtube', id: q, label: q };
    }

    if (!parsed) {
        errorMsg.textContent = 'Invalid channel or URL';
        return;
    }

    // Resolve YouTube names and IDs
    if (parsed.type === 'youtube') {
        const addBtn = document.getElementById('add-stream-btn');
        const origIcon = addBtn.innerHTML;
        addBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        addBtn.disabled = true;

        try {
            const res = await fetch(`/api/youtube/resolve?q=${encodeURIComponent(parsed.id)}`);
            if (res.ok) {
                const data = await res.json();
                parsed.id = data.id;
                parsed.label = data.title;
            }
        } catch (e) {
            console.error('YouTube resolve failed', e);
        } finally {
            addBtn.innerHTML = origIcon;
            addBtn.disabled = false;
        }
    }
    if (activeStreams.some(s => s.type === parsed.type && s.id === parsed.id)) {
        errorMsg.textContent = 'Stream already added';
        return;
    }

    activeStreams.push({ ...parsed, uid: Date.now().toString() });
    inputEl.value = '';
    if (platformIconContainer) {
        platformIconContainer.innerHTML = '<i class="fa-brands fa-twitch" style="color: #a970ff;"></i>';
    }
    updateUrlHash();
    renderApp();
}

// ── Drag and Drop Handlers ───────────────────────────────

let dragSrcIndex = null;

function streamDragStart(e) {
    dragSrcIndex = parseInt(this.dataset.index);
    this.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    // Required for Firefox
    e.dataTransfer.setData('text/plain', dragSrcIndex);
}

function streamDragOver(e) {
    if (e.preventDefault) e.preventDefault();
    this.classList.add('drag-over');
    e.dataTransfer.dropEffect = 'move';
    return false;
}

function streamDragLeave() {
    this.classList.remove('drag-over');
}

function streamDrop(e) {
    if (e.stopPropagation) e.stopPropagation();
    this.classList.remove('drag-over');

    const targetIndex = parseInt(this.dataset.index);
    if (dragSrcIndex !== targetIndex) {
        reorderStreams(dragSrcIndex, targetIndex);
    }
    return false;
}

function streamDragEnd() {
    this.classList.remove('dragging');
    const items = document.querySelectorAll('.stream-item');
    items.forEach(item => item.classList.remove('drag-over'));
}
