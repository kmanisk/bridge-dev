// Package clientinstall registers stdio using native client commands and receipts.
package clientinstall

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/kmanisk/bridge-dev/internal/auth"
	"github.com/kmanisk/bridge-dev/internal/config"
	"github.com/kmanisk/bridge-dev/internal/identity"
	"github.com/kmanisk/bridge-dev/internal/platform"
	"github.com/kmanisk/bridge-dev/internal/prompt"
	"github.com/pelletier/go-toml/v2"
)

type Entry struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
}
type receipt struct {
	Client string `json:"client"`
	Config string `json:"config"`
	Digest string `json:"digest"`
}

func digest(v any) string { b, _ := json.Marshal(v); return auth.Hash(string(b)) }
func command(client, action string) []string {
	if client == "codex" {
		verb := "add"
		if action == "remove" {
			verb = "remove"
		}
		return []string{"codex", "mcp", verb, identity.Binary}
	}
	verb := "add"
	if action == "remove" {
		verb = "remove"
	}
	argv := []string{"claude", "mcp", verb, "--scope", "user"}
	if action != "remove" {
		argv = append(argv, "--transport", "stdio")
	}
	return append(argv, identity.Binary)
}
func configPath(client string) (string, error) {
	home, e := os.UserHomeDir()
	if e != nil {
		return "", e
	}
	if client == "codex" {
		base := os.Getenv("CODEX_HOME")
		if base == "" {
			base = filepath.Join(home, ".codex")
		}
		return filepath.Join(base, "config.toml"), nil
	}
	if os.Getenv("CLAUDE_CONFIG_DIR") != "" {
		return "", errors.New("custom CLAUDE_CONFIG_DIR location has not been verified; use --print and the native Claude command")
	}
	return filepath.Join(home, ".claude.json"), nil
}
func readEntry(client, path string) (map[string]any, error) {
	b, e := os.ReadFile(path)
	if os.IsNotExist(e) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var doc map[string]any
	if client == "codex" {
		e = toml.Unmarshal(b, &doc)
	} else {
		e = json.Unmarshal(b, &doc)
	}
	if e != nil {
		return nil, errors.New("cannot parse existing client configuration; refusing changes")
	}
	key := "mcpServers"
	if client == "codex" {
		key = "mcp_servers"
	}
	raw, exists := doc[key]
	if !exists {
		return nil, nil
	}
	servers, ok := raw.(map[string]any)
	if !ok {
		return nil, errors.New("invalid MCP configuration map")
	}
	raw, exists = servers[identity.Binary]
	if !exists {
		return nil, nil
	}
	entry, ok := raw.(map[string]any)
	if !ok {
		return nil, errors.New("invalid existing Bridge registration")
	}
	return entry, nil
}
func matches(v map[string]any, want Entry) bool {
	b, _ := json.Marshal(v)
	var got Entry
	if json.Unmarshal(b, &got) != nil {
		return false
	}
	return got.Command == want.Command && digest(got.Args) == digest(want.Args)
}
func Run(ctx context.Context, c config.Config, client string, remove bool, p *prompt.Coordinator, out io.Writer) error {
	if client != "codex" && client != "claude-code" && client != "claude-desktop" {
		return errors.New("client must be codex, claude-code or claude-desktop")
	}
	binary, e := os.Executable()
	if e != nil {
		return e
	}
	binary, e = filepath.Abs(binary)
	if e != nil {
		return e
	}
	snapshot := filepath.Join(c.StateDir, "install", client+".toml")
	entry := Entry{binary, []string{"stdio", "--config", snapshot, "--roots", strings.Join(c.Roots, ","), "--mode", string(c.Mode)}}
	if c.Print || client == "claude-desktop" {
		entry.Args = []string{"stdio", "--roots", strings.Join(c.Roots, ","), "--mode", string(c.Mode), "--approve", c.Approve, "--allow-commands", strings.Join(c.Allow, ","), "--deny-commands", strings.Join(c.Deny, ","), "--sudo-commands", strings.Join(c.SudoAllow, ",")}
		if c.ConfigExists && c.ConfigFile != "" {
			entry.Args = append(entry.Args, "--config", c.ConfigFile)
		}
	}
	if client == "claude-desktop" {
		if remove {
			fmt.Fprintln(out, "Claude Desktop uses manual registration. Remove only the Bridge entry you added in Settings / Developer / Edit Config; preserve other mcpServers entries.")
			return nil
		}
		// Desktop platform locations vary. Generate the documented snippet without
		// guessing an unofficial Linux configuration path or modifying live files.
		fmt.Fprintln(out, "Claude Desktop: Settings / Developer / Edit Config. Merge this mcpServers entry; do not replace unrelated registrations. Privileged preferences still require current startup authorization.")
		return json.NewEncoder(out).Encode(map[string]any{"mcpServers": map[string]Entry{identity.Binary: entry}})
	}
	action := "add"
	if remove {
		action = "remove"
	}
	argv := command(client, action)
	if !remove {
		argv = append(argv, "--", entry.Command)
		argv = append(argv, entry.Args...)
	}
	fmt.Fprintf(out, "Proposed argv: %q\n", argv)
	if c.Print {
		return nil
	}
	path, e := configPath(client)
	if e != nil {
		return e
	}
	if !filepath.IsAbs(path) {
		return errors.New("client configuration location must be absolute")
	}
	executable, e := exec.LookPath(argv[0])
	if e != nil {
		return e
	}
	argv[0] = executable
	if e = platform.PrivateDir(filepath.Dir(snapshot)); e != nil {
		return e
	}
	unlock, e := platform.Lock(filepath.Join(c.StateDir, "install", "registrations.lock"))
	if e != nil {
		return e
	}
	defer unlock()
	current, e := readEntry(client, path)
	if e != nil {
		return e
	}
	receiptPath := filepath.Join(c.StateDir, "install", client+".json")
	var saved receipt
	receiptErr := platform.ReadJSON(receiptPath, &saved)
	if remove {
		if receiptErr != nil {
			return errors.New("no Bridge-owned installation receipt; refusing removal")
		}
		if current == nil {
			return errors.New("bridge registration already absent; receipt retained for review")
		}
		if saved.Client != client || saved.Config != path || saved.Digest != digest(current) {
			return errors.New("registration changed since install; refusing to remove it")
		}
	} else if current != nil {
		if receiptErr == nil && saved.Client == client && saved.Config == path && saved.Digest == digest(current) && matches(current, entry) {
			fmt.Fprintln(out, "Bridge-owned registration already installed.")
			return nil
		}
		return errors.New("an existing registration uses this name; refusing overwrite")
	}
	if !p.Available() {
		return prompt.ErrUnavailable
	}
	check, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	if !p.Confirm(check, "Apply the displayed client registration change?") {
		return prompt.ErrDenied
	}
	again, e := readEntry(client, path)
	if e != nil {
		return e
	}
	if digest(again) != digest(current) {
		return errors.New("client configuration changed during confirmation; retry after reviewing")
	}
	if !remove {
		copy := c
		copy.ConfigFile = snapshot
		if e = config.Save(copy); e != nil {
			return e
		}
	}
	// Native commands preserve unrelated registrations and client format details.
	cmd := exec.CommandContext(check, argv[0], argv[1:]...)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if e = cmd.Run(); e != nil {
		return errors.New("native client registration command failed; inspect its configuration before retrying")
	}
	after, e := readEntry(client, path)
	if e != nil {
		return e
	}
	if remove {
		if after != nil {
			return errors.New("native client did not remove registration")
		}
		if e = os.Remove(receiptPath); e != nil {
			return e
		}
		_ = os.Remove(snapshot)
		fmt.Fprintln(out, "Removed verified Bridge-owned registration.")
		return nil
	}
	if !matches(after, entry) {
		return errors.New("native client result did not match proposed registration; no ownership receipt created")
	}
	if e = platform.AtomicJSON(receiptPath, receipt{client, path, digest(after)}); e != nil {
		return e
	}
	fmt.Fprintln(out, "Registered Bridge stdio. Restart or reconnect the client to verify tools.")
	return nil
}
