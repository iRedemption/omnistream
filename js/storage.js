// ── localStorage Persistence ──────────────────────────────
import { streamGroups } from './state.js';

/**
 * Persist the current streamGroups array to localStorage.
 * Should be called any time streamGroups is mutated.
 */
export function saveGroupsToStorage() {
    localStorage.setItem('streamGroups', JSON.stringify(streamGroups));
}
