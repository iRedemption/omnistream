"""
twitch_sync_tool.py
--------------------
Step 1 – Uses `twitchsync` to get a rough synced timestamp for each VOD.
Step 2 – Downloads 15 s mono-WAV snippets around those timestamps with yt-dlp.
Step 3 – Runs scipy cross-correlation to find the exact millisecond offset.
Step 4 – Applies the refined offset to the secondary VOD timestamp.
Step 5 – Generates a premium HTML viewer that gates Play All behind VIDEO_READY.
"""

import os
import re
import json
import argparse
import tempfile
import subprocess
import shutil

import numpy as np
from scipy.io import wavfile
from scipy.signal import correlate

from twitchsync import TwitchSync

# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

SAMPLE_RATE = 44100   # Hz used for cross-correlation
CLIP_SECONDS = 10     # seconds of audio to download for correlation

def parse_twitch_url(url):
    """
    Returns (video_id, timestamp_str, timestamp_seconds, clip_slug).
    timestamp_seconds is a float; timestamp_str is the raw ?t= value.
    Works for VOD URLs: twitch.tv/videos/<id>?t=XhYmZs
    and Clip URLs: twitch.tv/<channel>/clip/<slug>
    """
    video_id_match = re.search(r'videos/(\d+)', url)
    time_match     = re.search(r'[?&]t=([\dhms]+)', url)
    clip_match     = re.search(r'/clip/([\w-]+)', url)

    video_id   = video_id_match.group(1) if video_id_match else None
    clip_slug  = clip_match.group(1)     if clip_match     else None
    ts_str     = time_match.group(1)     if time_match     else "0s"

    # Safely extract hours, minutes, and seconds
    h_match = re.search(r'(\d+)h', ts_str)
    m_match = re.search(r'(\d+)m', ts_str)
    s_match = re.search(r'(\d+)s', ts_str)

    h = int(h_match.group(1)) if h_match else 0
    m = int(m_match.group(1)) if m_match else 0
    s = int(s_match.group(1)) if s_match else 0
    
    total_seconds = h * 3600 + m * 60 + s

    return video_id, ts_str, total_seconds, clip_slug


def seconds_to_twitch_ts(total_seconds):
    """Convert a float of seconds to a Twitch timestamp string (e.g. '6h42m45s')."""
    total_seconds = max(0, round(total_seconds))
    h = total_seconds // 3600
    m = (total_seconds % 3600) // 60
    s = total_seconds % 60
    return f"{h}h{m}m{s}s"


def build_twitch_vod_url(video_id, ts_str):
    return f"https://www.twitch.tv/videos/{video_id}?t={ts_str}"


# ──────────────────────────────────────────────────────────────────────────────
# Audio Cross-Correlation
# ──────────────────────────────────────────────────────────────────────────────

def _yt_dlp_available():
    return shutil.which("yt-dlp") is not None or shutil.which("yt_dlp") is not None


def download_audio_segment(vod_url, start_sec, out_path, clip_dur=CLIP_SECONDS):
    """
    Uses yt-dlp (via subprocess) to download CLIP_SECONDS of audio from vod_url
    starting at start_sec and saves a mono 44100Hz WAV to out_path.
    
    yt-dlp --download-sections '*start-end' skips having to seek in post.
    FFmpeg -ss / -t do the trimming on the final output.
    """
    # Centre the clip window around the rough timestamp
    # but don't go below 0
    clip_start = max(0, start_sec - CLIP_SECONDS // 2)
    clip_end   = clip_start + CLIP_SECONDS

    section_arg = f"*{clip_start}-{clip_end}"

    print(f"  → Downloading {CLIP_SECONDS}s audio snippet from {vod_url} @ ~{start_sec}s …")

    cmd = [
        "yt-dlp",
        vod_url,
        "--no-playlist",
        "--quiet",
        "--no-warnings",
        "--format", "bestaudio/best",
        "--download-sections", section_arg,
        "--postprocessor-args", f"ffmpeg:-ar {SAMPLE_RATE} -ac 1",
        "--extract-audio",
        "--audio-format", "wav",
        "--output", out_path,
        "--force-overwrites",
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"yt-dlp failed for {vod_url}:\n{result.stderr}"
        )

    # yt-dlp appends .wav automatically; if out_path already ends in .wav
    # the file may land at out_path or out_path.wav depending on version.
    # Normalise:
    if not os.path.exists(out_path):
        candidate = out_path + ".wav"
        if os.path.exists(candidate):
            os.rename(candidate, out_path)
        else:
            raise FileNotFoundError(
                f"yt-dlp didn't produce expected file at {out_path}"
            )


def calculate_audio_offset(vod1_url, time1_sec, vod2_url, time2_sec):
    """
    Downloads a short audio window from both VODs, cross-correlates them,
    and returns the offset in seconds (positive → vod2 is AHEAD, negative → vod2 is BEHIND).

    Offset is applied to vod2's timestamp: corrected_ts2 = time2_sec - offset
    """
    if not _yt_dlp_available():
        print("[WARNING] yt-dlp not found in PATH. Skipping audio refinement.")
        return 0.0

    tmp_dir = tempfile.mkdtemp(prefix="twitchsync_")
    wav1 = os.path.join(tmp_dir, "vod1.wav")
    wav2 = os.path.join(tmp_dir, "vod2.wav")

    try:
        download_audio_segment(vod1_url, time1_sec, wav1)
        download_audio_segment(vod2_url, time2_sec, wav2)

        rate1, data1 = wavfile.read(wav1)
        rate2, data2 = wavfile.read(wav2)

        # Normalise to float32 in [-1, 1]
        data1 = data1.astype(np.float32) / np.iinfo(data1.dtype).max
        data2 = data2.astype(np.float32) / np.iinfo(data2.dtype).max

        # If they're stereo somehow, collapse to mono
        if data1.ndim > 1:
            data1 = data1.mean(axis=1)
        if data2.ndim > 1:
            data2 = data2.mean(axis=1)

        # Resample to a common length (trim to the shorter one for safety)
        min_len = min(len(data1), len(data2))
        data1 = data1[:min_len]
        data2 = data2[:min_len]

        print("  → Running cross-correlation …")
        correlation = correlate(data1, data2, mode='full')
        lags        = np.arange(-(min_len - 1), min_len)   # in samples
        best_lag    = lags[np.argmax(correlation)]          # samples

        # Use the higher of the two actual sample rates for conversion
        sr = rate1 if rate1 > 0 else SAMPLE_RATE
        offset_seconds = best_lag / sr

        print(f"  → Raw cross-correlation lag : {best_lag} samples = {offset_seconds:.3f} s")
        return float(offset_seconds)

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ──────────────────────────────────────────────────────────────────────────────
# HTML Generation
# ──────────────────────────────────────────────────────────────────────────────

HTML_TEMPLATE = """\
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TwitchSync - Viewer</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
    <script src="https://embed.twitch.tv/embed/v1.js"></script>
    <style>
        :root {
            --bg:       #0e0e10;
            --accent:   #a970ff;
            --card-bg:  #18181b;
            --text:     #efeff1;
            --muted:    #adadb8;
            --gap:      20px;
            --radius:   12px;
        }
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            background: var(--bg);
            color: var(--text);
            font-family: 'Inter', sans-serif;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 32px 24px 48px;
        }

        /* ── Header ── */
        .header {
            width: 100%;
            max-width: 1400px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 36px;
            flex-wrap: wrap;
            gap: 16px;
        }
        .logo {
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 22px;
            font-weight: 800;
            letter-spacing: 1px;
            text-transform: uppercase;
            color: var(--accent);
        }
        .controls-bar {
            display: flex;
            align-items: center;
            gap: 14px;
        }

        /* ── Play & Sync buttons ── */
        .btn-group {
            display: flex;
            gap: 8px;
        }
        .btn {
            display: flex;
            align-items: center;
            gap: 8px;
            background: var(--accent);
            color: #000;
            border: none;
            padding: 10px 22px;
            border-radius: 8px;
            font-family: inherit;
            font-weight: 700;
            font-size: 0.95rem;
            cursor: pointer;
            transition: filter 0.2s, transform 0.15s;
            user-select: none;
        }
        .btn:hover  { filter: brightness(1.15); }
        .btn:active { transform: scale(0.97); }
        .btn:disabled {
            opacity: 0.45;
            cursor: not-allowed;
        }
        .btn-secondary {
            background: rgba(255,255,255,0.1);
            color: var(--text);
            border: 1px solid rgba(255,255,255,0.2);
        }

        #notification-center {
            position: fixed;
            bottom: 24px;
            right: 24px;
            display: flex;
            flex-direction: column;
            gap: 12px;
            z-index: 1000;
            pointer-events: none;
        }
        .notif {
            background: #1f1f23;
            border-left: 4px solid var(--accent);
            padding: 12px 20px;
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            animation: slideIn 0.3s ease-out;
            pointer-events: auto;
            max-width: 320px;
        }
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to   { transform: translateX(0); opacity: 1; }
        }

        /* ── Status pill ── */
        .status-pill {
            display: flex;
            align-items: center;
            gap: 8px;
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 99px;
            padding: 6px 14px;
            font-size: 0.8rem;
            font-weight: 600;
        }
        .pulse {
            width: 8px; height: 8px;
            border-radius: 50%;
            display: inline-block;
            transition: background 0.4s;
        }
        .pulse.loading  { background: #f59e0b; animation: blink 1s infinite; }
        .pulse.ready    { background: #41ff41; }
        .pulse.playing  { background: #41ff41; animation: pulse-anim 1.4s infinite; }
        .pulse.paused   { background: #ff4141; }

        @keyframes blink {
            0%, 100% { opacity: 1; }
            50%       { opacity: 0.3; }
        }
        @keyframes pulse-anim {
            0%   { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(65,255,65,0.7); }
            70%  { transform: scale(1);    box-shadow: 0 0 0 8px rgba(65,255,65,0); }
            100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(65,255,65,0); }
        }

        /* ── Grid ── */
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(520px, 1fr));
            gap: var(--gap);
            width: 100%;
            max-width: 1400px;
        }

        /* ── Card ── */
        .stream-card {
            background: var(--card-bg);
            border-radius: var(--radius);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            border: 1px solid #262626;
            box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);
            transition: transform 0.3s cubic-bezier(0.4,0,0.2,1),
                        border-color 0.3s,
                        box-shadow 0.3s;
        }
        .stream-card:hover {
            transform: scale(1.015);
            border-color: var(--accent);
            box-shadow: 0 25px 30px -5px rgba(169,112,255,0.2);
        }
        .player-wrapper {
            position: relative;
            padding-top: 56.25%;
            width: 100%;
            background: #000;
        }
        /* Twitch Embed SDK injects an iframe; force it to fill the wrapper */
        .player-wrapper > div,
        .player-wrapper iframe {
            position: absolute !important;
            top: 0 !important; left: 0 !important;
            width: 100% !important;
            height: 100% !important;
            border: none;
        }
        .stream-info {
            padding: 14px 18px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
            background: rgba(255,255,255,0.02);
            border-top: 1px solid rgba(255,255,255,0.06);
        }
        .streamer-name {
            font-weight: 700;
            font-size: 1.05rem;
        }
        .timestamp-badge {
            font-family: 'Courier New', monospace;
            background: var(--accent);
            color: #000;
            padding: 3px 10px;
            border-radius: 4px;
            font-size: 0.85rem;
            font-weight: 800;
        }
        .clip-badge {
            background: #ff7043;
        }
    </style>
</head>
<body>

<div class="header">
    <div class="logo">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
            <path d="M11.571 4.714h1.714v5.143H11.571zm4.715 0H18v5.143h-1.714zM6 0
                     L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571
                     11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/>
        </svg>
        TwitchSync VOD Grid
    </div>

    <div class="controls-bar">
        <div class="status-pill">
            <span class="pulse loading" id="status-dot"></span>
            <span id="status-label">Loading players…</span>
        </div>
        <div class="btn-group">
            <button id="global-play-btn" class="btn" disabled title="Play or pause all streams simultaneously">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                Play All
            </button>
            <button id="resync-btn" class="btn btn-secondary" disabled title="Re-align all streams to the primary (first) stream position">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm-1.24 16.29C10.7 20.31 11.34 20.34 12 20.34c4.42 0 8-3.58 8-8h-2c0 3.31-2.69 6-6 6-.79 0-1.56-.15-2.25-.44l-1.46 1.46zM4.47 7.07L5.93 8.53C5.35 9.53 5 10.73 5 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3c-3.31 0-6-2.69-6-6 0-1.5.55-2.88 1.47-3.93z"/></svg>
                Sync
            </button>
        </div>
    </div>
</div>

<div id="notification-center"></div>

<div class="grid" id="stream-grid">
    %%STREAM_CARDS%%
</div>

<script>
// ────────────────────────────────────────────────────────────────────────────
// Stream configuration injected by Python
// ────────────────────────────────────────────────────────────────────────────
const STREAM_CONFIGS = %%STREAM_CONFIGS%%;

// ────────────────────────────────────────────────────────────────────────────
// Player management
// ────────────────────────────────────────────────────────────────────────────
const hostname   = window.location.hostname || "localhost";
const embeds     = [];      // Twitch.Embed instances
const players    = [];      // Twitch player instances (set when READY fires)
const readyFlags = [];      // true once each player fires VIDEO_READY

let playing = false;

const playBtn     = document.getElementById('global-play-btn');
const statusDot   = document.getElementById('status-dot');
const statusLabel = document.getElementById('status-label');

function setStatus(state) {
    statusDot.className = 'pulse ' + state;
    switch (state) {
        case 'loading': statusLabel.textContent = 'Loading players\u2026'; break;
        case 'ready':   statusLabel.textContent = 'Ready \u2014 press Play All'; break;
        case 'playing': statusLabel.textContent = 'Playing'; break;
        case 'paused':  statusLabel.textContent = 'Paused'; break;
    }
}

function notify(message) {
    const center = document.getElementById('notification-center');
    const div = document.createElement('div');
    div.className = 'notif';
    div.textContent = message;
    center.appendChild(div);
    setTimeout(() => {
        div.style.opacity = '0';
        div.style.transform = 'translateY(-20px)';
        setTimeout(() => div.remove(), 500);
    }, 6000);
}

function allReady() {
    return readyFlags.length === STREAM_CONFIGS.length &&
           readyFlags.every(Boolean);
}

function initPlayers() {
    STREAM_CONFIGS.forEach((cfg, idx) => {
        const options = {
            width:    "100%",
            height:   "100%",
            muted:    true,
            autoplay: false,
            parent:   [hostname],
        };

        // VOD or Clip
        if (cfg.video) {
            options.video = cfg.video;
            options.time  = cfg.time || "0s";
        } else if (cfg.clip) {
            options.clip  = cfg.clip;
        }

        const embed = new Twitch.Embed("player-" + idx, options);
        embeds.push(embed);
        readyFlags.push(false);

        embed.addEventListener(Twitch.Embed.VIDEO_READY, () => {
            const p = embed.getPlayer();
            players[idx]    = p;
            readyFlags[idx] = true;

            console.log(`[TwitchSync] player-${idx} (${cfg.label}) is VIDEO_READY`);

            if (allReady()) {
                setStatus('ready');
                playBtn.disabled = false;
                document.getElementById('resync-btn').disabled = false;
                
                // Show detected offsets
                STREAM_CONFIGS.forEach(cfg => {
                    if (cfg.offset !== undefined && cfg.offset !== 0) {
                        const absOff = Math.abs(cfg.offset).toFixed(2);
                        if (cfg.offset > 0) {
                            notify(`${cfg.label} was ${absOff}s ahead of original`);
                        } else {
                            notify(`${cfg.label} was ${absOff}s behind original`);
                        }
                    }
                });
            }
        });
    });
}

// ────────────────────────────────────────────────────────────────────────────
// Global play / pause
// ────────────────────────────────────────────────────────────────────────────
playBtn.addEventListener('click', () => {
    playing = !playing;

    players.forEach(p => {
        if (!p) return;
        if (playing) p.play();
        else         p.pause();
    });

    playBtn.innerHTML = playing
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg> Pause All'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Play All';

    setStatus(playing ? 'playing' : 'paused');
});

// ────────────────────────────────────────────────────────────────────────────
// Sync logic
// ────────────────────────────────────────────────────────────────────────────
document.getElementById('resync-btn').addEventListener('click', () => {
    if (!players[0]) return;
    
    // 1. Force Pause All first to ensure primary playhead is static
    players.forEach(p => {
        if (p) p.pause();
    });
    
    // 2. Update UI state to "Paused"
    playing = false;
    playBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Play All';
    setStatus('paused');
    
    // 3. Small timeout to let the pause settle before reading primary time
    setTimeout(() => {
        const T0 = players[0].getCurrentTime();
        
        players.forEach((p, idx) => {
            if (idx === 0 || !p) return;
            
            const cfg = STREAM_CONFIGS[idx];
            if (cfg.total_offset !== undefined) {
                const target = T0 + cfg.total_offset;
                p.seek(target);
                console.log(`[TwitchSync] Resyncing player-${idx} to ${target.toFixed(2)}s`);
            }
        });
        
        notify(`Streams paused and re-synchronized to primary (${T0.toFixed(1)}s)`);
    }, 100);
});

// ────────────────────────────────────────────────────────────────────────────
// Boot
// ────────────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
    setStatus('loading');
    initPlayers();
});
</script>
</body>
</html>
"""


def generate_html(matches, output_path="sync_viewer.html"):
    stream_cards   = ""
    stream_configs = []

    for i, match in enumerate(matches):
        video_id, ts_str, _ts_sec, clip_slug = parse_twitch_url(match['result'])
        label   = match['streamer']
        refined = match.get('refined_ts', ts_str)  # may have been updated by offset logic

        # Card HTML
        if video_id:
            badge = f'<span class="timestamp-badge">{refined}</span>'
        else:
            badge = '<span class="timestamp-badge clip-badge">CLIP</span>'

        stream_cards += f"""
        <div class="stream-card">
            <div class="player-wrapper" id="player-{i}"></div>
            <div class="stream-info">
                <span class="streamer-name">{label}</span>
                {badge}
            </div>
        </div>
        """

        # JavaScript config
        cfg = {"label": label}
        if video_id:
            cfg["video"] = video_id
            cfg["time"]  = refined
            # Pass offset for re-sync
            cfg["offset"] = match.get('offset', 0)
            cfg["total_offset"] = match.get('total_offset', 0)
        elif clip_slug:
            cfg["clip"]  = clip_slug

        stream_configs.append(cfg)

    full_html = HTML_TEMPLATE.replace("%%STREAM_CARDS%%", stream_cards)
    full_html = full_html.replace('"%%STREAM_CONFIGS%%"', json.dumps(stream_configs, indent=4))
    full_html = full_html.replace("%%STREAM_CONFIGS%%",   json.dumps(stream_configs, indent=4))

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(full_html)

    print(f"\n✓ Generated: {output_path}")


# ──────────────────────────────────────────────────────────────────────────────
# CLI entry point
# ──────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Sync Twitch VODs with audio cross-correlation and generate a viewer HTML."
    )
    parser.add_argument("url",       help="Source clip URL, slug, or VOD timestamp URL")
    parser.add_argument("streamers", nargs="+", help="Channels to sync against")
    parser.add_argument("--id",      dest="client_id",     help="Twitch Client ID")
    parser.add_argument("--secret",  dest="client_secret", help="Twitch Client Secret")
    parser.add_argument("--out",     default="testing/outputs/sync_viewer.html", help="Output HTML filename")
    parser.add_argument("--no-refine", action="store_true",
                        help="Skip audio cross-correlation (use rough twitchsync timestamps only)")

    args = parser.parse_args()

    # ── Step 1: rough sync via twitchsync ──────────────────────────────────
    client = TwitchSync(client_id=args.client_id, client_secret=args.client_secret)

    print(f"[1/3] Fetching rough timestamps for {len(args.streamers)} streamer(s)…")
    matches = client.get_matches_for_all_streamers(args.streamers, args.url)

    # Prepend the original source VOD
    source_label = "Original"
    ch_match = re.search(r'twitch\.tv/([\w]+)/', args.url)
    if ch_match and ch_match.group(1) != 'videos':
        source_label = f"Original ({ch_match.group(1)})"

    matches.insert(0, {'streamer': source_label, 'result': args.url})

    # Print rough results
    for m in matches:
        print(f"  {m['streamer']:20s}  {m['result']}")

    # Preserve the original (rough) timestamps as the starting point
    for m in matches:
        _, ts_str, ts_sec, _ = parse_twitch_url(m['result'])
        m['refined_ts'] = ts_str
        m['ts_sec'] = ts_sec
        m['offset'] = 0.0
        m['total_offset'] = 0.0  # (corrected_sec2 - T0)

    # ── Step 2 & 3: audio cross-correlation ───────────────────────────────
    if not args.no_refine and len(matches) >= 2:
        print(f"\n[2/3] Refining timestamps with audio cross-correlation…")

        _, ts_str_src, ts_sec_src, _ = parse_twitch_url(matches[0]['result'])
        vid_src, _, _, _ = parse_twitch_url(matches[0]['result'])

        if vid_src:  # Only do this for VOD sources (not clips, which have no timestamp)
            src_vod_url = matches[0]['result']

            for m in matches[1:]:
                vid2, ts_str2, ts_sec2, clip2 = parse_twitch_url(m['result'])
                if not vid2:
                    print(f"  Skipping clip '{m['streamer']}' (no timestamp to refine).")
                    continue

                try:
                    offset = calculate_audio_offset(
                        src_vod_url, ts_sec_src,
                        m['result'],  ts_sec2
                    )
                    # A positive lag means vod2 audio arrived AFTER vod1's
                    # → subtract to bring vod2's time back
                    corrected_sec = ts_sec2 - offset
                    corrected_ts  = seconds_to_twitch_ts(corrected_sec)
                    print(f"  {m['streamer']:20s}  rough={ts_str2}  "
                          f"offset={offset:+.3f}s  refined={corrected_ts}")
                    m['refined_ts'] = corrected_ts
                    m['offset']     = offset
                    # Total offset relative to source at start
                    m['total_offset'] = corrected_sec - ts_sec_src
                    # Also update result URL so it shows the corrected link
                    m['result'] = build_twitch_vod_url(vid2, corrected_ts)

                except Exception as e:
                    print(f"  [WARNING] Audio refinement failed for '{m['streamer']}': {e}")
                    print(f"           Falling back to rough timestamp {ts_str2}.")
        else:
            print("  Source URL is a clip — skipping audio refinement.")
    else:
        print("\n[2/3] Skipping audio refinement (--no-refine or single match).")

    # ── Step 4: generate HTML ──────────────────────────────────────────────
    print(f"\n[3/3] Generating HTML…")
    out_dir = os.path.dirname(args.out)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    generate_html(matches, args.out)


if __name__ == "__main__":
    main()
