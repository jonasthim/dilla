package dillad_test

import (
	"context"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/jonasthim/dilla/internal/cborx"
)

// version_test.go is web3.8 S1: the instance offers wire version 2 alone. A hello's wire list is
// [2], an identify that picks wire 1 is refused with E_VERSION and close 4006, and GET
// /v1/instance advertises the same [2] as the hello. web3.6 and web3.7 clients both identify with
// wire 1, so a stale bundle meets the version close and its reload banner instead of uploading
// two-element bodies the delivery service now refuses.

// dialHello opens /gateway without a credential on the upgrade and returns the connection and the
// hello payload.
func dialHello(t *testing.T, ctx context.Context, base string) (*websocket.Conn, []any) {
	t.Helper()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(base, "http")+"/gateway", //nolint:bodyclose // websocket.Dial documents that the handshake response body never needs closing
		&websocket.DialOptions{Subprotocols: []string{"dilla.v1"}})
	if err != nil {
		t.Fatalf("dial /gateway: %v", err)
	}
	t.Cleanup(func() { _ = c.CloseNow() })
	op, hello := readFrame(t, ctx, c)
	if op != 0 {
		t.Fatalf("first frame op %d, want hello (0)", op)
	}
	return c, hello
}

// identifyWith sends op 1 carrying the bearer in its first element and wire as its wire version;
// e2ee, media and caps are 1, 1 and 0.
func identifyWith(t *testing.T, ctx context.Context, c *websocket.Conn, bearer string, wire uint64) {
	t.Helper()
	b, err := cborx.Marshal([]any{uint64(1), uint64(1), nil,
		[]any{bearer, wire, uint64(1), uint64(1), uint64(0)}})
	if err != nil {
		t.Fatalf("marshal identify: %v", err)
	}
	if err := c.Write(ctx, websocket.MessageBinary, b); err != nil {
		t.Fatalf("write identify: %v", err)
	}
}

func TestTheGatewayOffersWireTwo(t *testing.T) {
	_, ts, _ := newGreetedServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, hello := dialHello(t, ctx, ts.URL)
	for i, want := range [][]uint64{{2}, {1}, {1}} {
		names := []string{"wire_versions", "e2ee_versions", "media_versions"}
		if got := uints(t, hello[i], names[i]); !slices.Equal(got, want) {
			t.Fatalf("hello %s = %v, want %v", names[i], got, want)
		}
	}
}

// The refusal and its control differ in the wire version alone: the same session token in the
// identify's first element.
func TestIdentifyWithWireOneIsRefused(t *testing.T) {
	_, ts, token := newGreetedServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	c, _ := dialHello(t, ctx, ts.URL)
	identifyWith(t, ctx, c, token, 1)
	op, payload := readFrame(t, ctx, c)
	if op != 9 || len(payload) < 2 || payload[1] != "E_VERSION" {
		t.Fatalf("identify with wire 1: op %d %v, want an error frame (9) naming E_VERSION", op, payload)
	}
	_, _, err := c.Read(ctx)
	if got := websocket.CloseStatus(err); got != 4006 {
		t.Fatalf("identify with wire 1 ended with %v (close %d), want close 4006", err, got)
	}

	// Control: the same identify with wire 2 reaches ready.
	c2, _ := dialHello(t, ctx, ts.URL)
	identifyWith(t, ctx, c2, token, 2)
	if op, payload := readFrame(t, ctx, c2); op != 3 {
		t.Fatalf("control: identify with wire 2: op %d %v, want ready (3)", op, payload)
	}
}

func TestTheInstanceDocumentAdvertisesWireTwo(t *testing.T) {
	_, ts, _ := newGreetedServer(t)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, ts.URL+"/v1/instance", nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /v1/instance: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET /v1/instance = %d", res.StatusCode)
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read the instance document: %v", err)
	}
	var doc []any
	if err := cborx.Unmarshal(body, &doc); err != nil {
		t.Fatalf("decode the instance document: %v", err)
	}
	if len(doc) != 12 {
		t.Fatalf("the instance document has %d elements, want 12", len(doc))
	}
	if got := uints(t, doc[0], "wire_versions"); !slices.Equal(got, []uint64{2}) {
		t.Fatalf("wire_versions = %v, want [2], the hello's list", got)
	}
}
