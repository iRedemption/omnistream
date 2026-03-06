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
	"strings"
	"sync"
	"time"

	"github.com/joho/godotenv"
)

var (
	twitchToken      string
	twitchTokenMutex sync.Mutex
	twitchTokenExp   time.Time
)

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

	log.Println("Starting server on :8080...")
	if err := http.ListenAndServe(":8080", nil); err != nil {
		log.Fatalf("Server failed to start: %v", err)
	}
}
