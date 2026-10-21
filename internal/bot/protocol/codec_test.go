package protocol

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
)

func fixtureID(n byte) id.ID {
	var v id.ID
	v[15] = n
	return v
}

type vectorCorpus struct {
	Version int          `json:"version"`
	Cases   []vectorCase `json:"cases"`
	Rejects []vectorCase `json:"rejects"`
}
type vectorCase struct {
	Name        string         `json:"name"`
	Kind        string         `json:"kind"`
	Hex         string         `json:"hex"`
	Body        string         `json:"body"`
	PreimageHex string         `json:"preimage_hex"`
	Context     *vectorContext `json:"context"`
}
type vectorContext struct {
	Community   string `json:"community"`
	Group       string `json:"group"`
	ActorUser   string `json:"actor_user"`
	ActorDevice string `json:"actor_device"`
	Now         string `json:"now"`
}

func TestSharedBotVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "protocol", "vectors", "bot.json"))
	if err != nil {
		t.Fatal(err)
	}
	var corpus vectorCorpus
	if err := json.Unmarshal(data, &corpus); err != nil {
		t.Fatal(err)
	}
	if corpus.Version != 1 || len(corpus.Cases) == 0 || len(corpus.Rejects) == 0 {
		t.Fatalf("invalid vector corpus metadata: version=%d cases=%d rejects=%d", corpus.Version, len(corpus.Cases), len(corpus.Rejects))
	}
	for _, tc := range corpus.Cases {
		t.Run("accept/"+tc.Name, func(t *testing.T) {
			raw, err := hex.DecodeString(tc.Hex)
			if err != nil {
				t.Fatal(err)
			}
			canonical := roundTripVector(t, tc, raw)
			if !bytes.Equal(canonical, raw) {
				t.Fatalf("roundtrip bytes differ: %x != %x", canonical, raw)
			}
			if tc.PreimageHex != "" {
				proof, err := DecodeRemovalProof(raw)
				if err != nil {
					t.Fatal(err)
				}
				pre, err := RemovalPreimage(proof)
				if err != nil {
					t.Fatal(err)
				}
				want, _ := hex.DecodeString(tc.PreimageHex)
				if !bytes.Equal(pre, want) {
					t.Fatalf("preimage differs: %x != %x", pre, want)
				}
			}
		})
	}
	for _, tc := range corpus.Rejects {
		t.Run("reject/"+tc.Name, func(t *testing.T) {
			raw, err := hex.DecodeString(tc.Hex)
			if err != nil {
				t.Fatal(err)
			}
			if tc.Kind == "helper_request" && tc.Name == "helper malformed length prefix" {
				if _, err := DecodeHelperRequestFrame(raw); err == nil {
					t.Fatal("accepted malformed frame")
				}
				return
			}
			if tc.Body != "" {
				_, err = decodeBody(tc.Body)
			} else {
				_, err = roundTripVectorErr(tc, raw)
			}
			if err == nil && tc.Context != nil {
				err = validateVectorContext(tc, raw)
			}
			if err == nil {
				t.Fatal("accepted reject vector")
			}
		})
	}
}

func roundTripVector(t *testing.T, tc vectorCase, raw []byte) []byte {
	t.Helper()
	var got []byte
	var err error
	switch tc.Kind {
	case "request":
		var v Request
		if tc.Body != "" {
			v, err = DecodeRequest(tc.Body)
		} else {
			v, err = DecodeRequestCBOR(raw)
		}
		if err == nil {
			got, err = EncodeRequestCBOR(v)
			if err == nil && tc.Body != "" {
				body, e := EncodeRequest(v)
				if e != nil || body != tc.Body {
					t.Fatalf("body roundtrip mismatch: %q %v", body, e)
				}
			}
		}
	case "response":
		var v Response
		if tc.Body != "" {
			v, err = DecodeResponse(tc.Body)
		} else {
			v, err = DecodeResponseCBOR(raw)
		}
		if err == nil {
			got, err = EncodeResponseCBOR(v)
		}
	case "removal":
		var v RemovalProof
		v, err = DecodeRemovalProof(raw)
		if err == nil {
			got, err = encodeRemoval(v)
		}
	case "event":
		var v Event
		v, err = DecodeEvent(raw)
		if err == nil {
			got, err = EncodeEvent(v)
		}
	case "receipt":
		var v SendReceipt
		v, err = DecodeReceipt(raw)
		if err == nil {
			got, err = EncodeReceipt(v)
		}
	case "helper_request":
		var v HelperRequest
		v, err = DecodeHelperRequestCBOR(raw)
		if err == nil {
			got, err = EncodeHelperRequestCBOR(v)
		}
	case "helper_response":
		var v HelperResponse
		v, err = DecodeHelperResponseCBOR(raw)
		if err == nil {
			got, err = EncodeHelperResponseCBOR(v)
		}
	default:
		t.Fatalf("unknown vector kind %q", tc.Kind)
	}
	if err != nil {
		t.Fatal(err)
	}
	if tc.Context != nil {
		if err := validateVectorContext(tc, raw); err != nil {
			t.Fatal(err)
		}
	}
	return got
}

func roundTripVectorErr(tc vectorCase, raw []byte) ([]byte, error) {
	switch tc.Kind {
	case "request":
		if tc.Body != "" {
			v, e := DecodeRequest(tc.Body)
			if e != nil {
				return nil, e
			}
			return EncodeRequestCBOR(v)
		}
		v, e := DecodeRequestCBOR(raw)
		if e != nil {
			return nil, e
		}
		return EncodeRequestCBOR(v)
	case "response":
		v, e := DecodeResponseCBOR(raw)
		if e != nil {
			return nil, e
		}
		return EncodeResponseCBOR(v)
	case "removal":
		v, e := DecodeRemovalProof(raw)
		if e != nil {
			return nil, e
		}
		return encodeRemoval(v)
	case "event":
		v, e := DecodeEvent(raw)
		if e != nil {
			return nil, e
		}
		return EncodeEvent(v)
	case "receipt":
		v, e := DecodeReceipt(raw)
		if e != nil {
			return nil, e
		}
		return EncodeReceipt(v)
	case "helper_request":
		v, e := DecodeHelperRequestCBOR(raw)
		if e != nil {
			return nil, e
		}
		return EncodeHelperRequestCBOR(v)
	case "helper_response":
		v, e := DecodeHelperResponseCBOR(raw)
		if e != nil {
			return nil, e
		}
		return EncodeHelperResponseCBOR(v)
	default:
		return nil, invalid()
	}
}

func validateVectorContext(tc vectorCase, raw []byte) error {
	c := tc.Context
	community, e := id.Parse(c.Community)
	if e != nil {
		return e
	}
	now, e := strconv.ParseUint(c.Now, 10, 64)
	if e != nil {
		return e
	}
	switch tc.Kind {
	case "request":
		v, e := DecodeRequestCBOR(raw)
		if e != nil {
			return e
		}
		return ValidateRequestContext(v, community, now)
	case "response":
		v, e := DecodeResponseCBOR(raw)
		if e != nil {
			return e
		}
		return ValidateResponseContext(v, community)
	case "event":
		v, e := DecodeEvent(raw)
		if e != nil {
			return e
		}
		return ValidateEventContext(v, community)
	case "receipt":
		v, e := DecodeReceipt(raw)
		if e != nil {
			return e
		}
		g, e := id.Parse(c.Group)
		if e != nil {
			return e
		}
		return ValidateReceiptContext(v, community, g)
	case "removal":
		v, e := DecodeRemovalProof(raw)
		if e != nil {
			return e
		}
		g, e := id.Parse(c.Group)
		if e != nil {
			return e
		}
		u, e := id.Parse(c.ActorUser)
		if e != nil {
			return e
		}
		d, e := id.Parse(c.ActorDevice)
		if e != nil {
			return e
		}
		return ValidateRemovalContext(v, community, g, u, d, now)
	default:
		return nil
	}
}

func TestRequestRoundTripAndContext(t *testing.T) {
	req := Request{RequestID: fixtureID(1), CommunityID: fixtureID(2), ChannelID: ptrID(fixtureID(3)), Operation: OpMusicSeek, Revision: u64(8), Expires: u64(30), Args: []any{uint64(math.MaxUint64)}}
	body, err := EncodeRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodeRequest(body)
	if err != nil {
		t.Fatal(err)
	}
	if got.Operation != req.Operation || got.Args[0] != uint64(math.MaxUint64) {
		t.Fatalf("round trip mismatch: %#v", got)
	}
	if err := ValidateRequestContext(got, fixtureID(2), 10); err != nil {
		t.Fatal(err)
	}
	if err := ValidateRequestContext(got, fixtureID(3), 10); !errors.Is(err, ErrContext) {
		t.Fatalf("wrong community: %v", err)
	}
	if err := ValidateRequestContext(got, fixtureID(2), 30); !errors.Is(err, ErrExpired) {
		t.Fatalf("expiry boundary: %v", err)
	}
}

func TestRequestRejectsArrayForByteStringAndNoncanonicalBody(t *testing.T) {
	// [1, request, community, null, settings.put, 1, 20, [section, bstr]]
	// document is deliberately an array rather than a byte string.
	raw, _ := hex.DecodeString("880150000000000000000000000000000000015000000000000000000000000000000002f60201f614820180")
	if _, err := DecodeRequestCBOR(raw); err == nil {
		t.Fatal("accepted array where document bstr is required")
	}
	if _, err := DecodeRequest("dilla.bot/1:AA=="); err == nil {
		t.Fatal("accepted padded base64url")
	}
}

func TestRemovalPreimage(t *testing.T) {
	p := RemovalProof{RequestID: fixtureID(1), ActorUser: fixtureID(2), ActorDevice: fixtureID(3), CommunityID: fixtureID(4), GroupID: fixtureID(5), TargetSequence: 6, Expires: 7}
	preimage, err := RemovalPreimage(p)
	if err != nil {
		t.Fatal(err)
	}
	if string(preimage[:len(removalDomain)]) != removalDomain {
		t.Fatalf("wrong domain prefix: %x", preimage)
	}
	got, err := DecodeRemovalProof(preimage[len(removalDomain):])
	if err != nil || got.TargetSequence != 6 {
		t.Fatalf("decode: %#v %v", got, err)
	}
}

func TestEventReceiptAndHelperRoundTrips(t *testing.T) {
	event := Event{ID: fixtureID(1), Sequence: 2, CommunityID: fixtureID(3), Timestamp: 4, Kind: EventMemberJoin, Data: []any{fixtureID(4), fixtureID(5)}}
	eb, err := EncodeEvent(event)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeEvent(eb); err != nil {
		t.Fatal(err)
	}
	receipt := SendReceipt{OperationID: fixtureID(1), CommunityID: fixtureID(2), GroupID: fixtureID(3), CiphertextHash: make([]byte, 32), Status: ReceiptPending}
	rb, err := EncodeReceipt(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeReceipt(rb); err != nil {
		t.Fatal(err)
	}
	request := HelperRequest{RequestID: fixtureID(1), Operation: HelperOpen, Payload: []any{}}
	frame, err := EncodeHelperRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	got, err := DecodeHelperRequestFrame(frame)
	if err != nil || got.Operation != HelperOpen {
		t.Fatalf("helper: %#v %v", got, err)
	}
	frame[len(frame)-1] ^= 1
	if _, err := DecodeHelperRequestFrame(frame); err == nil {
		t.Fatal("accepted mismatched helper frame")
	}
}

func TestEveryRequestOperationShape(t *testing.T) {
	tests := []struct {
		name         string
		op           Operation
		args         []any
		mut, channel bool
	}{
		{"overview", OpOverviewGet, nil, false, false},
		{"settings_get", OpSettingsGet, []any{uint64(5)}, false, false},
		{"settings_put", OpSettingsPut, []any{uint64(0), []byte{0x80}}, true, false},
		{"music_state", OpMusicState, nil, false, true},
		{"music_search", OpMusicSearch, []any{"query"}, false, true},
		{"music_enqueue", OpMusicEnqueue, []any{"input"}, true, true},
		{"music_pause", OpMusicPause, nil, true, true},
		{"music_resume", OpMusicResume, nil, true, true},
		{"music_skip", OpMusicSkip, nil, true, true},
		{"music_stop", OpMusicStop, nil, true, true},
		{"music_seek", OpMusicSeek, []any{uint64(math.MaxUint64)}, true, true},
		{"music_volume", OpMusicVolume, []any{uint64(100)}, true, true},
		{"music_shuffle", OpMusicShuffle, nil, true, true},
		{"music_repeat", OpMusicRepeat, []any{uint64(2)}, true, true},
		{"music_remove", OpMusicRemove, []any{fixtureID(7)}, true, true},
		{"music_move", OpMusicMove, []any{fixtureID(7), nil}, true, true},
		{"music_clear", OpMusicClear, nil, true, true},
		{"welcome_preview", OpWelcomePreview, []any{"hello"}, false, false},
		{"roles_list", OpRolesList, []any{uint64(0)}, false, false},
		{"announcements_list", OpAnnouncementsList, []any{uint64(0)}, false, false},
		{"announcements_put", OpAnnouncementsPut, []any{nil, []byte{0x80}}, true, false},
		{"announcements_delete", OpAnnouncementsDelete, []any{fixtureID(8)}, true, false},
		{"moderation_cases", OpModerationCases, []any{uint64(0)}, false, false},
		{"moderation_evidence", OpModerationEvidence, []any{fixtureID(9), "", "excerpt"}, true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := Request{RequestID: fixtureID(1), CommunityID: fixtureID(2), Operation: tt.op, Args: tt.args}
			if tt.channel {
				r.ChannelID = ptrID(fixtureID(3))
			}
			if tt.mut {
				r.Revision, r.Expires = u64(4), u64(30)
			}
			body, err := EncodeRequest(r)
			if err != nil {
				t.Fatal(err)
			}
			got, err := DecodeRequest(body)
			if err != nil {
				t.Fatal(err)
			}
			if got.Operation != tt.op {
				t.Fatalf("operation = %d", got.Operation)
			}
		})
	}
}

func TestEveryEventKindRoundTrips(t *testing.T) {
	tests := []Event{
		{ID: fixtureID(1), Sequence: 1, CommunityID: fixtureID(2), Kind: EventMemberJoin, Data: []any{fixtureID(3), fixtureID(4)}},
		{ID: fixtureID(1), Sequence: 1, CommunityID: fixtureID(2), Kind: EventMemberLeave, Data: []any{fixtureID(3), fixtureID(4)}},
		{ID: fixtureID(1), Sequence: 1, CommunityID: fixtureID(2), Kind: EventInstallation, Data: []any{fixtureID(3), uint64(5), uint64(math.MaxUint64)}},
		{ID: fixtureID(1), Sequence: 1, CommunityID: fixtureID(2), Kind: EventPermission, Data: []any{uint64(3), fixtureID(3), uint64(1)}},
		{ID: fixtureID(1), Sequence: 1, CommunityID: fixtureID(2), Kind: EventChannel, Data: []any{fixtureID(3), uint64(2), uint64(1)}},
		{ID: fixtureID(1), Sequence: 1, CommunityID: fixtureID(2), Kind: EventModeration, Data: []any{fixtureID(3), fixtureID(4), fixtureID(5), fixtureID(6), nil, fixtureID(7), uint64(8), uint64(4), nil}},
		{ID: fixtureID(1), Sequence: 1, CommunityID: fixtureID(2), Kind: EventRolePanel, Data: []any{fixtureID(3), uint64(1), uint64(1)}},
	}
	for _, ev := range tests {
		raw, err := EncodeEvent(ev)
		if err != nil {
			t.Fatalf("kind %d encode: %v", ev.Kind, err)
		}
		got, err := DecodeEvent(raw)
		if err != nil || got.Kind != ev.Kind {
			t.Fatalf("kind %d decode: %#v %v", ev.Kind, got, err)
		}
	}
}

func TestContextRejectsFarFutureAndOverflow(t *testing.T) {
	r := Request{CommunityID: fixtureID(2), RequestID: fixtureID(1), Operation: OpMusicPause, ChannelID: ptrID(fixtureID(3)), Revision: u64(1), Expires: u64(41)}
	if err := ValidateRequestContext(r, fixtureID(2), 10); !errors.Is(err, ErrExpired) {
		t.Fatalf("far future: %v", err)
	}
	r.Expires = u64(math.MaxUint64)
	if err := ValidateRequestContext(r, fixtureID(2), math.MaxUint64-10); !errors.Is(err, ErrExpired) {
		t.Fatalf("overflow: %v", err)
	}
}
