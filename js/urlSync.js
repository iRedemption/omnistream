// ── URL Hash Sync ─────────────────────────────────────────
// Encodes active streams (and chat/focus state) into the URL
// hash so the page can be refreshed or shared without losing
// the current configuration.
//
// Format examples:
//   #channel1/channel2/yt_VIDEO_ID
//   #channel1/channel2?chat=channel1&focus=channel2
import {
    activeStreams,
    chatVisible,
    selectedChatUid,
    focusedStreamId,
} from './state.js';

/**
 * Serialise the current app state into window.location.hash.
 */
export function updateUrlHash() {
    if (activeStreams.length === 0) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
        return;
    }

    const parts = activeStreams.map(s => {
        if (s.type === 'youtube') return 'yt_' + s.id;
        return s.id; // Twitch channel name
    });
    let hash = '#' + parts.join('/');

    const queryParts = [];

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

/**
 * Parse window.location.hash and return the encoded streams plus
 * optional chat/focus identifiers.
 *
 * @returns {{ streams: Array, chatStreamId: string|null, focusStreamId: string|null }}
 */
export function decodeStreamsFromHash() {
    let raw = window.location.hash.slice(1); // remove leading '#'
    if (!raw) return { streams: [], chatStreamId: null, focusStreamId: null };

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
