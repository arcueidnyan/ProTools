package main

import (
	"crypto/rand"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
)

//go:embed public starter.json font-licenses
var assets embed.FS

const address = "127.0.0.1:8080"
const url = "http://" + address
const maxBody = 8 * 1024 * 1024

type item struct {
	ID    string  `json:"id"`
	Kind  string  `json:"kind"`
	Text  string  `json:"text"`
	Font  string  `json:"font"`
	Color string  `json:"color"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	W     float64 `json:"w"`
	H     float64 `json:"h"`
	Size  float64 `json:"size"`
}

type boardInfo struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Updated int64  `json:"updated"`
}

type board struct {
	boardInfo
	Items    []item `json:"items"`
	Revision int64  `json:"revision"`
}

type store struct {
	mu     sync.Mutex
	path   string
	boards map[string]board
}

func newBoard(title string, items []item) board {
	return board{boardInfo: boardInfo{ID: rand.Text(), Title: title, Updated: time.Now().UnixMilli()}, Items: items}
}

func loadStore(path string) (*store, error) {
	s := &store{path: path, boards: make(map[string]board)}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		data, err = assets.ReadFile("starter.json")
		if err != nil {
			return nil, err
		}
		var items []item
		if err := json.Unmarshal(data, &items); err != nil {
			return nil, err
		}
		demo := newBoard("Первые идеи", items)
		s.boards[demo.ID] = demo
		return s, s.save()
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(data, &s.boards); err != nil {
		return nil, err
	}
	if s.boards == nil {
		return nil, errors.New("файл досок содержит некорректные данные")
	}
	return s, nil
}

func (s *store) save() error {
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".boards-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err = json.NewEncoder(tmp).Encode(s.boards); err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(tmp.Name(), s.path)
}

func send(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Print(err)
	}
}

func fail(w http.ResponseWriter, status int, message string) {
	send(w, status, map[string]string{"error": message})
}

func readJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	media, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if media != "application/json" {
		fail(w, 415, "Ожидается JSON")
		return false
	}
	reader := http.MaxBytesReader(w, r.Body, maxBody)
	decoder := json.NewDecoder(reader)
	err := decoder.Decode(value)
	if err == nil && decoder.Decode(new(any)) == io.EOF {
		return true
	}
	fail(w, 400, "Некорректный или слишком большой JSON")
	return false
}

func length(text string) int { return len(utf16.Encode([]rune(text))) }

func validBoard(value board) bool {
	if strings.TrimSpace(value.Title) == "" || length(value.Title) > 120 || value.Items == nil {
		return false
	}
	seen := make(map[string]bool)
	for _, v := range value.Items {
		if v.ID == "" || length(v.ID) > 64 || seen[v.ID] || length(v.Text) > 4000 ||
			!slices.Contains([]string{"note", "text", "rect", "ellipse"}, v.Kind) ||
			!slices.Contains([]string{"Manrope", "Golos Text", "PT Serif", "Comfortaa", "IBM Plex Mono"}, v.Font) ||
			!slices.Contains([]string{"violet", "green", "peach", "blue", "white"}, v.Color) ||
			v.X < -1e7 || v.X > 1e7 || v.Y < -1e7 || v.Y > 1e7 ||
			v.W < 28 || v.W > 5000 || v.H < 28 || v.H > 5000 || v.Size < 12 || v.Size > 120 {
			return false
		}
		seen[v.ID] = true
	}
	return true
}

func (s *store) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/boards", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		result := make([]boardInfo, 0, len(s.boards))
		for _, b := range s.boards {
			result = append(result, b.boardInfo)
		}
		slices.SortFunc(result, func(a, b boardInfo) int {
			if a.Updated > b.Updated {
				return -1
			}
			if a.Updated < b.Updated {
				return 1
			}
			return strings.Compare(a.ID, b.ID)
		})
		send(w, 200, result)
	})
	mux.HandleFunc("POST /api/boards", func(w http.ResponseWriter, r *http.Request) {
		if !readJSON(w, r, new(any)) {
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		b := newBoard("Без названия", []item{})
		s.boards[b.ID] = b
		if err := s.save(); err != nil {
			delete(s.boards, b.ID)
			saveError(w, err)
			return
		}
		send(w, 201, b)
	})
	mux.HandleFunc("GET /api/boards/{id}", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		b, ok := s.boards[r.PathValue("id")]
		if !ok {
			fail(w, 404, "Доска не найдена")
			return
		}
		send(w, 200, b)
	})
	mux.HandleFunc("PUT /api/boards/{id}", func(w http.ResponseWriter, r *http.Request) {
		var b board
		if !readJSON(w, r, &b) {
			return
		}
		if !validBoard(b) {
			fail(w, 400, "Некорректные данные доски")
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		id := r.PathValue("id")
		old, ok := s.boards[id]
		if !ok || old.Revision != b.Revision {
			fail(w, 409, "Доска изменилась в другой вкладке")
			return
		}
		b.ID = id
		b.Revision++
		b.Updated = time.Now().UnixMilli()
		s.boards[id] = b
		if err := s.save(); err != nil {
			s.boards[id] = old
			saveError(w, err)
			return
		}
		send(w, 200, map[string]int64{"revision": b.Revision, "updated": b.Updated})
	})
	mux.HandleFunc("DELETE /api/boards/{id}", func(w http.ResponseWriter, r *http.Request) {
		revision, err := strconv.ParseInt(r.Header.Get("If-Match"), 10, 64)
		if err != nil || revision < 0 {
			fail(w, 400, "Укажите версию доски")
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		id := r.PathValue("id")
		old, ok := s.boards[id]
		if !ok || revision != old.Revision {
			fail(w, 409, "Доска изменилась в другой вкладке")
			return
		}
		delete(s.boards, id)
		if err := s.save(); err != nil {
			s.boards[id] = old
			saveError(w, err)
			return
		}
		send(w, 200, map[string]bool{"deleted": true})
	})
	public, _ := fs.Sub(assets, "public")
	mux.Handle("GET /", http.FileServer(http.FS(public)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != address && r.Host != "localhost:8080" {
			fail(w, 403, "Демо доступно только через localhost")
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
		mux.ServeHTTP(w, r)
	})
}

func saveError(w http.ResponseWriter, err error) {
	log.Print(err)
	fail(w, 500, "Не удалось сохранить доски")
}

func run() error {
	listener, err := net.Listen("tcp4", address)
	if err != nil {
		return fmt.Errorf("не удалось открыть порт 8080, проверьте, свободен ли он: %w", err)
	}
	defer listener.Close()
	base, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	path := filepath.Join(base, "PoleDemo")
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	s, err := loadStore(filepath.Join(path, "boards.json"))
	if err != nil {
		return err
	}
	server := &http.Server{Handler: s.handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	fmt.Println("Поле: " + url)
	fmt.Println("Чтобы остановить демо, закройте это окно или нажмите Ctrl+C.")
	if runtime.GOOS == "windows" {
		if err := exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url).Start(); err != nil {
			log.Printf("Откройте %s вручную: %v", url, err)
		}
	}
	return server.Serve(listener)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Поле:", err)
		if runtime.GOOS == "windows" {
			fmt.Println("Нажмите Enter, чтобы закрыть окно.")
			fmt.Scanln()
		}
		os.Exit(1)
	}
}
