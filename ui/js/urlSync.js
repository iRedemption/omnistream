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
        if (s.isVod) {
            return `v=${s.type}~${s.id}~${s.time || '0s'}~${s.offset || 0}~${s.total_offset || 0}~${encodeURIComponent(s.label)}`;
        }
        if (s.type === 'youtube') return 'yt_' + s.id;
        return s.label; // For Twitch live streams we use the label representing the streamer's name
    });

    let basePath = hasVod ? '/vod/' + parts.join('/') : '/#' + parts.join('/');
    const queryParts = [];

    // Add ?chat=<streamId> when the chat panel is open
    if (chatVisible && selectedChatUid) {
        const chatStream = activeStreams.find(s => s.uid === selectedChatUid);
        if (chatStream) {
            let chatId;
            if (chatStream.isVod) {
                chatId = `v=${chatStream.id}`;
            } else {
                chatId = chatStream.type === 'youtube'
                    ? 'yt_' + chatStream.id
                    : chatStream.label;
            }
            queryParts.push('chat=' + chatId);
        }
    }

    // Add &focus=<streamId> when a stream is focused
    if (focusedStreamId) {
        const focusStream = activeStreams.find(s => s.uid === focusedStreamId);
        if (focusStream) {
            let focusId;
            if (focusStream.isVod) {
                focusId = `v=${focusStream.id}`;
            } else {
                focusId = focusStream.type === 'youtube'
                    ? 'yt_' + focusStream.id
                    : focusStream.label;
            }
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

    if (!raw) return { streams: [], chatStreamId: null, focusStreamId: null, isVodRoute: false };

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
        if (part.startsWith('v=')) {
            const payload = part.slice(2);
            const pieces = payload.split('~');
            if (pieces.length >= 6) {
                const type = pieces[0];
                const id = pieces[1];
                const time = pieces[2];
                const offset = parseFloat(pieces[3]) || 0;
                const totalOffset = parseFloat(pieces[4]) || 0;
                const label = decodeURIComponent(pieces.slice(5).join('~'));
                return {
                    type,
                    id,
                    label,
                    time,
                    offset,
                    total_offset: totalOffset,
                    isVod: true,
                    uid: Date.now().toString() + Math.random()
                };
            }
        }
        if (part.startsWith('yt_')) {
            const id = part.slice(3);
            return { type: 'youtube', id, label: id, uid: Date.now().toString() + Math.random(), isVod: isVodRoute };
        }
        const id = decodeURIComponent(part).toLowerCase();
        // Since we don't know the exact video IDs if they just shared the /vod/name1/name2 link! 
        // For backwards compatibility we still return it, but it may have a broken player
        return { type: 'twitch', id, label: id, uid: Date.now().toString() + Math.random(), isVod: isVodRoute };
    });

    return { streams, chatStreamId, focusStreamId, isVodRoute };
}
