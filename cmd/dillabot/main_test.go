package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfigRequiresAbsoluteProtectedCredentialPaths(t *testing.T) {
	dir := t.TempDir()
	credential := filepath.Join(dir, "runtime.token")
	if err := os.WriteFile(credential, []byte("dbr_"+base64.RawURLEncoding.EncodeToString(make([]byte, 32))), 0o600); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "bot.toml")
	config := `
base_url = "https://dilla.example"
instance_id = "01010101010101010101010101010101"
runtime_credential_file = "` + credential + `"
helper_executable = "/usr/libexec/dilla-bot-core"
wasi_module = "/usr/lib/dilla/dilla_core_wasi.wasm"
state_dir = "/var/lib/dillabot"
reconcile_interval = "30s"
`
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := loadConfig(configPath)
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if got.InstanceID.String() != "01010101010101010101010101010101" || got.RuntimeCredentialFile != credential {
		t.Fatalf("loaded config does not preserve configured instance and credential file")
	}

	if err := os.Chmod(credential, 0o640); err != nil {
		t.Fatal(err)
	}
	if _, err := loadConfig(configPath); err == nil {
		t.Fatal("loadConfig accepted a runtime credential file readable by group")
	}
}

func TestLoadConfigRejectsCredentialSymlink(t *testing.T) {
	dir := t.TempDir()
	secret := filepath.Join(dir, "secret")
	if err := os.WriteFile(secret, []byte("dbr_"+base64.RawURLEncoding.EncodeToString(make([]byte, 32))), 0o600); err != nil {
		t.Fatal(err)
	}
	credential := filepath.Join(dir, "runtime.token")
	if err := os.Symlink(secret, credential); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(dir, "bot.toml")
	config := `
base_url = "https://dilla.example"
instance_id = "01010101010101010101010101010101"
runtime_credential_file = "` + credential + `"
helper_executable = "/usr/libexec/dilla-bot-core"
wasi_module = "/usr/lib/dilla/dilla_core_wasi.wasm"
state_dir = "/var/lib/dillabot"
reconcile_interval = "30s"
`
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadConfig(configPath); err == nil {
		t.Fatal("loadConfig accepted a symlink credential file")
	}
}

func TestLoadConfigRejectsUnknownKeys(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bot.toml")
	if err := os.WriteFile(path, []byte("unexpected = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadConfig(path); err == nil {
		t.Fatal("loadConfig accepted an unknown setting")
	}
}

func TestLoadConfigValidatesOptionalSpotifyOAuthPair(t *testing.T) {
	dir := t.TempDir()
	credential := filepath.Join(dir, "runtime.token")
	if err := os.WriteFile(credential, []byte("dbr_"+base64.RawURLEncoding.EncodeToString(make([]byte, 32))), 0o600); err != nil {
		t.Fatal(err)
	}
	base := `base_url = "https://dilla.example"
instance_id = "01010101010101010101010101010101"
runtime_credential_file = "` + credential + `"
helper_executable = "/usr/libexec/dilla-bot-core"
wasi_module = "/usr/lib/dilla/dilla_core_wasi.wasm"
state_dir = "/var/lib/dillabot"
reconcile_interval = "30s"
`
	for _, tc := range []struct {
		suffix string
		good   bool
	}{
		{``, true},
		{`spotify_client_id = "public-client"
spotify_redirect_url = "https://dilla.example/settings/bot/music/spotify/callback"
`, true},
		{`spotify_client_id = "public-client"
`, false},
		{`spotify_client_id = "public-client"
spotify_redirect_url = "http://dilla.example/callback"
`, false},
	} {
		path := filepath.Join(dir, "bot.toml")
		if err := os.WriteFile(path, []byte(base+tc.suffix), 0o600); err != nil {
			t.Fatal(err)
		}
		cfg, err := loadConfig(path)
		if (err == nil) != tc.good {
			t.Fatalf("load config with suffix %q: %v", tc.suffix, err)
		}
		if tc.good && tc.suffix != "" && cfg.SpotifyClientID != "public-client" {
			t.Fatal("valid Spotify client ID was not loaded")
		}
	}
}

func TestLoadDatabaseKeyCreatesPrivatePerInstallationKey(t *testing.T) {
	root := filepath.Join(t.TempDir(), "state")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	installation := "02020202020202020202020202020202"
	key, path, err := loadDatabaseKey(root, installation)
	if err != nil {
		t.Fatalf("loadDatabaseKey: %v", err)
	}
	if len(key) != 32 || path != filepath.Join(root, installation, "database.key") {
		t.Fatal("database key has unexpected shape or location")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("database key mode = %o, want 600", info.Mode().Perm())
	}
	want := append([]byte(nil), key...)
	clear(key)

	second, _, err := loadDatabaseKey(root, installation)
	if err != nil {
		t.Fatalf("load existing database key: %v", err)
	}
	defer clear(second)
	if len(second) != 32 {
		t.Fatal("existing database key has wrong size")
	}
	if string(second) != string(want) {
		t.Fatal("database key changed across reload")
	}
	clear(want)
}

func TestLoadDatabaseKeyRefusesMissingKeyWhenDatabaseOrSidecarsExist(t *testing.T) {
	for _, stateFile := range []string{"state.db", "state.db-wal", "state.db-shm", "state.db-journal", "state.db.init-abcdef", "state.init", "state.init-tmp-abcdef"} {
		t.Run(stateFile, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), "state")
			installDir := filepath.Join(root, "03030303030303030303030303030303")
			if err := os.MkdirAll(installDir, 0o700); err != nil {
				t.Fatal(err)
			}
			statePath := filepath.Join(installDir, stateFile)
			if err := os.WriteFile(statePath, []byte("encrypted state fixture"), 0o600); err != nil {
				t.Fatal(err)
			}

			key, _, err := loadDatabaseKey(root, filepath.Base(installDir))
			if err == nil {
				clear(key)
				t.Fatal("loadDatabaseKey created a new key while database state existed")
			}
			if _, statErr := os.Lstat(filepath.Join(installDir, "database.key")); !os.IsNotExist(statErr) {
				t.Fatalf("loadDatabaseKey persisted a replacement key: stat err = %v", statErr)
			}
		})
	}
}

func TestValidateHelperExecutableRequiresRegularExecutable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "helper")
	if err := os.WriteFile(path, []byte("helper"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateHelperExecutable(path); err == nil {
		t.Fatal("helper preflight accepted a non-executable file")
	}
	if err := os.Chmod(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := validateHelperExecutable(path); err != nil {
		t.Fatalf("helper preflight rejected an executable file: %v", err)
	}
}
