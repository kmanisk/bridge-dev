package config

import (
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/kmanisk/bridge-dev/internal/platform"
	"github.com/pelletier/go-toml/v2"
)

// Save atomically persists preferences. Runtime acknowledgment and grants are
// never persisted; a manual ack_privileged setting is separate from grants.
func Save(c Config) error {
	path := c.ConfigFile
	if path == "" {
		path = DefaultPath()
	}
	if e := platform.PrivateDir(filepath.Dir(path)); e != nil {
		return e
	}
	unlock, e := platform.Lock(path + ".lock")
	if e != nil {
		return e
	}
	defer unlock()
	original, e := os.ReadFile(path)
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	if e == nil && c.Schema < 2 {
		backup := path + ".pre-v2-" + time.Now().UTC().Format("20060102T150405.000000000")
		if e = platform.Atomic(backup, original); e != nil {
			return e
		}
	}
	c.Schema = 2
	c.AckDanger = false
	c.PrivilegedAuthorized = false
	data, e := toml.Marshal(c)
	if e != nil {
		return e
	}
	return platform.Atomic(path, data)
}

// Restore is deliberately explicit and preserves the current configuration as
// a backup. It is never called as a permissive invalid-config fallback.
func Restore(path, backup string) error {
	b, e := os.ReadFile(backup)
	if e != nil {
		return e
	}
	var c Config = Defaults()
	if e = toml.Unmarshal(b, &c); e != nil {
		return e
	}
	if e = c.Validate(false); e != nil {
		return errors.New("backup configuration is invalid")
	}
	old, e := os.ReadFile(path)
	if e == nil {
		if e = platform.Atomic(path+".before-restore", old); e != nil {
			return e
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	return platform.Atomic(path, b)
}
