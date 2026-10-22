package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/spotifyauth"
	"github.com/jonasthim/dilla/internal/id"
)

type spotifyTestRuntime struct {
	claim client.SpotifyCodeClaim
	err   error
	calls int
}

func (r *spotifyTestRuntime) ClaimSpotifyCode(ctx context.Context, _ id.ID) (client.SpotifyCodeClaim, error) {
	r.calls++
	if err := ctx.Err(); err != nil {
		return client.SpotifyCodeClaim{}, err
	}
	return r.claim, r.err
}

type spotifyTestNative struct {
	binding  native.Binding
	values   map[string]native.StateValue
	fail     bool
	calls    int
	receipts map[id.ID][]uint64
}

func (n *spotifyTestNative) Binding() native.Binding { return n.binding }
func (n *spotifyTestNative) StateGet(ctx context.Context, area uint64, key []byte) (native.StateValue, error) {
	if err := ctx.Err(); err != nil {
		return native.StateValue{}, err
	}
	if area != spotifyCredentialArea {
		return native.StateValue{}, errors.New("area")
	}
	return n.values[string(key)], nil
}
func (n *spotifyTestNative) StateTransaction(ctx context.Context, tx id.ID, changes []native.StateChange) ([]uint64, error) {
	n.calls++
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if revisions, ok := n.receipts[tx]; ok {
		return append([]uint64(nil), revisions...), nil
	}
	if n.fail {
		return nil, errors.New("transaction")
	}
	c := changes[0]
	v := n.values[string(c.Key)]
	if v.Revision != c.ExpectedRevision {
		return nil, ErrSpotifyConflict
	}
	n.values[string(c.Key)] = native.StateValue{Revision: v.Revision + 1, Value: append([]byte(nil), c.Value...)}
	revisions := []uint64{v.Revision + 1}
	if n.receipts == nil {
		n.receipts = map[id.ID][]uint64{}
	}
	n.receipts[tx] = revisions
	return revisions, nil
}

type spotifyTestExchange struct {
	exchanges, refreshes        int
	exchangeToken, refreshToken spotifyauth.Token
	err                         error
	seenRefresh                 string
}

func (x *spotifyTestExchange) Exchange(ctx context.Context, _, _ string) (spotifyauth.Token, error) {
	x.exchanges++
	if err := ctx.Err(); err != nil {
		return spotifyauth.Token{}, err
	}
	return x.exchangeToken, x.err
}
func (x *spotifyTestExchange) Refresh(ctx context.Context, refresh string) (spotifyauth.Token, error) {
	x.refreshes++
	x.seenRefresh = refresh
	if err := ctx.Err(); err != nil {
		return spotifyauth.Token{}, err
	}
	return x.refreshToken, x.err
}

func spotifyFixture() (*SpotifyCredentials, *spotifyTestRuntime, *spotifyTestNative, *spotifyTestExchange) {
	b := native.Binding{Instance: testSpotifyID(1), Community: testSpotifyID(2), Installation: testSpotifyID(3)}
	r := &spotifyTestRuntime{claim: client.SpotifyCodeClaim{Attempt: testSpotifyID(4), Code: "one-use", Verifier: "verifier"}}
	n := &spotifyTestNative{binding: b, values: map[string]native.StateValue{}}
	x := &spotifyTestExchange{exchangeToken: spotifyauth.Token{AccessToken: "access", RefreshToken: "refresh", ExpiresIn: 3600}}
	s := newSpotifyCredentials(r, n, x)
	s.clock = func() time.Time { return time.Unix(1_800_000_000, 0) }
	return s, r, n, x
}
func testSpotifyID(b byte) id.ID { var out id.ID; out[15] = b; return out }

func TestSpotifyCredentialsLinkDuplicateDoesNotExchange(t *testing.T) {
	s, _, n, x := spotifyFixture()
	ctx := context.Background()
	if err := s.Link(ctx); err != nil {
		t.Fatal("link failed")
	}
	if err := s.Link(ctx); err != nil {
		t.Fatal("retry failed")
	}
	if x.exchanges != 1 || n.calls != 1 {
		t.Fatalf("exchange/transaction counts %d/%d", x.exchanges, n.calls)
	}
}

func TestSpotifyCredentialsChangedAttemptRelinks(t *testing.T) {
	s, r, _, x := spotifyFixture()
	if err := s.Link(context.Background()); err != nil {
		t.Fatal(err)
	}
	r.claim.Attempt = testSpotifyID(5)
	x.exchangeToken = spotifyauth.Token{AccessToken: "new-access", RefreshToken: "new-refresh", ExpiresIn: 3600}
	if err := s.Link(context.Background()); err != nil {
		t.Fatal("new attempt should relink")
	}
	if x.exchanges != 2 {
		t.Fatalf("exchange count %d", x.exchanges)
	}
}

func TestSpotifyCredentialsLinkUsesStoredStateWhenBrokerHasNoPendingCode(t *testing.T) {
	s, r, _, x := spotifyFixture()
	if err := s.Link(context.Background()); err != nil {
		t.Fatal("initial link failed")
	}
	r.err = client.ErrSpotifyClaimNotFound
	if err := s.Link(context.Background()); err != nil {
		t.Fatalf("stored token should survive expired broker receipt: %v", err)
	}
	if x.exchanges != 1 {
		t.Fatalf("exchange count %d", x.exchanges)
	}
}

func TestSpotifyCredentialsLinkNoPendingAndConsumedCodeRecovery(t *testing.T) {
	t.Run("no pending", func(t *testing.T) {
		s, r, _, _ := spotifyFixture()
		r.err = client.ErrSpotifyClaimNotFound
		if err := s.Link(context.Background()); !errors.Is(err, ErrSpotifyNoPending) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("consumed code requires relink", func(t *testing.T) {
		s, _, n, _ := spotifyFixture()
		n.fail = true
		if err := s.Link(context.Background()); !errors.Is(err, ErrSpotifyRelinkRequired) {
			t.Fatalf("got %v", err)
		}
	})
}

func TestSpotifyCredentialsRejectWrongBindingMalformedAndTombstone(t *testing.T) {
	t.Run("wrong binding", func(t *testing.T) {
		s, _, _, _ := spotifyFixture()
		if err := s.Link(context.Background()); err != nil {
			t.Fatal(err)
		}
		other := *s
		other.binding.Installation = testSpotifyID(9)
		if _, err := other.Load(context.Background()); !errors.Is(err, ErrSpotifyCredentials) {
			t.Fatalf("wrong binding loaded token: %v", err)
		}
	})
	t.Run("malformed", func(t *testing.T) {
		s, _, n, _ := spotifyFixture()
		n.values[string(s.key())] = native.StateValue{Revision: 1, Value: []byte{0x80}}
		if _, err := s.Load(context.Background()); !errors.Is(err, ErrSpotifyState) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("tombstone", func(t *testing.T) {
		s, _, n, _ := spotifyFixture()
		n.values[string(s.key())] = native.StateValue{Revision: 2, Tombstone: true}
		if _, err := s.Load(context.Background()); !errors.Is(err, ErrSpotifyState) {
			t.Fatalf("got %v", err)
		}
	})
}

func TestSpotifyCredentialsTransactionFailureAndContext(t *testing.T) {
	s, _, n, x := spotifyFixture()
	n.fail = true
	if err := s.Link(context.Background()); !errors.Is(err, ErrSpotifyRelinkRequired) {
		t.Fatalf("got %v", err)
	}
	if x.exchanges != 1 {
		t.Fatalf("exchange count %d", x.exchanges)
	}
	s2, r2, _, x2 := spotifyFixture()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s2.Link(ctx); err == nil {
		t.Fatal("canceled context accepted")
	}
	if r2.calls != 0 || x2.exchanges != 0 {
		t.Fatalf("calls %d/%d", r2.calls, x2.exchanges)
	}
}

func TestSpotifyCredentialsStaleIdenticalSaveCannotReplayTransactionReceipt(t *testing.T) {
	s, _, n, _ := spotifyFixture()
	state := &spotifyCredentialState{attempt: testSpotifyID(8), access: "access", refresh: "refresh", expires: 1_800_003_600}
	if err := s.save(context.Background(), state, 0); err != nil {
		t.Fatal("first save", err)
	}
	if err := s.save(context.Background(), state, 0); !errors.Is(err, ErrSpotifyConflict) {
		t.Fatalf("stale identical save returned %v", err)
	}
	if n.calls != 2 {
		t.Fatalf("transaction calls %d", n.calls)
	}
}

func TestSpotifyCredentialsRefreshRotatesRefreshToken(t *testing.T) {
	s, _, n, x := spotifyFixture()
	if err := s.Link(context.Background()); err != nil {
		t.Fatal(err)
	}
	x.refreshToken = spotifyauth.Token{AccessToken: "new-access", RefreshToken: "rotated", ExpiresIn: 7200}
	s.clock = func() time.Time { return time.Unix(1_800_004_000, 0) }
	tok, err := s.Load(context.Background())
	if err != nil {
		t.Fatal("refresh failed")
	}
	if tok.AccessToken != "new-access" || x.seenRefresh != "refresh" {
		t.Fatal("unexpected refreshed token")
	}
	persisted, _, err := s.read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if persisted.refresh != "rotated" || n.values[string(s.key())].Revision != 2 {
		t.Fatal("rotation was not persisted")
	}
}
