package config

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/kmanisk/bridge-dev/internal/identity"
	"github.com/kmanisk/bridge-dev/internal/policy"
	"github.com/pelletier/go-toml/v2"
)

type Config struct {
	OAuthClients         int         `toml:"oauth_clients"`
	OAuthTokens          int         `toml:"oauth_tokens"`
	OAuthPending         int         `toml:"oauth_pending"`
	ApprovalPending      int         `toml:"approval_pending"`
	SearchDepth          int         `toml:"search_depth"`
	ExecMaxTimeout       string      `toml:"exec_max_timeout"`
	PreviousMode         policy.Mode `toml:"-"`
	GrantUntil           time.Time   `toml:"-"`
	Headless             bool        `toml:"-"`
	Schema               int         `toml:"schema_version"`
	Approve              string      `toml:"approve"`
	Auth                 string      `toml:"auth"`
	AckPrivileged        bool        `toml:"ack_privileged"`
	SudoFor              string      `toml:"sudo_for"`
	Shell                bool        `toml:"shell"`
	RedirectHosts        []string    `toml:"redirect_hosts"`
	TunnelArgv           []string    `toml:"tunnel_argv"`
	TunnelName           string      `toml:"tunnel_name"`
	PublicOrigin         string      `toml:"public_origin"`
	ReadBytes            int64       `toml:"read_bytes"`
	WriteBytes           int64       `toml:"write_bytes"`
	OutputBytes          int         `toml:"output_bytes"`
	TaskLogBytes         int         `toml:"task_log_bytes"`
	SearchResults        int         `toml:"search_results"`
	SearchVisited        int         `toml:"search_visited"`
	HTTPBodyBytes        int64       `toml:"http_body_bytes"`
	HTTPConcurrency      int         `toml:"http_concurrency"`
	ExecTimeout          string      `toml:"exec_timeout"`
	ConfigExists         bool        `toml:"-"`
	Reconfigure          bool        `toml:"-"`
	Detach               bool        `toml:"-"`
	Print                bool        `toml:"-"`
	PrivilegedAuthorized bool        `toml:"-"`

	Mode       policy.Mode `toml:"mode"`
	Roots      []string    `toml:"roots"`
	Port       int         `toml:"port"`
	Idle       string      `toml:"idle_timeout"`
	Tunnel     string      `toml:"tunnel"`
	StateDir   string      `toml:"state_dir"`
	Allow      []string    `toml:"allow_commands"`
	Deny       []string    `toml:"deny_commands"`
	SudoAllow  []string    `toml:"sudo_commands"`
	Env        []string    `toml:"env_allow"`
	OAuth      bool        `toml:"oauth"`
	Issuer     string      `toml:"issuer"`
	Probe      bool        `toml:"probe"`
	AckDanger  bool        `toml:"ack_dangerous"`
	Backend    string      `toml:"task_backend"`
	ConfigFile string      `toml:"-"`
}

func Defaults() Config {
	home, _ := os.UserHomeDir()
	cwd, _ := os.Getwd()
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		base = filepath.Join(home, ".local", "state")
	}
	return Config{OAuthClients: 1024, OAuthTokens: 16384, OAuthPending: 64, ApprovalPending: 64, SearchDepth: 32, ExecMaxTimeout: "10m", Schema: 2, Approve: "none", Auth: "oauth", RedirectHosts: []string{"claude.ai", "chatgpt.com", "openai.com"}, ReadBytes: 1 << 20, WriteBytes: 1 << 20, OutputBytes: 1 << 20, TaskLogBytes: 16 << 20, SearchResults: 200, SearchVisited: 10000, HTTPBodyBytes: 2 << 20, HTTPConcurrency: 16, ExecTimeout: "30s", Mode: policy.Readonly, Roots: []string{cwd}, Port: 8765, Idle: "30m", Tunnel: "none", StateDir: filepath.Join(base, identity.Binary), Env: []string{"LANG", "LC_ALL", "TZ"}, Backend: "auto"}
}
func DefaultPath() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		h, _ := os.UserHomeDir()
		base = filepath.Join(h, ".config")
	}
	return filepath.Join(base, identity.Binary, "config.toml")
}
func Load(args []string, getenv func(string) string) (Config, error) {
	return load(args, getenv, Defaults(), false)
}
func LoadConnect(args []string, getenv func(string) string) (Config, error) {
	c := Defaults()
	c.OAuth = true
	c.Tunnel = "cloudflared"
	return load(args, getenv, c, true)
}
func load(args []string, getenv func(string) string, c Config, allowMissing bool) (Config, error) {
	path := DefaultPath()
	explicit := false
	if v := getenv(identity.EnvPrefix + "CONFIG"); v != "" {
		path = v
		explicit = true
	}
	for i, a := range args {
		if a == "--config" && i+1 < len(args) {
			path = args[i+1]
			explicit = true
		}
		if strings.HasPrefix(a, "--config=") {
			path = strings.TrimPrefix(a, "--config=")
			explicit = true
		}
	}
	data, err := os.ReadFile(path)
	if err == nil {
		c.Schema = 1
		c.ConfigExists = true
		if e := toml.NewDecoder(bytes.NewReader(data)).DisallowUnknownFields().Decode(&c); e != nil {
			return c, e
		}
	} else if explicit && !allowMissing || !errors.Is(err, os.ErrNotExist) {
		return c, err
	}
	if allowMissing {
		c.OAuth = true
	}
	c.PreviousMode = policy.Readonly
	if !c.Mode.Privileged() {
		c.PreviousMode = c.Mode
	}
	fs := flag.NewFlagSet(identity.Binary, flag.ContinueOnError)
	fs.StringVar(&c.ConfigFile, "config", path, "configuration file")
	mode := string(c.Mode)
	roots := strings.Join(c.Roots, ",")
	allow := strings.Join(c.Allow, ",")
	deny := strings.Join(c.Deny, ",")
	sudo := strings.Join(c.SudoAllow, ",")
	redirectHosts := strings.Join(c.RedirectHosts, ",")
	for _, e := range []struct {
		k string
		p *string
	}{{"REDIRECT_HOSTS", &redirectHosts}, {"MODE", &mode}, {"ROOTS", &roots}, {"ALLOW_COMMANDS", &allow}, {"DENY_COMMANDS", &deny}, {"SUDO_COMMANDS", &sudo}, {"IDLE_TIMEOUT", &c.Idle}, {"TUNNEL", &c.Tunnel}, {"STATE_DIR", &c.StateDir}, {"ISSUER", &c.Issuer}, {"TASK_BACKEND", &c.Backend}, {"APPROVE", &c.Approve}, {"AUTH", &c.Auth}, {"SUDO_FOR", &c.SudoFor}, {"PUBLIC_ORIGIN", &c.PublicOrigin}, {"EXEC_TIMEOUT", &c.ExecTimeout}, {"EXEC_MAX_TIMEOUT", &c.ExecMaxTimeout}} {
		if v := getenv(identity.EnvPrefix + e.k); v != "" {
			*e.p = v
		}
	}
	for _, item := range []struct {
		name string
		dst  *int64
	}{{"READ_BYTES", &c.ReadBytes}, {"WRITE_BYTES", &c.WriteBytes}, {"HTTP_BODY_BYTES", &c.HTTPBodyBytes}} {
		if v := getenv(identity.EnvPrefix + item.name); v != "" {
			n, e := strconv.ParseInt(v, 10, 64)
			if e != nil {
				return c, e
			}
			*item.dst = n
		}
	}
	for _, item := range []struct {
		name string
		dst  *int
	}{{"OUTPUT_BYTES", &c.OutputBytes}, {"TASK_LOG_BYTES", &c.TaskLogBytes}, {"SEARCH_RESULTS", &c.SearchResults}, {"SEARCH_VISITED", &c.SearchVisited}, {"SEARCH_DEPTH", &c.SearchDepth}, {"HTTP_CONCURRENCY", &c.HTTPConcurrency}, {"OAUTH_CLIENTS", &c.OAuthClients}, {"OAUTH_TOKENS", &c.OAuthTokens}, {"OAUTH_PENDING", &c.OAuthPending}, {"APPROVAL_PENDING", &c.ApprovalPending}} {
		if v := getenv(identity.EnvPrefix + item.name); v != "" {
			n, e := strconv.Atoi(v)
			if e != nil {
				return c, e
			}
			*item.dst = n
		}
	}

	if v := getenv(identity.EnvPrefix + "PORT"); v != "" {
		n, e := strconv.Atoi(v)
		if e != nil {
			return c, e
		}
		c.Port = n
	}
	for _, e := range []struct {
		k string
		p *bool
	}{{"OAUTH", &c.OAuth}, {"PROBE", &c.Probe}, {"ACK_DANGEROUS", &c.AckDanger}, {"SHELL", &c.Shell}} {
		if v := getenv(identity.EnvPrefix + e.k); v != "" {
			switch v {
			case "true":
				*e.p = true
			case "false":
				*e.p = false
			default:
				return c, fmt.Errorf("invalid boolean %s", e.k)
			}
		}
	}
	fs.StringVar(&redirectHosts, "redirect-hosts", redirectHosts, "exact OAuth callback hosts")
	fs.StringVar(&c.Approve, "approve", c.Approve, "none, sudo, write, all")
	fs.StringVar(&c.Auth, "auth", c.Auth, "oauth or code consent")
	fs.StringVar(&c.SudoFor, "sudo-for", c.SudoFor, "temporary privilege duration")
	fs.StringVar(&c.PublicOrigin, "public-origin", c.PublicOrigin, "explicit custom/named HTTPS origin")
	fs.BoolVar(&c.Shell, "shell", c.Shell, "enable explicit dangerous shell tool")
	fs.BoolVar(&c.Reconfigure, "reconfigure", false, "repeat configuration wizard")
	fs.BoolVar(&c.Headless, "headless", false, "noninteractive transient worker")
	fs.BoolVar(&c.Detach, "detach", false, "transient background HTTP host")
	fs.BoolVar(&c.Print, "print", false, "preview client changes only")
	fs.Int64Var(&c.ReadBytes, "read-bytes", c.ReadBytes, "read byte bound")
	fs.Int64Var(&c.WriteBytes, "write-bytes", c.WriteBytes, "write byte bound")
	fs.IntVar(&c.OutputBytes, "output-bytes", c.OutputBytes, "command output bound")
	fs.IntVar(&c.TaskLogBytes, "task-log-bytes", c.TaskLogBytes, "per-task log bound")
	fs.IntVar(&c.SearchResults, "search-results", c.SearchResults, "search result bound")
	fs.IntVar(&c.OAuthClients, "oauth-clients", c.OAuthClients, "concurrent stored client bound")
	fs.IntVar(&c.OAuthTokens, "oauth-tokens", c.OAuthTokens, "live token record bound")
	fs.IntVar(&c.OAuthPending, "oauth-pending", c.OAuthPending, "concurrent consent queue bound")
	fs.IntVar(&c.ApprovalPending, "approval-pending", c.ApprovalPending, "concurrent operation queue bound")
	fs.IntVar(&c.SearchDepth, "search-depth", c.SearchDepth, "search directory depth bound")
	fs.StringVar(&c.ExecMaxTimeout, "exec-max-timeout", c.ExecMaxTimeout, "maximum command timeout; zero dangerous-only")
	fs.IntVar(&c.SearchVisited, "search-visited", c.SearchVisited, "search traversal bound")
	fs.Int64Var(&c.HTTPBodyBytes, "http-body-bytes", c.HTTPBodyBytes, "HTTP request bound")
	fs.IntVar(&c.HTTPConcurrency, "http-concurrency", c.HTTPConcurrency, "HTTP concurrent handlers")
	fs.StringVar(&c.ExecTimeout, "exec-timeout", c.ExecTimeout, "default execution deadline")
	fs.StringVar(&mode, "mode", mode, "permission mode")
	fs.StringVar(&roots, "roots", roots, "comma-separated allowed roots")
	fs.StringVar(&allow, "allow-commands", allow, "absolute executable paths")
	fs.StringVar(&deny, "deny-commands", deny, "denied executable paths")
	fs.StringVar(&sudo, "sudo-commands", sudo, "privileged executable paths")
	fs.StringVar(&c.StateDir, "state-dir", c.StateDir, "private state directory")
	fs.IntVar(&c.Port, "port", c.Port, "loopback port; zero selects a free port")
	fs.StringVar(&c.Idle, "idle-timeout", c.Idle, "inactivity timeout")
	fs.StringVar(&c.Tunnel, "tunnel", c.Tunnel, "none or cloudflared")
	fs.StringVar(&c.Issuer, "issuer", c.Issuer, "explicit OAuth HTTPS issuer")
	fs.StringVar(&c.Backend, "task-backend", c.Backend, "auto, systemd, detached")
	fs.BoolVar(&c.OAuth, "oauth", c.OAuth, "enable OAuth authorization server")
	fs.BoolVar(&c.Probe, "probe", c.Probe, "minimal ChatGPT compatibility probe")
	fs.BoolVar(&c.AckDanger, "ack-dangerous", c.AckDanger, "acknowledge unrestricted local access")
	if err := fs.Parse(args); err != nil {
		return c, err
	}
	if fs.NArg() != 0 {
		return c, errors.New("unexpected positional arguments")
	}
	split := func(s string) []string {
		if s == "" {
			return nil
		}
		return strings.Split(s, ",")
	}
	c.Mode = policy.Mode(mode)
	c.Roots = split(roots)
	c.Allow = split(allow)
	c.Deny = split(deny)
	c.SudoAllow = split(sudo)
	c.RedirectHosts = split(redirectHosts)
	for i, p := range c.Roots {
		v, e := filepath.Abs(p)
		if e != nil {
			return c, e
		}
		c.Roots[i] = v
	}
	return c, c.Validate(false)
}
func (c Config) Validate(remote bool) error {
	if c.Schema != 1 && c.Schema != 2 {
		return errors.New("unsupported configuration schema")
	}
	if c.Approve != "none" && c.Approve != "sudo" && c.Approve != "write" && c.Approve != "all" {
		return errors.New("invalid approval policy")
	}
	if c.Auth != "oauth" && c.Auth != "code" {
		return errors.New("invalid consent authentication mode")
	}
	if c.SudoFor != "" {
		d, e := time.ParseDuration(c.SudoFor)
		if e != nil || d <= 0 {
			return errors.New("invalid sudo-for duration")
		}
	}
	for _, v := range []int64{c.ReadBytes, c.WriteBytes, int64(c.OutputBytes), int64(c.TaskLogBytes), int64(c.SearchResults), int64(c.SearchVisited), int64(c.SearchDepth), int64(c.OAuthClients), int64(c.OAuthTokens), int64(c.OAuthPending), int64(c.ApprovalPending), c.HTTPBodyBytes} {
		if v < 0 || v == 0 && c.Mode != policy.Dangerous {
			return errors.New("technical bounds must be positive; explicit zero is dangerous-only")
		}
	}
	if c.HTTPConcurrency <= 0 {
		return errors.New("HTTP concurrency must be positive")
	}
	if d, e := time.ParseDuration(c.ExecMaxTimeout); e != nil || d < 0 || d == 0 && c.Mode != policy.Dangerous {
		return errors.New("invalid maximum execution timeout")
	}
	if d, e := time.ParseDuration(c.ExecTimeout); e != nil || d < 0 || d == 0 && c.Mode != policy.Dangerous {
		return errors.New("invalid execution timeout")
	}

	if remote && c.Mode.Privileged() && !c.OAuth {
		return errors.New("remote privileged modes require OAuth")
	}
	if e := c.Mode.Validate(remote); e != nil {
		return e
	}
	if len(c.Roots) == 0 && c.Mode != policy.Dangerous {
		return errors.New("at least one root required")
	}
	if c.Port < 0 || c.Port > 65535 {
		return errors.New("invalid port")
	}
	d, e := time.ParseDuration(c.Idle)
	if e != nil || d <= 0 {
		return errors.New("idle_timeout must be positive")
	}
	if c.Tunnel != "none" && c.Tunnel != "cloudflared" && !strings.HasPrefix(c.Tunnel, "custom:") {
		return errors.New("invalid tunnel")
	}
	if c.Tunnel != "none" && !c.OAuth {
		return errors.New("remote tunnels require OAuth; bearer-only is local development")
	}
	if c.Backend != "auto" && c.Backend != "systemd" && c.Backend != "detached" {
		return errors.New("invalid task backend")
	}
	if !filepath.IsAbs(c.StateDir) {
		return errors.New("state_dir must be absolute")
	}
	for _, s := range append(append(append([]string{}, c.Allow...), c.Deny...), c.SudoAllow...) {
		if !filepath.IsAbs(s) || filepath.Clean(s) != s {
			return errors.New("command paths must be clean and absolute")
		}
	}
	return nil
}
