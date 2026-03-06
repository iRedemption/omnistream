import os
import sys
import json
import re
import urllib.request
import tempfile
import shutil
import subprocess
import numpy as np
from scipy.io import wavfile
from scipy.signal import correlate
from twitchsync import TwitchSync

SAMPLE_RATE = 44100
CLIP_SECONDS = 10

def parse_twitch_url(url):
    video_id_match = re.search(r'videos/(\d+)', url)
    time_match     = re.search(r'[?&]t=([\dhms]+)', url)
    clip_match     = re.search(r'/clip/([\w-]+)', url)

    video_id   = video_id_match.group(1) if video_id_match else None
    clip_slug  = clip_match.group(1)     if clip_match     else None
    ts_str     = time_match.group(1)     if time_match     else "0s"

    h_match = re.search(r'(\d+)h', ts_str)
    m_match = re.search(r'(\d+)m', ts_str)
    s_match = re.search(r'(\d+)s', ts_str)

    h = int(h_match.group(1)) if h_match else 0
    m = int(m_match.group(1)) if m_match else 0
    s = int(s_match.group(1)) if s_match else 0
    
    total_seconds = h * 3600 + m * 60 + s
    return video_id, ts_str, total_seconds, clip_slug

def seconds_to_twitch_ts(total_seconds):
    total_seconds = max(0, round(total_seconds))
    h = total_seconds // 3600
    m = (total_seconds % 3600) // 60
    s = total_seconds % 60
    return f"{h}h{m}m{s}s"

def build_twitch_vod_url(video_id, ts_str):
    return f"https://www.twitch.tv/videos/{video_id}?t={ts_str}"

def _yt_dlp_available():
    return shutil.which("yt-dlp") is not None or shutil.which("yt_dlp") is not None

def download_audio_segment(vod_url, start_sec, out_path, clip_dur=CLIP_SECONDS):
    clip_start = max(0, start_sec - CLIP_SECONDS // 2)
    clip_end   = clip_start + CLIP_SECONDS
    section_arg = f"*{clip_start}-{clip_end}"

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
        raise RuntimeError(f"yt-dlp failed for {vod_url}:\n{result.stderr}")

    if not os.path.exists(out_path):
        candidate = out_path + ".wav"
        if os.path.exists(candidate):
            os.rename(candidate, out_path)
        else:
            raise FileNotFoundError(f"yt-dlp didn't produce expected file at {out_path}")

def calculate_audio_offset(vod1_url, time1_sec, vod2_url, time2_sec):
    if not _yt_dlp_available():
        return 0.0

    tmp_dir = tempfile.mkdtemp(prefix="twitchsync_")
    wav1 = os.path.join(tmp_dir, "vod1.wav")
    wav2 = os.path.join(tmp_dir, "vod2.wav")

    try:
        download_audio_segment(vod1_url, time1_sec, wav1)
        download_audio_segment(vod2_url, time2_sec, wav2)

        rate1, data1 = wavfile.read(wav1)
        rate2, data2 = wavfile.read(wav2)

        data1 = data1.astype(np.float32) / np.iinfo(data1.dtype).max
        data2 = data2.astype(np.float32) / np.iinfo(data2.dtype).max

        if data1.ndim > 1: data1 = data1.mean(axis=1)
        if data2.ndim > 1: data2 = data2.mean(axis=1)

        min_len = min(len(data1), len(data2))
        data1 = data1[:min_len]
        data2 = data2[:min_len]

        correlation = correlate(data1, data2, mode='full')
        lags        = np.arange(-(min_len - 1), min_len)
        best_lag    = lags[np.argmax(correlation)]

        sr = rate1 if rate1 > 0 else SAMPLE_RATE
        return float(best_lag / sr)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

def get_streamer_from_api(video_id, client_id, client_secret):
    try:
        auth_url = "https://id.twitch.tv/oauth2/token"
        body = f"client_id={client_id}&client_secret={client_secret}&grant_type=client_credentials".encode('utf-8')
        with urllib.request.urlopen(auth_url, data=body) as response:
            auth_data = json.loads(response.read().decode())
            token = auth_data['access_token']
        
        video_url = f"https://api.twitch.tv/helix/videos?id={video_id}"
        req = urllib.request.Request(video_url, headers={
            "Client-ID": client_id,
            "Authorization": f"Bearer {token}"
        })
        with urllib.request.urlopen(req) as response:
            video_data = json.loads(response.read().decode())
            if video_data['data'] and 'user_name' in video_data['data'][0]:
                return video_data['data'][0]['user_name']
    except:
        pass
    return None

def main():
    try:
        input_data = sys.stdin.read()
        if not input_data:
            return
        
        req = json.loads(input_data)
        url = req.get("url")
        streamers = req.get("streamers", [])
        
        client_id = os.environ.get("TWITCH_CLIENT_ID", "")
        client_secret = os.environ.get("TWITCH_CLIENT_SECRET", "")
        client = TwitchSync(client_id=client_id, client_secret=client_secret)
        matches = client.get_matches_for_all_streamers(streamers, url)
        
        # Determine source label
        source_label = "Source VOD"
        url_clean = url.replace('https://', '').replace('http://', '').replace('www.', '')
        ch_match = re.search(r'twitch\.tv/([^/?#]+)', url_clean)
        
        if ch_match:
            candidate = ch_match.group(1)
            if candidate != 'videos':
                source_label = candidate
            else:
                # If it's just /videos/ID, try to fetch the streamer name from the API
                video_id, _, _, _ = parse_twitch_url(url)
                if video_id and client_id and client_secret:
                    api_name = get_streamer_from_api(video_id, client_id, client_secret)
                    if api_name:
                        source_label = api_name

        matches.insert(0, {'streamer': source_label, 'result': url})

        for m in matches:
            _, ts_str, ts_sec, _ = parse_twitch_url(m['result'])
            m['refined_ts'] = ts_str
            m['ts_sec'] = ts_sec
            m['offset'] = 0.0
            m['total_offset'] = 0.0

        if len(matches) >= 2:
            vid_src, ts_str_src, ts_sec_src, _ = parse_twitch_url(matches[0]['result'])
            if vid_src:
                src_vod_url = matches[0]['result']
                for m in matches[1:]:
                    vid2, ts_str2, ts_sec2, clip2 = parse_twitch_url(m['result'])
                    if not vid2: continue
                    try:
                        offset = calculate_audio_offset(src_vod_url, ts_sec_src, m['result'], ts_sec2)
                        corrected_sec = ts_sec2 - offset
                        corrected_ts  = seconds_to_twitch_ts(corrected_sec)
                        m['refined_ts'] = corrected_ts
                        m['offset']     = offset
                        m['total_offset'] = corrected_sec - ts_sec_src
                        m['result'] = build_twitch_vod_url(vid2, corrected_ts)
                    except Exception:
                        pass
        
        # Format the output items nicely
        configs = []
        for match in matches:
            video_id, _, _, clip_slug = parse_twitch_url(match['result'])
            cfg = {"label": match['streamer']}
            if video_id:
                cfg["video"] = video_id
                cfg["time"]  = match.get('refined_ts')
                cfg["offset"] = match.get('offset', 0)
                cfg["total_offset"] = match.get('total_offset', 0)
            elif clip_slug:
                cfg["clip"] = clip_slug
            configs.append(cfg)
            
        print(json.dumps({"success": True, "data": configs}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    main()
