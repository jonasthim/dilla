package spotify

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/id"
)

var catalogRequester = id.New()

type catalogRoundTripper func(*http.Request) (*http.Response, error)

func (f catalogRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func catalogClient(t *testing.T, transport catalogRoundTripper) *Catalog {
	t.Helper()
	return NewCatalog(&http.Client{Transport: transport})
}

func catalogResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}
}

func TestExpandTrackReturnsCanonicalTrackMetadata(t *testing.T) {
	cat := catalogClient(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Scheme != "https" || r.URL.Host != "api.spotify.com" || r.URL.Path != "/v1/tracks/0123456789012345678901" {
			t.Fatalf("request URL = %s", r.URL)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer operator-token" {
			t.Fatalf("authorization = %q", got)
		}
		return catalogResponse(http.StatusOK, `{"id":"0123456789012345678901","type":"track","name":"Song","uri":"spotify:track:0123456789012345678901","duration_ms":123000,"artists":[{"name":"Artist"}],"album":{"name":"Record"}}`), nil
	})
	tracks, err := cat.Expand(context.Background(), "operator-token", "https://open.spotify.com/track/0123456789012345678901", catalogRequester)
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks) != 1 || tracks[0].Provider != music.ProviderSpotify || tracks[0].CanonicalID != "spotify:track:0123456789012345678901" || tracks[0].Title != "Song" || tracks[0].Artist != "Artist" || tracks[0].Album != "Record" || tracks[0].DurationMS != 123000 || tracks[0].ID == "" || tracks[0].RequesterID != catalogRequester.String() {
		t.Fatalf("tracks = %#v", tracks)
	}
}

func TestExpandAlbumPaginatesAndEnrichesTrackMetadata(t *testing.T) {
	cat := catalogClient(t, func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/v1/albums/AAAAAAAAAAAAAAAAAAAAAA":
			return catalogResponse(http.StatusOK, `{"id":"AAAAAAAAAAAAAAAAAAAAAA","name":"Record","artists":[{"name":"Album Artist"}],"tracks":{"total":2}}`), nil
		case "/v1/albums/AAAAAAAAAAAAAAAAAAAAAA/tracks":
			if r.URL.Query().Get("limit") != "50" {
				t.Fatalf("limit = %q", r.URL.Query().Get("limit"))
			}
			switch r.URL.Query().Get("offset") {
			case "0":
				return catalogResponse(http.StatusOK, `{"total":2,"items":[{"id":"0123456789012345678901","name":"One","duration_ms":1000,"artists":[{"name":"Track Artist"}]}],"next":"https://api.spotify.com/v1/albums/AAAAAAAAAAAAAAAAAAAAAA/tracks?limit=50&offset=1"}`), nil
			case "1":
				return catalogResponse(http.StatusOK, `{"total":2,"items":[{"id":"1123456789012345678901","name":"Two","duration_ms":2000,"artists":[{"name":"Track Artist"}]}],"next":null}`), nil
			default:
				t.Fatalf("unexpected offset %q", r.URL.Query().Get("offset"))
			}
		}
		t.Fatalf("unexpected URL %s", r.URL)
		return nil, nil
	})
	tracks, err := cat.Expand(context.Background(), "token", "spotify:album:AAAAAAAAAAAAAAAAAAAAAA", catalogRequester)
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks) != 2 || tracks[1].Title != "Two" || tracks[1].Album != "Record" || tracks[1].Artist != "Track Artist" || tracks[1].CanonicalID != "spotify:track:1123456789012345678901" {
		t.Fatalf("tracks = %#v", tracks)
	}
}

func TestExpandPlaylistUsesItemsEndpointAndFailsOnUnsupportedItems(t *testing.T) {
	cat := catalogClient(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/v1/playlists/BBBBBBBBBBBBBBBBBBBBBB/items" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		return catalogResponse(http.StatusOK, `{"total":2,"items":[{"item":{"type":"track","id":"0123456789012345678901","name":"Song","uri":"spotify:track:0123456789012345678901","duration_ms":123000,"artists":[{"name":"Artist"}],"album":{"name":"Record"}}},{"item":{"type":"episode","id":"episode"}}],"next":null}`), nil
	})
	tracks, err := cat.Expand(context.Background(), "token", "https://open.spotify.com/playlist/BBBBBBBBBBBBBBBBBBBBBB", catalogRequester)
	if err == nil || tracks != nil {
		t.Fatalf("partial playlist result = %#v, error = %v", tracks, err)
	}
}

func TestExpandPlaylistPaginatesAllTrackItems(t *testing.T) {
	cat := catalogClient(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/v1/playlists/BBBBBBBBBBBBBBBBBBBBBB/items" || r.URL.Query().Get("limit") != "50" {
			t.Fatalf("request = %s", r.URL)
		}
		track := func(id, name string) string {
			return `{"item":{"type":"track","id":"` + id + `","name":"` + name + `","duration_ms":1000,"artists":[{"name":"Artist"}]}}`
		}
		switch r.URL.Query().Get("offset") {
		case "0":
			return catalogResponse(http.StatusOK, `{"total":2,"items":[`+track("0123456789012345678901", "One")+`]}`), nil
		case "1":
			return catalogResponse(http.StatusOK, `{"total":2,"items":[`+track("1123456789012345678901", "Two")+`]}`), nil
		default:
			t.Fatalf("unexpected offset %q", r.URL.Query().Get("offset"))
			return nil, nil
		}
	})
	tracks, err := cat.Expand(context.Background(), "token", "spotify:playlist:BBBBBBBBBBBBBBBBBBBBBB", catalogRequester)
	if err != nil {
		t.Fatal(err)
	}
	if len(tracks) != 2 || tracks[0].Title != "One" || tracks[1].Title != "Two" {
		t.Fatalf("tracks = %#v", tracks)
	}
}

func TestExpandFailsClosedOnPlaylistAccessDenialAndDoesNotExposeToken(t *testing.T) {
	cat := catalogClient(t, func(r *http.Request) (*http.Response, error) {
		return catalogResponse(http.StatusForbidden, `{"error":"private","access_token":"operator-secret"}`), nil
	})
	_, err := cat.Expand(context.Background(), "operator-secret", "spotify:playlist:BBBBBBBBBBBBBBBBBBBBBB", catalogRequester)
	if err == nil || strings.Contains(err.Error(), "operator-secret") || strings.Contains(err.Error(), "private") {
		t.Fatalf("error not sanitized: %v", err)
	}
}

func TestExpandRejectsRedirectsAndOversizedResponse(t *testing.T) {
	t.Run("redirect", func(t *testing.T) {
		calls := 0
		cat := catalogClient(t, func(r *http.Request) (*http.Response, error) {
			calls++
			return &http.Response{StatusCode: http.StatusFound, Header: http.Header{"Location": []string{"https://evil.example/leak"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
		})
		_, err := cat.Expand(context.Background(), "token", "spotify:track:0123456789012345678901", catalogRequester)
		if err == nil || calls != 1 {
			t.Fatalf("error=%v calls=%d", err, calls)
		}
	})
	t.Run("oversized response", func(t *testing.T) {
		cat := catalogClient(t, func(*http.Request) (*http.Response, error) {
			return catalogResponse(http.StatusOK, fmt.Sprintf(`{"padding":%q}`, strings.Repeat("x", MaxCatalogResponseBytes))), nil
		})
		_, err := cat.Expand(context.Background(), "token", "spotify:track:0123456789012345678901", catalogRequester)
		if err == nil {
			t.Fatal("oversized response accepted")
		}
	})
}

func TestExpandRejectsInputsAndMoreThan500Items(t *testing.T) {
	for _, input := range []string{"http://open.spotify.com/track/0123456789012345678901", "https://evil.example/track/0123456789012345678901", "spotify:episode:0123456789012345678901"} {
		if _, err := NewCatalog(nil).Expand(context.Background(), "token", input, catalogRequester); err == nil {
			t.Errorf("accepted input %q", input)
		}
	}
	cat := catalogClient(t, func(*http.Request) (*http.Response, error) {
		return catalogResponse(http.StatusOK, `{"total":501,"items":[]}`), nil
	})
	if _, err := cat.Expand(context.Background(), "token", "spotify:playlist:BBBBBBBBBBBBBBBBBBBBBB", catalogRequester); err == nil {
		t.Fatal("accepted playlist with over 500 items")
	}
}

func TestExpandPreservesRepeatedPlaylistTracksAsDistinctQueueItems(t *testing.T) {
	cat := catalogClient(t, func(*http.Request) (*http.Response, error) {
		return catalogResponse(http.StatusOK, `{"total":2,"items":[{"item":{"type":"track","id":"0123456789012345678901","name":"Song","duration_ms":1000,"artists":[{"name":"Artist"}]}},{"item":{"type":"track","id":"0123456789012345678901","name":"Song","duration_ms":1000,"artists":[{"name":"Artist"}]}}]}`), nil
	})
	tracks, err := cat.Expand(context.Background(), "token", "spotify:playlist:BBBBBBBBBBBBBBBBBBBBBB", catalogRequester)
	if err != nil || len(tracks) != 2 || tracks[0].ID == tracks[1].ID || tracks[0].RequesterID != catalogRequester.String() || tracks[1].RequesterID != catalogRequester.String() {
		t.Fatalf("repeated tracks lost queue identity: %#v, %v", tracks, err)
	}
	state := music.InitialState()
	if _, err := music.Apply(state, state.Revision, music.Operation{Kind: music.OpImportPlaylist, Tracks: tracks}); err != nil {
		t.Fatalf("expanded tracks fail queue validation: %v", err)
	}
}
