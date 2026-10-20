package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	refreshCookieName = "refresh_token"
	refreshCookiePath = "/api/auth"
	sessionLifetime   = 7 * 24 * time.Hour
)

type session struct {
	Username  string
	ExpiresAt time.Time
}

type server struct {
	mu           sync.Mutex
	sessions     map[string]session
	cookieSecure bool
}

type jsonResponse map[string]any

func main() {
	secureCookie := strings.EqualFold(os.Getenv("COOKIE_SECURE"), "true")
	if os.Getenv("COOKIE_SECURE") == "" {
		log.Println("COOKIE_SECURE is unset; using Secure=false for local HTTP development. Set COOKIE_SECURE=true on Render.")
	}

	s := &server{
		sessions:     make(map[string]session),
		cookieSecure: secureCookie,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("GET /api/auth/check", s.handleCheck)
	mux.HandleFunc("POST /api/auth/refresh", s.handleRefresh)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, jsonResponse{"error": "not_found", "path": r.URL.Path})
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	addr := ":" + port
	log.Printf("Refresh-cookie test API listening on %s (cookie Secure=%t)", addr, secureCookie)
	log.Fatal(http.ListenAndServe(addr, logRequests(mux)))
}

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, jsonResponse{
		"ok":           true,
		"service":      "go-refresh-cookie-test-api",
		"time":         time.Now().UTC().Format(time.RFC3339),
		"cookieSecure": s.cookieSecure,
		"note":         "Call this through the frontend's /api path to test the rewrite.",
	})
}

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, jsonResponse{"error": "invalid_json", "message": "Request body must be valid JSON."})
		return
	}

	// Intentionally fixed demo credentials. This project is for testing cookie routing only.
	if body.Username != "demo" || body.Password != "password123" {
		writeJSON(w, http.StatusUnauthorized, jsonResponse{"error": "invalid_credentials", "message": "Use the demo credentials shown in the frontend."})
		return
	}

	token, err := randomToken()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, jsonResponse{"error": "token_generation_failed"})
		return
	}

	s.mu.Lock()
	s.sessions[token] = session{Username: body.Username, ExpiresAt: time.Now().Add(sessionLifetime)}
	s.mu.Unlock()

	s.setRefreshCookie(w, token, sessionLifetime)
	writeJSON(w, http.StatusOK, jsonResponse{
		"ok":                    true,
		"message":               "Login succeeded. The API issued a refresh cookie.",
		"username":              body.Username,
		"refreshCookieName":     refreshCookieName,
		"refreshCookiePath":     refreshCookiePath,
		"refreshCookieHttpOnly": true,
		"refreshCookieSecure":   s.cookieSecure,
		"refreshCookieSameSite": "Lax",
		"refreshCookieDomain":   "(omitted: host-only cookie)",
		"originReceivedByAPI":   r.Header.Get("Origin"),
		"nextStep":              "Click Check Cookie or Refresh Session. The browser should send the cookie to /api/auth/*.",
	})
}

func (s *server) handleCheck(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	username, ok := s.findSessionFromRequest(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, jsonResponse{
			"ok":                    false,
			"refreshCookieReceived": cookiePresent(r, refreshCookieName),
			"refreshCookieValid":    false,
			"message":               "No valid refresh session arrived. Log in first, then try again.",
		})
		return
	}

	writeJSON(w, http.StatusOK, jsonResponse{
		"ok":                    true,
		"refreshCookieReceived": true,
		"refreshCookieValid":    true,
		"username":              username,
		"message":               "Success: the Go API received and validated the HttpOnly cookie through the frontend path.",
	})
}

func (s *server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	oldToken, err := readCookie(r, refreshCookieName)
	if err != nil {
		s.clearRefreshCookie(w)
		writeJSON(w, http.StatusUnauthorized, jsonResponse{
			"ok":                    false,
			"refreshCookieReceived": false,
			"error":                 "refresh_cookie_missing",
			"message":               "The API did not receive a refresh_token cookie. Log in first.",
		})
		return
	}

	s.mu.Lock()
	current, exists := s.sessions[oldToken]
	if exists && time.Now().After(current.ExpiresAt) {
		delete(s.sessions, oldToken)
		exists = false
	}
	if !exists {
		s.mu.Unlock()
		s.clearRefreshCookie(w)
		writeJSON(w, http.StatusUnauthorized, jsonResponse{
			"ok":                    false,
			"refreshCookieReceived": true,
			"refreshCookieValid":    false,
			"error":                 "refresh_cookie_invalid",
			"message":               "A cookie was received, but it is not a valid session. Log in again.",
		})
		return
	}
	delete(s.sessions, oldToken) // rotate: the previous token cannot be reused
	newToken, tokenErr := randomToken()
	if tokenErr == nil {
		s.sessions[newToken] = session{Username: current.Username, ExpiresAt: time.Now().Add(sessionLifetime)}
	}
	s.mu.Unlock()

	if tokenErr != nil {
		writeJSON(w, http.StatusInternalServerError, jsonResponse{"error": "token_generation_failed"})
		return
	}

	s.setRefreshCookie(w, newToken, sessionLifetime)
	accessToken, err := randomToken()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, jsonResponse{"error": "token_generation_failed"})
		return
	}

	writeJSON(w, http.StatusOK, jsonResponse{
		"ok":                    true,
		"refreshCookieReceived": true,
		"refreshCookieValid":    true,
		"refreshTokenRotated":   true,
		"username":              current.Username,
		"accessToken":           accessToken,
		"accessTokenType":       "demo-only opaque string; not a production JWT",
		"message":               "Success: the old refresh token was accepted and rotated. A new HttpOnly cookie was issued.",
	})
}

func (s *server) handleLogout(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if token, err := readCookie(r, refreshCookieName); err == nil {
		s.mu.Lock()
		delete(s.sessions, token)
		s.mu.Unlock()
	}
	s.clearRefreshCookie(w)
	writeJSON(w, http.StatusOK, jsonResponse{
		"ok":      true,
		"message": "Logged out. The refresh cookie was cleared using the same path and cookie attributes.",
	})
}

func (s *server) findSessionFromRequest(r *http.Request) (string, bool) {
	token, err := readCookie(r, refreshCookieName)
	if err != nil {
		return "", false
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	current, exists := s.sessions[token]
	if !exists {
		return "", false
	}
	if time.Now().After(current.ExpiresAt) {
		delete(s.sessions, token)
		return "", false
	}
	return current.Username, true
}

func (s *server) setRefreshCookie(w http.ResponseWriter, token string, lifetime time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    token,
		Path:     refreshCookiePath,
		HttpOnly: true,
		Secure:   s.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		Expires:  time.Now().Add(lifetime),
		MaxAge:   int(lifetime.Seconds()),
	})
}

func (s *server) clearRefreshCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    "",
		Path:     refreshCookiePath,
		HttpOnly: true,
		Secure:   s.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
		Expires:  time.Unix(1, 0),
	})
}

func readCookie(r *http.Request, name string) (string, error) {
	cookie, err := r.Cookie(name)
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		return "", errors.New("missing cookie")
	}
	return cookie.Value, nil
}

// cookiePresent reports whether a named cookie arrived, without exposing its value.
func cookiePresent(r *http.Request, name string) bool {
	_, err := r.Cookie(name)
	return err == nil
}

func randomToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func writeJSON(w http.ResponseWriter, status int, body jsonResponse) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("write JSON response: %v", err)
	}
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s origin=%q cookie_present=%t", r.Method, r.URL.Path, r.Header.Get("Origin"), cookiePresent(r, refreshCookieName))
		next.ServeHTTP(w, r)
	})
}
