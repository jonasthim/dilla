package sfu

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	lkconfig "github.com/livekit/livekit-server/pkg/config"
	"golang.org/x/tools/go/packages"
)

var updateLevelGolden = flag.Bool("update-media-level", false,
	"rewrite testdata/media-level.json from the current inputs (after bumping MediaLevel)")

// levelGoldenPath is the pinned contract. levelGolden is its shape.
const levelGoldenPath = "testdata/media-level.json"

type levelGolden struct {
	LiveKitServer      string   `json:"livekit_server"`
	ClientProtocol     int      `json:"client_protocol"`
	SignalSchemaSHA256 string   `json:"signal_schema_sha256"`
	SFUConfigSHA256    string   `json:"sfu_config_sha256"`
	RoomServiceMethods []string `json:"room_service_methods"`
	WebhookEvents      []string `json:"webhook_events"`
	MediaLevel         int      `json:"media_level"`
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// moduleRoot is the repository root: this package lives at internal/sfu.
func moduleRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	return root
}

var livekitServerRequire = regexp.MustCompile(`(?m)^\s*(?:require\s+)?github\.com/livekit/livekit-server\s+(v\S+)`)

// livekitServerVersion is the livekit-server module version go.mod pins.
func livekitServerVersion(t *testing.T) string {
	t.Helper()
	mod, err := os.ReadFile(filepath.Join(moduleRoot(t), "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	m := livekitServerRequire.FindSubmatch(mod)
	if m == nil {
		t.Fatal("go.mod does not require github.com/livekit/livekit-server")
	}
	return string(m[1])
}

// levelFixtureConfig sets every optional sfu.Config field, so a change to how any of them renders
// moves the hash. cmd/dillad's TestSFUConfigMappingIsPinned pins the dilla.toml -> sfu.Config side.
func levelFixtureConfig() Config {
	c := DefaultConfig()
	c.APISecret = "dilla-level-guard-secret-0123456789"
	c.STUNServers = []string{"198.51.100.7:3478"}
	c.MaxParticipants = 25
	c.VP9 = true
	c.WebhookURL = "http://127.0.0.1:7890" + WebhookPath
	c.LimitNumTracks = 600
	c.LimitBytesPerSec = 12500000
	c.IPsExcludes = []string{"172.17.0.0/16"}
	return c
}

// RenderedConfigHash is the SHA-256 of the LiveKit config a Config renders to: the YAML parsed by
// LiveKit's own strict NewConfig and marshalled back, so a livekit-server default that changes the
// effective config moves it as well.
func renderedConfigHash(c Config) (string, error) {
	y, err := c.YAML()
	if err != nil {
		return "", err
	}
	conf, err := lkconfig.NewConfig(y, true, nil, nil)
	if err != nil {
		return "", fmt.Errorf("LiveKit refuses the rendered config: %w", err)
	}
	raw, err := json.Marshal(conf)
	if err != nil {
		return "", err
	}
	return sha256Hex(append([]byte(y), raw...)), nil
}

const (
	livekitPkgPath   = "github.com/livekit/protocol/livekit"
	internalPattern  = "github.com/jonasthim/dilla/internal/..."
	roomServiceIface = "RoomService"
)

// isRoomServiceCall returns the method name when call invokes a method of livekit's RoomService.
func isRoomServiceCall(info *types.Info, call *ast.CallExpr) (string, bool) {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return "", false
	}
	s := info.Selections[sel]
	if s == nil {
		return "", false
	}
	recv := s.Recv()
	if p, ok := recv.(*types.Pointer); ok {
		recv = p.Elem()
	}
	named, ok := recv.(*types.Named)
	if !ok || named.Obj().Pkg() == nil {
		return "", false
	}
	if named.Obj().Pkg().Path() != livekitPkgPath || named.Obj().Name() != roomServiceIface {
		return "", false
	}
	return sel.Sel.Name, true
}

// scanRoomService type-checks every package under internal/ and returns the sorted set of
// RoomService methods called anywhere. A call through sfu.Server or sfu.Remote ends in one of these
// calls inside internal/sfu, so the wrappers need no set of their own.
func scanRoomService(t *testing.T) []string {
	t.Helper()
	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedSyntax | packages.NeedTypes |
			packages.NeedTypesInfo | packages.NeedImports | packages.NeedDeps,
		Dir: moduleRoot(t),
	}
	pkgs, err := packages.Load(cfg, internalPattern)
	if err != nil {
		t.Fatalf("packages.Load: %v", err)
	}
	called := map[string]bool{}
	for _, p := range pkgs {
		if len(p.Errors) > 0 {
			t.Fatalf("package %s does not type-check: %v", p.PkgPath, p.Errors[0])
		}
		for _, f := range p.Syntax {
			ast.Inspect(f, func(n ast.Node) bool {
				if call, ok := n.(*ast.CallExpr); ok {
					if name, ok := isRoomServiceCall(p.TypesInfo, call); ok {
						called[name] = true
					}
				}
				return true
			})
		}
	}
	return sortedKeys(called)
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// webhookEventsIn parses each source and returns the sorted set of webhook.Event* names it
// mentions: the case labels (and comparisons) that decide what dillad does with an event.
func webhookEventsIn(sources map[string][]byte) ([]string, error) {
	set := map[string]bool{}
	fset := token.NewFileSet()
	for name, src := range sources {
		f, err := parser.ParseFile(fset, name, src, 0)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if id, ok := sel.X.(*ast.Ident); ok && id.Name == "webhook" && strings.HasPrefix(sel.Sel.Name, "Event") {
				set[sel.Sel.Name] = true
			}
			return true
		})
	}
	return sortedKeys(set), nil
}

// webhookSources is internal/api/callevents.go and every non-test file of internal/sfu.
func webhookSources(t *testing.T) map[string][]byte {
	t.Helper()
	root := moduleRoot(t)
	paths, err := filepath.Glob(filepath.Join(root, "internal", "sfu", "*.go"))
	if err != nil {
		t.Fatal(err)
	}
	paths = append(paths, filepath.Join(root, "internal", "api", "callevents.go"))
	out := map[string][]byte{}
	for _, p := range paths {
		if strings.HasSuffix(p, "_test.go") {
			continue
		}
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		out[p] = b
	}
	return out
}

func currentLevelGolden(t *testing.T) levelGolden {
	t.Helper()
	schema, err := os.ReadFile("testdata/livekit-signal-schema.json")
	if err != nil {
		t.Fatal(err)
	}
	cfgHash, err := renderedConfigHash(levelFixtureConfig())
	if err != nil {
		t.Fatal(err)
	}
	called := scanRoomService(t)
	events, err := webhookEventsIn(webhookSources(t))
	if err != nil {
		t.Fatal(err)
	}
	return levelGolden{
		LiveKitServer:      livekitServerVersion(t),
		ClientProtocol:     ClientProtocol,
		SignalSchemaSHA256: sha256Hex(schema),
		SFUConfigSHA256:    cfgHash,
		RoomServiceMethods: called,
		WebhookEvents:      events,
		MediaLevel:         MediaLevel,
	}
}

// diffLevel names each field of two goldens that differ.
func diffLevel(want, got levelGolden) []string {
	var d []string
	add := func(name string, w, g any) {
		if fmt.Sprint(w) != fmt.Sprint(g) {
			d = append(d, fmt.Sprintf("%s: pinned %v, now %v", name, w, g))
		}
	}
	add("livekit_server", want.LiveKitServer, got.LiveKitServer)
	add("client_protocol", want.ClientProtocol, got.ClientProtocol)
	add("signal_schema_sha256", want.SignalSchemaSHA256, got.SignalSchemaSHA256)
	add("sfu_config_sha256", want.SFUConfigSHA256, got.SFUConfigSHA256)
	add("room_service_methods", want.RoomServiceMethods, got.RoomServiceMethods)
	add("webhook_events", want.WebhookEvents, got.WebhookEvents)
	return d
}

// TestMediaLevelGuard pins every input of the API<->SFU contract. A change to one without a
// MediaLevel bump fails with "bump MediaLevel".
func TestMediaLevelGuard(t *testing.T) {
	got := currentLevelGolden(t)
	if *updateLevelGolden {
		raw, err := json.MarshalIndent(got, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(levelGoldenPath, append(raw, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(levelGoldenPath)
	if err != nil {
		t.Fatalf("%v (go test ./internal/sfu -run TestMediaLevelGuard -update-media-level)", err)
	}
	var want levelGolden
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("%s: %v", levelGoldenPath, err)
	}
	diff := diffLevel(want, got)
	switch {
	case len(diff) > 0 && want.MediaLevel == got.MediaLevel:
		t.Fatalf("the API<->SFU contract changed without a level change: bump MediaLevel (internal/sfu/level.go), "+
			"then rewrite the golden with -update-media-level:\n  %s", strings.Join(diff, "\n  "))
	case len(diff) > 0:
		t.Fatalf("MediaLevel is bumped but %s is stale: rewrite it with -update-media-level:\n  %s",
			levelGoldenPath, strings.Join(diff, "\n  "))
	case want.MediaLevel != got.MediaLevel:
		t.Fatalf("MediaLevel is %d but %s pins %d with no contract input changed: revert the bump, or rewrite the golden with -update-media-level",
			got.MediaLevel, levelGoldenPath, want.MediaLevel)
	}
}

func TestLevelConstantsAreConsistent(t *testing.T) {
	if MinSFUMediaLevel < 1 || MinSFUMediaLevel > MediaLevel {
		t.Fatalf("MinSFUMediaLevel %d must be in 1..MediaLevel (%d)", MinSFUMediaLevel, MediaLevel)
	}
	if MediaLevel != 2 || MinSFUMediaLevel != 1 {
		t.Fatalf("web3.12 is MediaLevel 2, MinSFUMediaLevel 1; got %d, %d", MediaLevel, MinSFUMediaLevel)
	}
	if len(Capabilities) != 1 || Capabilities[0] != "turn" {
		t.Fatalf("Capabilities = %v, want [turn]", Capabilities)
	}
}

// The guard's own mutation tests: each input, changed, must move what the guard compares.

func TestLevelGuardSeesAWebhookEventAdded(t *testing.T) {
	sources := webhookSources(t)
	base, err := webhookEventsIn(sources)
	if err != nil {
		t.Fatal(err)
	}
	var key string
	for k := range sources {
		if filepath.Base(k) == "callevents.go" {
			key = k
		}
	}
	const label = "case webhook.EventTrackPublished:"
	if !bytes.Contains(sources[key], []byte(label)) {
		t.Fatalf("callevents.go has no %q to mutate", label)
	}
	mutated := map[string][]byte{}
	for k, v := range sources {
		mutated[k] = v
	}
	mutated[key] = bytes.Replace(sources[key], []byte(label), []byte("case webhook.EventTrackUpdated, webhook.EventTrackPublished:"), 1)
	got, err := webhookEventsIn(mutated)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(got) == fmt.Sprint(base) || !strings.Contains(fmt.Sprint(got), "EventTrackUpdated") {
		t.Fatalf("an extra webhook.EventTrackUpdated case left the event set unchanged: %v", got)
	}
	want := levelGolden{WebhookEvents: base}
	if len(diffLevel(want, levelGolden{WebhookEvents: got})) == 0 {
		t.Fatal("diffLevel does not report a changed webhook event set")
	}
}

func TestLevelGuardSeesTheRenderedConfigChange(t *testing.T) {
	base, err := renderedConfigHash(levelFixtureConfig())
	if err != nil {
		t.Fatal(err)
	}
	again, err := renderedConfigHash(levelFixtureConfig())
	if err != nil {
		t.Fatal(err)
	}
	if base != again {
		t.Fatal("the rendered config hash is not deterministic")
	}
	for name, mutate := range map[string]func(*Config){
		"udp port":      func(c *Config) { c.UDPPort++ },
		"auto create":   func(c *Config) { c.AutoCreate = true },
		"vp9":           func(c *Config) { c.VP9 = false },
		"webhook url":   func(c *Config) { c.WebhookURL = "http://127.0.0.1:7891" + WebhookPath },
		"departure":     func(c *Config) { c.DepartureTimeout++ },
		"stun sentinel": func(c *Config) { c.STUNServers = nil },
	} {
		c := levelFixtureConfig()
		mutate(&c)
		got, err := renderedConfigHash(c)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got == base {
			t.Errorf("changing %s left the rendered config hash unchanged", name)
		}
	}
}

func TestLevelGuardSeesARoomServiceMethodAdded(t *testing.T) {
	called := scanRoomService(t)
	if len(called) == 0 {
		t.Fatal("the scan found no RoomService use")
	}
	for _, want := range []string{"CreateRoom", "DeleteRoom", "ListParticipants", "ListRooms", "RemoveParticipant", "UpdateParticipant"} {
		found := false
		for _, c := range called {
			found = found || c == want
		}
		if !found {
			t.Errorf("the scan missed RoomService.%s (found %v)", want, called)
		}
	}
	grown := append(append([]string(nil), called...), "MutateParticipant")
	sort.Strings(grown)
	if len(diffLevel(levelGolden{RoomServiceMethods: called}, levelGolden{RoomServiceMethods: grown})) == 0 {
		t.Fatal("diffLevel does not report a changed RoomService method set")
	}
}
