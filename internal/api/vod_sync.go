package api

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	twitchToken      string
	twitchTokenMutex sync.Mutex
	twitchTokenExp   time.Time
)

type TwitchFollowedResponse struct {
	UserName        string `json:"user_name"`
	UserLogin       string `json:"user_login"`
	ProfileImageURL string `json:"profile_image_url"`
	IsLive          bool   `json:"is_live"`
	ViewerCount     int    `json:"viewer_count"`
	Title           string `json:"title"`
	GameName        string `json:"game_name"`
	VideoID         string `json:"video_id,omitempty"`
}

func GetTwitchToken(clientID, clientSecret string) (string, error) {
	twitchTokenMutex.Lock()
	defer twitchTokenMutex.Unlock()

	if twitchToken != "" && time.Now().Before(twitchTokenExp) {
		return twitchToken, nil
	}

	authURL := "https://id.twitch.tv/oauth2/token"
	data := url.Values{}
	data.Set("client_id", clientID)
	data.Set("client_secret", clientSecret)
	data.Set("grant_type", "client_credentials")

	req, err := http.NewRequest("POST", authURL, strings.NewReader(data.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Add("Content-Type", "application/x-www-form-urlencoded")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("failed to get token: %s", string(body))
	}

	var res struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return "", err
	}

	twitchToken = res.AccessToken
	twitchTokenExp = time.Now().Add(time.Duration(res.ExpiresIn-60) * time.Second)
	return twitchToken, nil
}

type VodSyncRequest struct {
	Url       string   `json:"url"`
	Streamers []string `json:"streamers"`
}

type VodSyncConfig struct {
	Label       string  `json:"label"`
	Video       string  `json:"video,omitempty"`
	Clip        string  `json:"clip,omitempty"`
	Time        string  `json:"time,omitempty"`
	Offset      float64 `json:"offset"`
	TotalOffset float64 `json:"total_offset"`
}

type TwitchVideoResp struct {
	Data []struct {
		Id        string `json:"id"`
		UserId    string `json:"user_id"`
		UserName  string `json:"user_name"`
		CreatedAt string `json:"created_at"`
		Duration  string `json:"duration"`
	} `json:"data"`
}

type TwitchClipResp struct {
	Data []struct {
		Id              string `json:"id"`
		VideoId         string `json:"video_id"`
		VodOffset       int    `json:"vod_offset"`
		CreatedAt       string `json:"created_at"`
		BroadcasterName string `json:"broadcaster_name"`
	} `json:"data"`
}

func parseDurationStr(durationStr string) float64 {
	h, m, s := 0, 0, 0

	hIdx := strings.Index(durationStr, "h")
	if hIdx != -1 {
		h, _ = strconv.Atoi(durationStr[:hIdx])
		durationStr = durationStr[hIdx+1:]
	}

	mIdx := strings.Index(durationStr, "m")
	if mIdx != -1 {
		m, _ = strconv.Atoi(durationStr[:mIdx])
		durationStr = durationStr[mIdx+1:]
	}

	sIdx := strings.Index(durationStr, "s")
	if sIdx != -1 {
		s, _ = strconv.Atoi(durationStr[:sIdx])
	}

	return float64(h*3600 + m*60 + s)
}

func parseTwitchUrl(apiUrl string) (string, string, float64, string) {
	videoIdRe := regexp.MustCompile(`videos/(\d+)`)
	timeRe := regexp.MustCompile(`[?&]t=([\dhms]+)`)
	clipRe := regexp.MustCompile(`/clip/([^?&]+)`)
	clipsDomRe := regexp.MustCompile(`clips\.twitch\.tv/([^?&]+)`)

	var videoId, timeStr, clipSlug string
	var totalSeconds float64

	if m := videoIdRe.FindStringSubmatch(apiUrl); len(m) > 1 {
		videoId = m[1]
	}
	if m := timeRe.FindStringSubmatch(apiUrl); len(m) > 1 {
		timeStr = m[1]
		totalSeconds = parseDurationStr(timeStr)
	} else {
		timeStr = "0s"
	}

	if m := clipRe.FindStringSubmatch(apiUrl); len(m) > 1 {
		clipSlug = m[1]
	} else if m := clipsDomRe.FindStringSubmatch(apiUrl); len(m) > 1 {
		clipSlug = m[1]
	}

	return videoId, timeStr, totalSeconds, clipSlug
}

func formatDurationStr(totalSeconds float64) string {
	ts := int(math.Max(0, math.Round(totalSeconds)))
	h := ts / 3600
	m := (ts % 3600) / 60
	s := ts % 60
	return fmt.Sprintf("%dh%dm%ds", h, m, s)
}

func doTwitchGet(endpoint string, clientID, token string, result interface{}) error {
	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Client-ID", clientID)
	req.Header.Set("Authorization", "Bearer "+token)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("twitch api error (status %d): %s", resp.StatusCode, string(body))
	}

	if err := json.NewDecoder(resp.Body).Decode(result); err != nil {
		return err
	}
	return nil
}

func ytDlpAvailable() bool {
	_, err := exec.LookPath("yt-dlp")
	return err == nil
}

func downloadAndProcessAudio(vodUrl string, startSec float64, outPcmPath string) error {
	clipStart := int(math.Max(0, startSec-5))
	clipEnd := clipStart + 10
	sectionArg := fmt.Sprintf("*%d-%d", clipStart, clipEnd)

	tmpDir, err := os.MkdirTemp("", "dl_*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpDir)

	dlBase := filepath.Join(tmpDir, "dl")

	cmd := exec.Command("yt-dlp",
		vodUrl,
		"--no-playlist",
		"--quiet",
		"--no-warnings",
		"--format", "bestaudio/best",
		"--download-sections", sectionArg,
		"-o", dlBase+".%(ext)s",
	)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("yt-dlp failed: %v", err)
	}

	files, _ := filepath.Glob(dlBase + ".*")
	if len(files) == 0 {
		return fmt.Errorf("yt-dlp did not produce any audio file")
	}
	dlFile := files[0]

	cmdConv := exec.Command("ffmpeg",
		"-i", dlFile,
		"-ar", "2000",
		"-ac", "1",
		"-f", "s16le",
		"-c:a", "pcm_s16le",
		outPcmPath,
	)
	if err := cmdConv.Run(); err != nil {
		return fmt.Errorf("ffmpeg failed: %v", err)
	}

	return nil
}

func readPCM(path string) ([]int16, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	samples := make([]int16, len(b)/2)
	for i := 0; i < len(samples); i++ {
		samples[i] = int16(b[i*2]) | (int16(b[i*2+1]) << 8)
	}
	return samples, nil
}

func correlate(d1, d2 []int16) int {
	n1 := len(d1)
	n2 := len(d2)
	minLen := n1
	if n2 < minLen {
		minLen = n2
	}
	d1 = d1[:minLen]
	d2 = d2[:minLen]

	N := minLen
	bestLag := 0
	var maxCor int64 = math.MinInt64

	for lag := -N + 1; lag < N; lag++ {
		var sum int64
		if lag >= 0 {
			for i := 0; i < N-lag; i++ {
				sum += int64(d1[i+lag]) * int64(d2[i])
			}
		} else {
			absLag := -lag
			for i := 0; i < N-absLag; i++ {
				sum += int64(d1[i]) * int64(d2[i+absLag])
			}
		}

		if maxCor == math.MinInt64 || sum > maxCor {
			maxCor = sum
			bestLag = lag
		}
	}
	return bestLag
}

func HandleVodSync(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")

	var req VodSyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": err.Error()})
		return
	}

	clientID := os.Getenv("TWITCH_CLIENT_ID")
	clientSecret := os.Getenv("TWITCH_CLIENT_SECRET")
	if clientID == "" || clientSecret == "" {
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "Twitch API credentials not configured"})
		return
	}

	token, err := GetTwitchToken(clientID, clientSecret)
	if err != nil {
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "Failed to authenticate with Twitch"})
		return
	}

	videoId, timeStr, totalSecs, clipSlug := parseTwitchUrl(req.Url)
	var absoluteTime time.Time

	sourceLabel := "Source VOD"
	cleanUrl := strings.ReplaceAll(req.Url, "https://", "")
	cleanUrl = strings.ReplaceAll(cleanUrl, "http://", "")
	cleanUrl = strings.ReplaceAll(cleanUrl, "www.", "")

	chMatch := regexp.MustCompile(`twitch\.tv/([^/?#]+)`).FindStringSubmatch(cleanUrl)
	if len(chMatch) > 1 {
		candidate := chMatch[1]
		if candidate != "videos" {
			sourceLabel = candidate
		}
	}

	// Determine the absolute timestamp of the source media
	if clipSlug != "" {
		var clipData TwitchClipResp
		err = doTwitchGet("https://api.twitch.tv/helix/clips?id="+clipSlug, clientID, token, &clipData)
		if err == nil && len(clipData.Data) > 0 {
			vId := clipData.Data[0].VideoId
			sourceLabel = clipData.Data[0].BroadcasterName

			if vId != "" {
				// Get video to find created_at
				var vData TwitchVideoResp
				err = doTwitchGet("https://api.twitch.tv/helix/videos?id="+vId, clientID, token, &vData)
				if err == nil && len(vData.Data) > 0 {
					createdAt, _ := time.Parse(time.RFC3339, vData.Data[0].CreatedAt)
					absoluteTime = createdAt.Add(time.Duration(clipData.Data[0].VodOffset) * time.Second)
				}
			} else {
				absoluteTime, _ = time.Parse(time.RFC3339, clipData.Data[0].CreatedAt)
			}
		}
	} else if videoId != "" {
		var vData TwitchVideoResp
		err = doTwitchGet("https://api.twitch.tv/helix/videos?id="+videoId, clientID, token, &vData)
		if err == nil && len(vData.Data) > 0 {
			sourceLabel = vData.Data[0].UserName
			createdAt, _ := time.Parse(time.RFC3339, vData.Data[0].CreatedAt)
			absoluteTime = createdAt.Add(time.Duration(totalSecs) * time.Second)
		}
	} else {
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "Could not parse clip or video ID from URL"})
		return
	}

	var configs []VodSyncConfig
	configs = append(configs, VodSyncConfig{
		Label:       sourceLabel,
		Video:       videoId,
		Clip:        clipSlug,
		Time:        timeStr,
		Offset:      0,
		TotalOffset: 0,
	})

	// Loop over requested streamers and find synced VODs
	for _, streamer := range req.Streamers {
		// Get user ID
		var usersData struct {
			Data []struct {
				Id string `json:"id"`
			} `json:"data"`
		}
		endpoint := "https://api.twitch.tv/helix/users?login=" + url.QueryEscape(streamer)
		err = doTwitchGet(endpoint, clientID, token, &usersData)
		if err != nil || len(usersData.Data) == 0 {
			log.Printf("Could not find user %s", streamer)
			continue
		}
		userId := usersData.Data[0].Id

		// Get recent VODs
		var proxyData TwitchVideoResp
		endpoint = fmt.Sprintf("https://api.twitch.tv/helix/videos?user_id=%s&first=50", userId)
		err = doTwitchGet(endpoint, clientID, token, &proxyData)
		if err != nil {
			log.Printf("Could not fetch videos for %s", streamer)
			continue
		}

		var foundVod *TwitchVideoResp
		var foundVodIdx int
		for i, v := range proxyData.Data {
			vCreated, _ := time.Parse(time.RFC3339, v.CreatedAt)
			vDur := parseDurationStr(v.Duration)
			vEnded := vCreated.Add(time.Duration(vDur) * time.Second)

			// Video must have started before the target time and ended after it
			if (vCreated.Before(absoluteTime) || vCreated.Equal(absoluteTime)) && absoluteTime.Before(vEnded) {
				foundVodIdx = i
				foundVod = &proxyData // hacky but easy to reference
				break
			}
		}

		if foundVod != nil {
			v := foundVod.Data[foundVodIdx]
			vCreated, _ := time.Parse(time.RFC3339, v.CreatedAt)
			offsetSecs := absoluteTime.Sub(vCreated).Seconds()

			configs = append(configs, VodSyncConfig{
				Label:       streamer,
				Video:       v.Id,
				Time:        formatDurationStr(offsetSecs),
				Offset:      0.0,
				TotalOffset: 0.0,
			})
		}
	}

	if len(configs) >= 2 && ytDlpAvailable() {
		src := configs[0]
		if src.Video != "" {
			srcSecs := parseDurationStr(src.Time)
			srcVodUrl := "https://www.twitch.tv/videos/" + src.Video

			tmpDir, err := os.MkdirTemp("", "twitchsync_*")
			if err == nil {
				defer os.RemoveAll(tmpDir)

				srcPcmPath := filepath.Join(tmpDir, "src.pcm")
				err = downloadAndProcessAudio(srcVodUrl, srcSecs, srcPcmPath)
				if err == nil {
					srcAudio, _ := readPCM(srcPcmPath)
					for i := 1; i < len(configs); i++ {
						tgt := configs[i]
						if tgt.Video != "" {
							tgtSecs := parseDurationStr(tgt.Time)
							tgtVodUrl := "https://www.twitch.tv/videos/" + tgt.Video

							tgtPcmPath := filepath.Join(tmpDir, fmt.Sprintf("tgt_%d.pcm", i))
							err := downloadAndProcessAudio(tgtVodUrl, tgtSecs, tgtPcmPath)
							if err == nil {
								tgtAudio, _ := readPCM(tgtPcmPath)
								bestLag := correlate(srcAudio, tgtAudio)
								offsetSecs := float64(bestLag) / 2000.0
								correctedSec := tgtSecs - offsetSecs
								configs[i].Time = formatDurationStr(correctedSec)
								configs[i].Offset = offsetSecs
								configs[i].TotalOffset = correctedSec - srcSecs
							} else {
								log.Printf("Audio download failed for %s: %v", tgt.Label, err)
							}
						}
					}
				} else {
					log.Printf("Failed to download source audio: %v", err)
				}
			}
		}
	}

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"data":    configs,
	})
}
