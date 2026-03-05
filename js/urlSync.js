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
        history.replaceState(null, '', '/');
        return;
    }

    const hasVod = activeStreams.some(s => s.isVod);
    const parts = activeStreams.map(s => {
        if (s.type === 'youtube') return 'yt_' + s.id;
        return s.label; // For Twitch we use the label representing the streamer's name
    });

    let basePath = hasVod ? '/vod/' + parts.join('/') : '/#' + parts.join('/');
    const queryParts = [];

    // Add ?chat=<streamId> when the chat panel is open
    if (chatVisible && selectedChatUid) {
        const chatStream = activeStreams.find(s => s.uid === selectedChatUid);
        if (chatStream) {
            const chatId = chatStream.type === 'youtube'
                ? 'yt_' + chatStream.id
                : chatStream.label;
            queryParts.push('chat=' + chatId);
        }
    }

    // Add &focus=<streamId> when a stream is focused
    if (focusedStreamId) {
        const focusStream = activeStreams.find(s => s.uid === focusedStreamId);
        if (focusStream) {
            const focusId = focusStream.type === 'youtube'
                ? 'yt_' + focusStream.id
                : focusStream.label;
            queryParts.push('focus=' + focusId);
        }
    }

    if (queryParts.length > 0) {
        basePath += '?' + queryParts.join('&');
    }

    history.replaceState(null, '', basePath);
}

/**
 * Parse window.location.hash and return the encoded streams plus
 * optional chat/focus identifiers.
 *
 * @returns {{ streams: Array, chatStreamId: string|null, focusStreamId: string|null }}
 */
export function decodeStreamsFromHash() {
    let raw = "";
    let isVodRoute = false;

    if (window.location.pathname.startsWith('/vod/')) {
        raw = window.location.pathname.replace('/vod/', '');
        let srch = window.location.search;
        if (srch) raw += srch;
        isVodRoute = true;
    } else {
        raw = window.location.hash.slice(1); // remove leading '#'
    }

    if (!raw) return { streams: [], chatStreamId: null, focusStreamId: null, isVodRoute };

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
            return { type: 'youtube', id, label: 'YT: ' + id, uid: Date.now().toString() + Math.random(), isVod: isVodRoute };
        }
        const id = decodeURIComponent(part).toLowerCase();
        // Since we don't know the exact video IDs if they just shared the /vod/name1/name2 link! 
        // Wait, if they share a VOD link, the UI wouldn't know the video IDs from just names. 
        // A complete sharing of VOD states requires either generating them server side, or ignoring the URL hydration for VOD for now, or letting `main.js` re-fetch them.
        // But for VODs we'll just populate `id` with the name for now, though it won't play until synced... 
        // But live streams work perfectly.
        return { type: 'twitch', id, label: id, uid: Date.now().toString() + Math.random(), isVod: isVodRoute };
    });

    return { streams, chatStreamId, focusStreamId, isVodRoute };
}
