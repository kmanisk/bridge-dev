package transport

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kmanisk/bridge-dev/internal/auth"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/events"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"github.com/kmanisk/bridge-dev/internal/tasks"
)

func auditTail(state string, n int) []json.RawMessage {
	f, e := os.Open(filepath.Join(state, "audit", "audit.jsonl"))
	if e != nil {
		return nil
	}
	defer f.Close()
	out := []json.RawMessage{}
	s := bufio.NewScanner(io.LimitReader(f, 5<<20))
	s.Buffer(make([]byte, 4096), 128<<10)
	for s.Scan() {
		if json.Valid(s.Bytes()) {
			out = append(out, append(json.RawMessage(nil), s.Bytes()...))
			if len(out) > n {
				out = out[1:]
			}
		}
	}
	return out
}
func runtimeRecord(c config.Config) (Runtime, error) {
	var rt Runtime
	partial := false
	for _, file := range []string{"http.json", "server.json"} {
		e := platform.ReadJSON(filepath.Join(c.StateDir, file), &rt)
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			partial = true
			continue
		}
		id, e := platform.ProcessIdentity(rt.PID)
		if e != nil || id != rt.Identity {
			continue
		}
		u, e := url.Parse(rt.URL)
		if e != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Path != "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			partial = true
			continue
		}
		return rt, nil
	}
	lock := filepath.Join(c.StateDir, "http.lock")
	if _, e := os.Stat(lock); e == nil {
		unlock, e := platform.TryLock(lock)
		if e != nil {
			partial = true
		} else {
			unlock()
		}
	}
	if partial {
		return Runtime{State: "partial"}, nil
	}
	return Runtime{State: "stopped"}, nil
}

func admin(ctx context.Context, c config.Config, rt Runtime, path, method string) (*http.Response, error) {
	token, e := os.ReadFile(filepath.Join(c.StateDir, "token"))
	if e != nil {
		return nil, e
	}
	req, e := http.NewRequestWithContext(ctx, method, rt.URL+path, nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return client.Do(req)
}
func Status(c config.Config) (Runtime, error) {
	rt, e := runtimeRecord(c)
	if e != nil {
		return rt, e
	}
	if rt.State == "partial" {
		return rt, nil
	}
	if rt.State == "stopped" {
		rt.Mode = string(c.Mode)
		rt.Audit = auditTail(c.StateDir, 10)
		clients, _ := auth.ListClients(c.StateDir)
		for _, v := range clients {
			rt.Clients = append(rt.Clients, events.Client{ID: v.ID, Name: v.Name, LastSeen: v.LastActivity, Status: "persisted registration; current authorization/connection unknown"})
		}
		tm := tasks.Manager{Dir: filepath.Join(c.StateDir, "tasks"), Config: c}
		list, _ := tm.List()
		for _, v := range list {
			if v.State == "running" || v.State == "starting" {
				rt.RunningTasks++
			}
		}
		return rt, nil
	}
	resp, e := admin(context.Background(), c, rt, "/_status", "GET")
	if e != nil {
		rt.State = "partial"
		rt.PublicURL = ""
		return rt, nil
	}
	defer resp.Body.Close()
	var live Runtime
	if resp.StatusCode != 200 || json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&live) != nil || live.PID != rt.PID || live.Identity != rt.Identity {
		rt.State = "partial"
		rt.PublicURL = ""
		return rt, nil
	}
	return live, nil
}
func Down(ctx context.Context, c config.Config) error {
	rt, e := Status(c)
	if e != nil {
		return e
	}
	if rt.State == "stopped" {
		return nil
	}
	if rt.State == "partial" {
		return errors.New("partial runtime state: no verified HTTP administration endpoint; no process was signalled")
	}
	resp, e := admin(ctx, c, rt, "/_shutdown", "POST")
	if e != nil {
		return e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 202 {
		return fmt.Errorf("shutdown refused: %d", resp.StatusCode)
	}
	return nil
}
func Watch(ctx context.Context, c config.Config, out io.Writer) error {
	offset := int64(0)
	var previous os.FileInfo
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		p := filepath.Join(c.StateDir, "audit", "audit.jsonl")
		f, e := os.Open(p)
		if e == nil {
			st, se := f.Stat()
			if se == nil {
				if previous != nil && (!os.SameFile(previous, st) || st.Size() < offset) {
					offset = 0
				}
				previous = st
				_, _ = f.Seek(offset, io.SeekStart)
				b, _ := io.ReadAll(io.LimitReader(f, 1<<20))
				if i := strings.LastIndexByte(string(b), '\n'); i >= 0 {
					for _, line := range strings.Split(string(b[:i]), "\n") {
						fmt.Fprintln(out, prompt.Safe(line))
					}
					offset += int64(i + 1)
				}
			}
			f.Close()
		} else if !os.IsNotExist(e) {
			return e
		}
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
		}
	}
}
