package events

import (
	"fmt"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"io"
	"sort"
	"strconv"
	"sync"
	"time"
)

type Client struct {
	ID            string    `json:"id"`
	Name          string    `json:"self_reported_name,omitempty"`
	Authenticated bool      `json:"authenticated"`
	LastSeen      time.Time `json:"last_seen"`
	Status        string    `json:"status"`
}
type Hub struct {
	mu      sync.Mutex
	out     io.Writer
	mode    string
	clients map[string]Client
	first   map[string]bool
}

func New(mode string, out io.Writer) *Hub {
	return &Hub{mode: mode, out: out, clients: map[string]Client{}, first: map[string]bool{}}
}
func (h *Hub) Emit(text string) { h.mu.Lock(); defer h.mu.Unlock(); h.emit(text) }
func (h *Hub) emit(text string) {
	if h.out != nil {
		fmt.Fprintf(h.out, "[%s] mode=%s %s\n", time.Now().Format("15:04:05"), h.mode, prompt.Safe(text))
	}
}
func (h *Hub) Seen(id, name string, authenticated bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	prior, known := h.clients[id]
	if name == "" {
		name = prior.Name
	}
	c := Client{ID: id, Name: name, Authenticated: authenticated, LastSeen: time.Now().UTC(), Status: "last seen; continuous connection unknown"}
	h.clients[id] = c
	if !known && authenticated {
		h.emit("Authenticated client " + id)
		if name != "" {
			h.emit("Self-reported name: " + strconv.Quote(name))
		}
	}
}
func (h *Hub) Tool(id, name string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.first[id] {
		h.emit("First tool call by " + id + ": " + name)
		h.first[id] = true
	}
}
func (h *Hub) Clients() []Client {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := []Client{}
	for _, c := range h.clients {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
func (h *Hub) SetMode(mode string) { h.mu.Lock(); defer h.mu.Unlock(); h.mode = mode }

type Writer struct {
	mu  sync.Mutex
	Out io.Writer
}

func (w *Writer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.Out.Write(p)
}
