// Package config handles reading and writing the agent's persistent
// configuration. On Windows the file lives at
// %APPDATA%\dbstudio-agent\config.json; on unix-like systems it lives at
// $XDG_CONFIG_HOME/dbstudio-agent/config.json (falling back to
// ~/.config/dbstudio-agent/config.json).
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Config is the on-disk state the agent needs to reconnect without a fresh
// pairing token. serverURL is the base WS/WSS URL of the server, agentId is the
// identity assigned by the server on first pairing, and refreshSecret is the
// long-lived secret used as the token on subsequent reconnects.
type Config struct {
	ServerURL     string `json:"serverURL"`
	AgentID       string `json:"agentId"`
	RefreshSecret string `json:"refreshSecret"`
}

// dirName is the per-user subdirectory that holds config.json.
const dirName = "dbstudio-agent"

const fileName = "config.json"

// Dir returns the directory that holds the agent config file, creating nothing.
// It honours an explicit override (e.g. from a --config flag pointing at a
// directory) when non-empty.
func Dir(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if runtime.GOOS == "windows" {
		base := os.Getenv("APPDATA")
		if base == "" {
			// Fall back to LOCALAPPDATA, then the user home dir.
			base = os.Getenv("LOCALAPPDATA")
		}
		if base == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", fmt.Errorf("cannot determine config dir: %w", err)
			}
			base = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(base, dirName), nil
	}

	// unix-like: prefer XDG_CONFIG_HOME, else ~/.config
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, dirName), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot determine config dir: %w", err)
	}
	return filepath.Join(home, ".config", dirName), nil
}

// Path returns the full path to config.json. If override is a path ending in
// .json it is treated as the file itself; otherwise it is treated as a
// directory that contains config.json.
func Path(override string) (string, error) {
	if override != "" && filepath.Ext(override) == ".json" {
		return override, nil
	}
	dir, err := Dir(override)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, fileName), nil
}

// Load reads the config file. If the file does not exist it returns a zero-value
// Config and no error, so callers can treat "no config yet" as a normal first
// run. override may be "" (use the default location), a directory, or a full
// path to a .json file.
func Load(override string) (*Config, error) {
	path, err := Path(override)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &Config{}, nil
		}
		return nil, fmt.Errorf("read config %s: %w", path, err)
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}
	return &c, nil
}

// Save writes the config file atomically (write to a temp file in the same
// directory, then rename). The parent directory is created with 0o700 so the
// refresh secret is not world-readable on unix systems.
func Save(override string, c *Config) error {
	path, err := Path(override)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create config dir %s: %w", dir, err)
	}

	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}

	tmp, err := os.CreateTemp(dir, fileName+".tmp-*")
	if err != nil {
		return fmt.Errorf("create temp config: %w", err)
	}
	tmpName := tmp.Name()
	// Best-effort cleanup if we bail out before the rename.
	defer func() { _ = os.Remove(tmpName) }()

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temp config: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp config: %w", err)
	}
	// Restrict permissions before the rename (no-op semantics on Windows).
	_ = os.Chmod(tmpName, 0o600)

	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("save config %s: %w", path, err)
	}
	return nil
}
