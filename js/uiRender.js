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
} from './state.js';

// Namespace import so we can read `state.streamGroups` at call-time (after
// setStreamGroups() replaces the reference the named binding captured).
import * as state from './state.js';

import { updateUrlHash } from './urlSync.js';
import { saveGroupsToStorage } from './storage.js';
import {
    updateStreamsIframes,
    resizeStreams,
    refreshChatIframe,
    hideChatPanel,
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

    activeStreams.forEach(stream => {
        const li = document.createElement('li');
        li.className = 'stream-item';

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
    const twitchStreams = activeStreams.filter(s => s.type === 'twitch');
    if (twitchStreams.length === 0) {
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
    const twitchStreams = activeStreams
        .filter(s => s.type === 'twitch')
        .map(s => ({ type: s.type, id: s.id, label: s.label }));

    const group = {
        id: Date.now().toString(),
        name,
        streams: twitchStreams,
    };
    state.streamGroups.push(group);
    saveGroupsToStorage();
    closeSaveGroupModal();
    renderGroupsUI();
}

// ── Handle Add Stream ─────────────────────────────────────

/**
 * Validate and add the stream currently typed in #stream-input.
 * Imported and called from main.js event listeners.
 */
export function handleAdd(parseStreamInput) {
    const errorMsg = document.getElementById('add-error');
    const inputEl = document.getElementById('stream-input');
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

    activeStreams.push({ ...parsed, uid: Date.now().toString() });
    inputEl.value = '';
    updateUrlHash();
    renderApp();
}
