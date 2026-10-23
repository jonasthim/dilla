package spotify

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jonasthim/dilla/internal/bot/music"
	"github.com/jonasthim/dilla/internal/id"
)

const (
	MaxCatalogItems         = 500
	MaxCatalogResponseBytes = 2 << 20
	catalogPageSize         = 50
	maxCatalogTokenBytes    = 8192
	maxSpotifyIDBytes       = 22
	maxCatalogMetadataBytes = music.MaxMetadataBytes
	maxCatalogDuration      = 30 * time.Second
	spotifyWebAPIBase       = "https://api.spotify.com/v1"
)

var (
	ErrCatalogInput   = errors.New("spotify: invalid catalog input")
	ErrCatalogRequest = errors.New("spotify: catalog request failed")
	ErrCatalogData    = errors.New("spotify: invalid catalog response")
)

// Catalog expands Spotify tracks, albums, and playlists using the caller's
// operator token. It never changes queue state; callers apply the complete
// returned slice as one queue operation after a successful expansion.
type Catalog struct{ client *http.Client }

// NewCatalog constructs a resolver. A nil client uses the standard transport.
// Redirects are always rejected, including redirects to other HTTPS hosts.
func NewCatalog(client *http.Client) *Catalog {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	} else {
		copy := *client
		client = &copy
		if client.Timeout <= 0 {
			client.Timeout = 10 * time.Second
		}
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Catalog{client: client}
}

type catalogInput struct{ kind, id string }

// Expand returns one queue descriptor per resolved track. Unsupported playlist
// entries, malformed pages, inaccessible playlists, and limits fail the whole
// call so a caller cannot enqueue a partial import.
func (c *Catalog) Expand(ctx context.Context, accessToken, input string, requester id.ID) ([]music.Track, error) {
	if c == nil || c.client == nil || ctx == nil || requester.IsZero() || !validCatalogToken(accessToken) {
		return nil, ErrCatalogInput
	}
	ctx, cancel := context.WithTimeout(ctx, maxCatalogDuration)
	defer cancel()
	source, err := parseCatalogInput(input)
	if err != nil {
		return nil, err
	}
	var tracks []music.Track
	switch source.kind {
	case "track":
		track, err := c.getTrack(ctx, accessToken, source.id)
		if err != nil {
			return nil, err
		}
		tracks = []music.Track{track}
	case "album":
		tracks, err = c.getAlbum(ctx, accessToken, source.id)
	case "playlist":
		tracks, err = c.getPlaylist(ctx, accessToken, source.id)
	default:
		return nil, ErrCatalogInput
	}
	if err != nil {
		return nil, err
	}
	for i := range tracks {
		tracks[i].ID = id.New().String()
		tracks[i].RequesterID = requester.String()
	}
	return tracks, nil
}

func parseCatalogInput(value string) (catalogInput, error) {
	if value == "" || len(value) > 512 || strings.TrimSpace(value) != value {
		return catalogInput{}, ErrCatalogInput
	}
	parts := strings.Split(value, ":")
	if len(parts) == 3 && parts[0] == "spotify" {
		if validSpotifyID(parts[2]) && (parts[1] == "track" || parts[1] == "album" || parts[1] == "playlist") {
			return catalogInput{kind: parts[1], id: parts[2]}, nil
		}
		return catalogInput{}, ErrCatalogInput
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Opaque != "" || u.User != nil || u.Fragment != "" || u.RawFragment != "" || u.Port() != "" {
		return catalogInput{}, ErrCatalogInput
	}
	host := strings.ToLower(u.Hostname())
	if (host != "open.spotify.com" && host != "www.spotify.com") || u.Host != host {
		return catalogInput{}, ErrCatalogInput
	}
	segments := strings.Split(strings.Trim(u.EscapedPath(), "/"), "/")
	if len(segments) == 2 && segments[0] == "" {
		segments = segments[1:]
	}
	if len(segments) == 3 && validSpotifyIntlLocale(segments[0]) {
		segments = segments[1:]
	}
	if len(segments) == 3 && len(segments[0]) == 2 && segments[0][0] == 'i' && segments[0][1] == 'n' {
		segments = segments[1:]
	}
	if len(segments) != 2 || (segments[0] != "track" && segments[0] != "album" && segments[0] != "playlist") || !validSpotifyID(segments[1]) {
		return catalogInput{}, ErrCatalogInput
	}
	return catalogInput{kind: segments[0], id: segments[1]}, nil
}

// validSpotifyIntlLocale accepts Spotify's localized share-link prefix with a
// two-letter language tag and an optional two-letter uppercase region.
func validSpotifyIntlLocale(segment string) bool {
	if !strings.HasPrefix(segment, "intl-") {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(segment, "intl-"), "-")
	if len(parts) < 1 || len(parts) > 2 || len(parts[0]) != 2 {
		return false
	}
	for _, c := range parts[0] {
		if c < 'a' || c > 'z' {
			return false
		}
	}
	if len(parts) == 2 {
		if len(parts[1]) != 2 {
			return false
		}
		for _, c := range parts[1] {
			if c < 'A' || c > 'Z' {
				return false
			}
		}
	}
	return true
}

func validSpotifyID(id string) bool {
	if len(id) != maxSpotifyIDBytes {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
			return false
		}
	}
	return true
}

func validCatalogToken(token string) bool {
	if len(token) == 0 || len(token) > maxCatalogTokenBytes || strings.TrimSpace(token) != token {
		return false
	}
	for _, r := range token {
		if unicode.IsControl(r) || r == ' ' {
			return false
		}
	}
	return true
}

type spotifyArtist struct {
	Name string `json:"name"`
}
type spotifyAlbumRef struct {
	Name string `json:"name"`
}
type spotifyTrack struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Type       string          `json:"type"`
	URI        string          `json:"uri"`
	DurationMS int64           `json:"duration_ms"`
	Artists    []spotifyArtist `json:"artists"`
	Album      spotifyAlbumRef `json:"album"`
}
type spotifyAlbum struct {
	Name    string          `json:"name"`
	Artists []spotifyArtist `json:"artists"`
	Tracks  struct {
		Total int `json:"total"`
	} `json:"tracks"`
}
type spotifyTrackPage struct {
	Total int            `json:"total"`
	Items []spotifyTrack `json:"items"`
}
type spotifyPlaylistItem struct {
	Item *spotifyTrack `json:"item"`
}
type spotifyPlaylistPage struct {
	Total int                   `json:"total"`
	Items []spotifyPlaylistItem `json:"items"`
}

func (c *Catalog) getTrack(ctx context.Context, token, id string) (music.Track, error) {
	var raw spotifyTrack
	if err := c.getJSON(ctx, token, "/tracks/"+id, nil, &raw); err != nil {
		return music.Track{}, err
	}
	if raw.Type != "track" || raw.ID != id {
		return music.Track{}, ErrCatalogData
	}
	return makeCatalogTrack(raw)
}

func (c *Catalog) getAlbum(ctx context.Context, token, id string) ([]music.Track, error) {
	var album spotifyAlbum
	if err := c.getJSON(ctx, token, "/albums/"+id, nil, &album); err != nil {
		return nil, err
	}
	if !validMetadata(album.Name) || !validArtists(album.Artists) || album.Tracks.Total < 1 || album.Tracks.Total > MaxCatalogItems {
		return nil, ErrCatalogData
	}
	tracks := make([]music.Track, 0, album.Tracks.Total)
	for offset := 0; offset < album.Tracks.Total; {
		query := url.Values{"limit": {strconv.Itoa(catalogPageSize)}, "offset": {strconv.Itoa(offset)}}
		var page spotifyTrackPage
		if err := c.getJSON(ctx, token, "/albums/"+id+"/tracks", query, &page); err != nil {
			return nil, err
		}
		if page.Total != album.Tracks.Total || len(page.Items) == 0 || len(page.Items) > catalogPageSize || len(tracks)+len(page.Items) > MaxCatalogItems {
			return nil, ErrCatalogData
		}
		for _, raw := range page.Items {
			if raw.Type != "track" && raw.Type != "" {
				return nil, ErrCatalogData
			}
			raw.Type = "track"
			if raw.Album.Name == "" {
				raw.Album.Name = album.Name
			}
			track, err := makeCatalogTrack(raw)
			if err != nil {
				return nil, err
			}
			tracks = append(tracks, track)
		}
		offset += len(page.Items)
	}
	if len(tracks) != album.Tracks.Total {
		return nil, ErrCatalogData
	}
	return tracks, nil
}

func (c *Catalog) getPlaylist(ctx context.Context, token, id string) ([]music.Track, error) {
	query := url.Values{"limit": {strconv.Itoa(catalogPageSize)}, "offset": {"0"}}
	var first spotifyPlaylistPage
	if err := c.getJSON(ctx, token, "/playlists/"+id+"/items", query, &first); err != nil {
		return nil, err
	}
	if first.Total < 1 || first.Total > MaxCatalogItems || len(first.Items) == 0 || len(first.Items) > catalogPageSize {
		return nil, ErrCatalogData
	}
	tracks := make([]music.Track, 0, first.Total)
	appendPage := func(page spotifyPlaylistPage) error {
		if page.Total != first.Total || len(page.Items) == 0 || len(page.Items) > catalogPageSize || len(tracks)+len(page.Items) > MaxCatalogItems {
			return ErrCatalogData
		}
		for _, item := range page.Items {
			if item.Item == nil || item.Item.Type != "track" {
				return ErrCatalogData
			}
			track, err := makeCatalogTrack(*item.Item)
			if err != nil {
				return err
			}
			tracks = append(tracks, track)
		}
		return nil
	}
	if err := appendPage(first); err != nil {
		return nil, err
	}
	for offset := len(first.Items); offset < first.Total; {
		query.Set("offset", strconv.Itoa(offset))
		var page spotifyPlaylistPage
		if err := c.getJSON(ctx, token, "/playlists/"+id+"/items", query, &page); err != nil {
			return nil, err
		}
		if err := appendPage(page); err != nil {
			return nil, err
		}
		offset += len(page.Items)
	}
	if len(tracks) != first.Total {
		return nil, ErrCatalogData
	}
	return tracks, nil
}

func (c *Catalog) getJSON(ctx context.Context, token, path string, query url.Values, destination any) error {
	endpoint, err := url.Parse(spotifyWebAPIBase + path)
	if err != nil || endpoint.Scheme != "https" || endpoint.Host != "api.spotify.com" {
		return ErrCatalogRequest
	}
	if query != nil {
		endpoint.RawQuery = query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil || req.URL.Scheme != "https" || req.URL.Host != "api.spotify.com" {
		return ErrCatalogRequest
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return ErrCatalogRequest
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return ErrCatalogRequest
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, MaxCatalogResponseBytes+1))
	if err != nil || len(data) > MaxCatalogResponseBytes {
		return ErrCatalogData
	}
	defer clear(data)
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	if err := decoder.Decode(destination); err != nil {
		return ErrCatalogData
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return ErrCatalogData
	}
	return nil
}

func makeCatalogTrack(raw spotifyTrack) (music.Track, error) {
	if !validSpotifyID(raw.ID) || (raw.URI != "" && raw.URI != "spotify:track:"+raw.ID) ||
		!validMetadata(raw.Name) || !validArtists(raw.Artists) || raw.DurationMS < 0 || raw.DurationMS > music.MaxTrackDurationMS ||
		(raw.Album.Name != "" && !validMetadata(raw.Album.Name)) {
		return music.Track{}, ErrCatalogData
	}
	artist := raw.Artists[0].Name
	return music.Track{
		Provider:    music.ProviderSpotify,
		CanonicalID: "spotify:track:" + raw.ID,
		Title:       raw.Name, Artist: artist, Album: raw.Album.Name, DurationMS: raw.DurationMS,
	}, nil
}

func validArtists(artists []spotifyArtist) bool {
	return len(artists) > 0 && validMetadata(artists[0].Name)
}

func validMetadata(value string) bool {
	if value == "" || len(value) > maxCatalogMetadataBytes || strings.TrimSpace(value) != value {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
