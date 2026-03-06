package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/joho/godotenv"
)

var (
	twitchToken      string
	twitchTokenMutex sync.Mutex
	twitchTokenExp   time.Time

	// YouTube Live Cache: channelId -> cached response
	youtubeLiveCache    sync.Map
	youtubeLiveCacheDur = 5 * time.Minute
)

type YTChannelCacheEntry struct {
	Response TwitchFollowedResponse
	Exp      time.Time
}

func getTwitchToken(clientID, clientSecret string) (string, error) {
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

func main() {
	// Load .env file
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found")
	}

	// Serve static folders securely
	http.Handle("/css/", http.StripPrefix("/css/", http.FileServer(http.Dir("./ui/css"))))
	http.Handle("/js/", http.StripPrefix("/js/", http.FileServer(http.Dir("./ui/js"))))
	http.Handle("/assets/", http.StripPrefix("/assets/", http.FileServer(http.Dir("./ui/assets"))))

	// Placeholder /api/health JSON route
	http.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})

	// Serve index.html at root, or /vod/*
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" && !strings.HasPrefix(r.URL.Path, "/vod/") {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, "ui/index.html")
	})

	http.HandleFunc("/api/vod-sync", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		reqBytes, _ := json.Marshal(req)

		cmd := exec.Command("python", "scripts/vod_sync.py")
		cmd.Env = os.Environ() // Ensure environment variables are passed to Python
		cmd.Stdin = bytes.NewReader(reqBytes)
		out, err := cmd.CombinedOutput()

		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			log.Printf("Python script error: %v %s", err, string(out))
			json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": err.Error(), "details": string(out)})
			return
		}
		w.Write(out)
	})

	http.HandleFunc("/api/twitch/followed", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")

		loginsParam := r.URL.Query().Get("logins")
		if loginsParam == "" {
			json.NewEncoder(w).Encode([]TwitchFollowedResponse{})
			return
		}

		logins := strings.Split(loginsParam, ",")
		if len(logins) > 100 {
			logins = logins[:100] // twitch API limits 100 per request
		}

		clientID := os.Getenv("TWITCH_CLIENT_ID")
		clientSecret := os.Getenv("TWITCH_CLIENT_SECRET")

		if clientID == "" || clientSecret == "" {
			http.Error(w, "Twitch API credentials not configured", http.StatusInternalServerError)
			return
		}

		token, err := getTwitchToken(clientID, clientSecret)
		if err != nil {
			http.Error(w, "Failed to authenticate with Twitch", http.StatusInternalServerError)
			return
		}

		// 1. Fetch Users
		usersReq, _ := http.NewRequest("GET", "https://api.twitch.tv/helix/users", nil)
		usersReq.Header.Set("Client-ID", clientID)
		usersReq.Header.Set("Authorization", "Bearer "+token)

		q := usersReq.URL.Query()
		for _, login := range logins {
			q.Add("login", strings.TrimSpace(login))
		}
		usersReq.URL.RawQuery = q.Encode()

		client := &http.Client{Timeout: 10 * time.Second}
		usersResp, err := client.Do(usersReq)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer usersResp.Body.Close()

		var usersData struct {
			Data []struct {
				Login           string `json:"login"`
				DisplayName     string `json:"display_name"`
				ProfileImageURL string `json:"profile_image_url"`
			} `json:"data"`
		}
		json.NewDecoder(usersResp.Body).Decode(&usersData)

		// 2. Fetch Streams
		streamsReq, _ := http.NewRequest("GET", "https://api.twitch.tv/helix/streams", nil)
		streamsReq.Header.Set("Client-ID", clientID)
		streamsReq.Header.Set("Authorization", "Bearer "+token)

		sq := streamsReq.URL.Query()
		for _, login := range logins {
			sq.Add("user_login", strings.TrimSpace(login))
		}
		streamsReq.URL.RawQuery = sq.Encode()

		streamsResp, err := client.Do(streamsReq)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer streamsResp.Body.Close()

		var streamsData struct {
			Data []struct {
				UserLogin   string `json:"user_login"`
				ViewerCount int    `json:"viewer_count"`
				Title       string `json:"title"`
				GameName    string `json:"game_name"`
				Type        string `json:"type"`
			} `json:"data"`
		}
		json.NewDecoder(streamsResp.Body).Decode(&streamsData)

		// 3. Map Streams
		streamMap := make(map[string]struct {
			ViewerCount int
			Title       string
			GameName    string
			IsLive      bool
		})
		for _, s := range streamsData.Data {
			if s.Type == "live" {
				streamMap[strings.ToLower(s.UserLogin)] = struct {
					ViewerCount int
					Title       string
					GameName    string
					IsLive      bool
				}{s.ViewerCount, s.Title, s.GameName, true}
			}
		}

		// 4. Build Response
		var result []TwitchFollowedResponse
		for _, u := range usersData.Data {
			out := TwitchFollowedResponse{
				UserName:        u.DisplayName,
				UserLogin:       u.Login,
				ProfileImageURL: u.ProfileImageURL,
			}
			if s, ok := streamMap[strings.ToLower(u.Login)]; ok {
				out.IsLive = true
				out.ViewerCount = s.ViewerCount
				out.Title = s.Title
				out.GameName = s.GameName
			}
			result = append(result, out)
		}

		json.NewEncoder(w).Encode(result)
	})

	http.HandleFunc("/api/youtube/resolve", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		q := r.URL.Query().Get("q")
		if q == "" {
			http.Error(w, "Query parameter 'q' is required", http.StatusBadRequest)
			return
		}

		apiKey := os.Getenv("YOUTUBE_API_KEY")
		if apiKey == "" {
			http.Error(w, "YouTube API key not configured", http.StatusInternalServerError)
			return
		}

		// determine if it's an ID, handle, or username
		apiURL := "https://www.googleapis.com/youtube/v3/channels?part=snippet,id&key=" + apiKey

		if strings.HasPrefix(q, "UC") && len(q) == 24 {
			apiURL += "&id=" + url.QueryEscape(q)
		} else if strings.HasPrefix(q, "@") {
			apiURL += "&forHandle=" + url.QueryEscape(q)
		} else {
			// fallback try forHandle then forUsername
			// The new youtube api usually deals with handles for almost everything.
			// Try as forUsername first
			apiURL += "&forUsername=" + url.QueryEscape(q)
		}

		resp, err := http.Get(apiURL)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer resp.Body.Close()

		var data struct {
			Items []struct {
				Id      string `json:"id"`
				Snippet struct {
					Title      string `json:"title"`
					Thumbnails struct {
						Default struct {
							Url string `json:"url"`
						} `json:"default"`
					} `json:"thumbnails"`
				} `json:"snippet"`
			} `json:"items"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		if len(data.Items) == 0 && !strings.HasPrefix(q, "UC") && !strings.HasPrefix(q, "@") {
			// Fallback to forHandle if forUsername didn't work and it doesn't have an @
			fallbackURL := "https://www.googleapis.com/youtube/v3/channels?part=snippet,id&key=" + apiKey + "&forHandle=" + url.QueryEscape("@"+q)
			resp2, err2 := http.Get(fallbackURL)
			if err2 == nil {
				defer resp2.Body.Close()
				json.NewDecoder(resp2.Body).Decode(&data)
			}
		}

		if len(data.Items) == 0 {
			http.Error(w, "Channel not found", http.StatusNotFound)
			return
		}

		item := data.Items[0]
		json.NewEncoder(w).Encode(map[string]string{
			"id":              item.Id,
			"title":           item.Snippet.Title,
			"profileImageURL": item.Snippet.Thumbnails.Default.Url,
		})
	})

	http.HandleFunc("/api/youtube/followed", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		idsParam := r.URL.Query().Get("ids")
		if idsParam == "" {
			json.NewEncoder(w).Encode([]TwitchFollowedResponse{}) // reuse the struct
			return
		}

		apiKey := os.Getenv("YOUTUBE_API_KEY")
		if apiKey == "" {
			http.Error(w, "YouTube API key not configured", http.StatusInternalServerError)
			return
		}

		ids := strings.Split(idsParam, ",")
		if len(ids) > 50 {
			ids = ids[:50]
		}

		// 1. Fetch channel details to render even if offline
		channelsURL := "https://www.googleapis.com/youtube/v3/channels?part=snippet&key=" + apiKey + "&id=" + url.QueryEscape(strings.Join(ids, ","))
		chResp, err := http.Get(channelsURL)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer chResp.Body.Close()

		var chData struct {
			Items []struct {
				Id      string `json:"id"`
				Snippet struct {
					Title      string `json:"title"`
					Thumbnails struct {
						Default struct {
							Url string `json:"url"`
						} `json:"default"`
					} `json:"thumbnails"`
				} `json:"snippet"`
			} `json:"items"`
		}
		json.NewDecoder(chResp.Body).Decode(&chData)

		channelInfoMap := make(map[string]struct{ Title, ProfileImageURL string })
		for _, ch := range chData.Items {
			channelInfoMap[ch.Id] = struct{ Title, ProfileImageURL string }{
				Title:           ch.Snippet.Title,
				ProfileImageURL: ch.Snippet.Thumbnails.Default.Url,
			}
		}

		// 2. Fetch live status using search endpoint for each channel (youtube requires channelId filter for live events)
		// To save quota, we could search for all videoId's, but we don't know the videoIds.
		// Wait, search endpoint only allows ONE channelId per request.
		// Doing a search request per channel is 100 quota units each! This is extremely expensive (10 channels = 1000 units, polling every minute = quota exhausted in 10 minutes).

		// A much cheaper alternative (1 unit) to get if a channel is live:
		// use 'search.list' without channel ID but with query? No.
		// Wait, we can fetch the channel's uploads playlist? No, live streams don't show up reliably.
		// Is there a cheaper way to check live status?
		// We could batch fetch if we store videoIds. But how do we get videoIds?
		// Let's just do search.list for each channel concurrently, since we have no other choice, but we should limit the frequency!
		// However, a common trick is to query the channel's page HTML or use an RSS feed, but here we require API.

		// We need to fetch live status for channels that are expired or missing from cache
		type LiveInfo struct {
			VideoId string
			Title   string
		}
		liveStreams := make(map[string]*LiveInfo)

		var wg sync.WaitGroup
		var mutex sync.Mutex

		now := time.Now()
		for _, chId := range ids {
			// Check cache first
			if cached, ok := youtubeLiveCache.Load(chId); ok {
				entry := cached.(YTChannelCacheEntry)
				if now.Before(entry.Exp) {
					// Use entirely cached response
					continue
				}
			}

			wg.Add(1)
			go func(channelId string) {
				defer wg.Done()
				searchURL := fmt.Sprintf("https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=%s&type=video&eventType=live&key=%s", url.QueryEscape(channelId), apiKey)
				sResp, sErr := http.Get(searchURL)
				if sErr == nil {
					defer sResp.Body.Close()
					var sData struct {
						Items []struct {
							Id struct {
								VideoId string `json:"videoId"`
							} `json:"id"`
							Snippet struct {
								Title string `json:"title"`
							} `json:"snippet"`
						} `json:"items"`
					}
					json.NewDecoder(sResp.Body).Decode(&sData)
					if len(sData.Items) > 0 {
						mutex.Lock()
						liveStreams[channelId] = &LiveInfo{
							VideoId: sData.Items[0].Id.VideoId,
							Title:   sData.Items[0].Snippet.Title,
						}
						mutex.Unlock()
					} else {
						// mark as offline explicitly
						mutex.Lock()
						liveStreams[channelId] = nil
						mutex.Unlock()
					}
				}
			}(chId)
		}
		wg.Wait()

		// 3. For the live streams, fetch viewer count using videos.list
		var result []TwitchFollowedResponse
		for _, chId := range ids {
			info := channelInfoMap[chId]

			// Check cache first
			if cached, ok := youtubeLiveCache.Load(chId); ok {
				entry := cached.(YTChannelCacheEntry)
				if now.Before(entry.Exp) {
					// Use entirely cached response, just update channel title/img possibly
					res := entry.Response
					res.UserName = info.Title
					res.ProfileImageURL = info.ProfileImageURL
					result = append(result, res)
					continue
				}
			}

			out := TwitchFollowedResponse{
				UserName:        info.Title,
				UserLogin:       chId, // use channelId as login for Youtube
				ProfileImageURL: info.ProfileImageURL,
			}

			if liveInfoPointer, exists := liveStreams[chId]; exists && liveInfoPointer != nil {
				live := *liveInfoPointer
				out.IsLive = true
				out.Title = live.Title
				out.GameName = "YouTube Live" // Youtube doesn't easily expose game name here
				out.VideoID = live.VideoId

				// Fetch viewer count details
				vidURL := fmt.Sprintf("https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=%s&key=%s", url.QueryEscape(live.VideoId), apiKey)
				vResp, vErr := http.Get(vidURL)
				if vErr == nil {
					var vData struct {
						Items []struct {
							LiveStreamingDetails struct {
								ConcurrentViewers string `json:"concurrentViewers"`
							} `json:"liveStreamingDetails"`
						} `json:"items"`
					}
					defer vResp.Body.Close()
					json.NewDecoder(vResp.Body).Decode(&vData)
					if len(vData.Items) > 0 {
						viewers, _ := strconv.Atoi(vData.Items[0].LiveStreamingDetails.ConcurrentViewers)
						out.ViewerCount = viewers
					}
				}
			}

			// Save to cache for 5-10 mins to save quota (let's use 5 min)
			youtubeLiveCache.Store(chId, YTChannelCacheEntry{
				Response: out,
				Exp:      time.Now().Add(youtubeLiveCacheDur),
			})

			result = append(result, out)
		}

		json.NewEncoder(w).Encode(result)
	})

	log.Println("Starting server on :8080...")
	if err := http.ListenAndServe(":8080", nil); err != nil {
		log.Fatalf("Server failed to start: %v", err)
	}
}
