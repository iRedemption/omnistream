// ── Shared Application State ──────────────────────────────
// All mutable state lives here so every module can import
// the same references without creating circular dependencies.

/** @type {Array<{uid: string, type: 'twitch'|'youtube', id: string, label: string}>} */
export const activeStreams = [];

/** @type {Map<string, Twitch.Player>} Maps stream uid → Twitch SDK Player instance */
export const twitchPlayers = new Map();

/** Whether all streams are currently paused */
export let isAllPaused = false;

/** Whether the chat panel is currently visible */
export let chatVisible = false;

/** uid of the stream whose chat is currently shown */
export let selectedChatUid = '';

/** uid of the currently focused/pinned stream (null = no focus) */
export let focusedStreamId = null;

/** Saved stream groups (persisted in localStorage) */
export let streamGroups = JSON.parse(localStorage.getItem('streamGroups') || '[]');

/** Set of group IDs currently expanded in the groups list */
export const expandedGroups = new Set();

/** Gap between stream tiles in pixels */
export const gapSize = 2;

// ── State Setters ─────────────────────────────────────────
// Because ES module exports of primitives are not live-bindable
// from the consumer side (you can't do `state.isAllPaused = true`
// from another module), we expose explicit setter functions for
// primitive values that need to be mutated by other modules.

export function setIsAllPaused(value) { isAllPaused = value; }
export function setChatVisible(value) { chatVisible = value; }
export function setSelectedChatUid(value) { selectedChatUid = value; }
export function setFocusedStreamId(value) { focusedStreamId = value; }
export function setStreamGroups(value) { streamGroups = value; }
