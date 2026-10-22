package moderation

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

const (
	evidenceStateArea      = uint64(9)
	evidenceVersion        = uint64(1)
	permViewAuditLog       = uint64(1 << 17)
	maxEvidenceBytes       = 4 << 10
	MaxEvidenceReasonBytes = 1024
	EvidenceRetention      = 90 * 24 * time.Hour
)

var (
	ErrEvidenceAccess   = errors.New("moderation evidence unavailable")
	ErrEvidenceWrite    = errors.New("moderation evidence could not be stored")
	ErrEvidenceConflict = errors.New("moderation evidence operation conflict")
)

type evidenceAuthorityClient interface {
	BotActorAuthority(context.Context, id.ID, id.ID) (client.ActorAuthority, bool, error)
}

// Evidence is sensitive content held only in the helper's encrypted state.
// Read access is checked against the actor's current server permissions each time.
type Evidence struct {
	ID          id.ID
	OperationID id.ID
	MessageID   id.ID
	Action      Action
	Rule        Rule
	Reason      string
	Excerpt     string
	CreatedAt   time.Time
	ExpiresAt   time.Time
}

// EvidenceInput supports message-linked actions only and must represent an
// authoritative accepted moderation action. Manual cases without a message
// target are unsupported. Callers must not construct it from an unverified request.
type EvidenceInput struct {
	OperationID id.ID
	MessageID   id.ID
	Action      Action
	Rule        Rule
	Reason      string
	Excerpt     string
	CreatedAt   time.Time
}

// EvidenceWriter stores evidence under the installation's encrypted app state.
type EvidenceWriter struct {
	state   configStateClient
	binding native.Binding
}

func NewEvidenceWriter(state configStateClient) *EvidenceWriter {
	if state == nil {
		return &EvidenceWriter{}
	}
	return &EvidenceWriter{state: state, binding: state.Binding()}
}

// Save is idempotent by OperationID. The record expires no later than 90 days
// after CreatedAt; retries with different contents under the same ID conflict.
func (w *EvidenceWriter) Save(ctx context.Context, input EvidenceInput) error {
	if w == nil || w.state == nil || !validConfigBinding(w.binding) || input.OperationID.IsZero() || input.MessageID.IsZero() ||
		!validEvidenceAction(input.Action) || !validRule(input.Rule) || len(input.Reason) == 0 || len(input.Reason) > MaxEvidenceReasonBytes ||
		strings.TrimSpace(input.Reason) == "" || !utf8.ValidString(input.Reason) || len(input.Excerpt) > ExcerptMaxBytes || !utf8.ValidString(input.Excerpt) || input.CreatedAt.IsZero() {
		return ErrEvidenceWrite
	}
	now := time.Now().UTC()
	created := input.CreatedAt.UTC().Truncate(time.Second)
	if !withinEvidenceRetention(input.CreatedAt, now) {
		return ErrEvidenceWrite
	}
	input.CreatedAt = created
	body, err := encodeEvidence(w.binding, input)
	if err != nil || len(body) > maxEvidenceBytes {
		return ErrEvidenceWrite
	}
	key := evidenceKey(w.binding, input.OperationID)
	current, err := w.state.StateGet(ctx, evidenceStateArea, key)
	if err != nil {
		return ErrEvidenceWrite
	}
	if current.Revision != 0 {
		if evidenceMatches(current, w.binding, input) {
			return nil
		}
		return ErrEvidenceConflict
	}
	_, err = w.state.StateTransaction(ctx, input.OperationID, []native.StateChange{{Area: evidenceStateArea, Key: key, ExpectedRevision: 0, Value: body}})
	if err == nil {
		return nil
	}
	// A lost response or concurrent retry may have committed. Resolve by reading
	// the same operation key; never expose helper errors that can carry plaintext.
	current, readErr := w.state.StateGet(ctx, evidenceStateArea, key)
	if readErr == nil && current.Revision != 0 && evidenceMatches(current, w.binding, input) {
		return nil
	}
	return ErrEvidenceConflict
}

func withinEvidenceRetention(createdAt, now time.Time) bool {
	if createdAt.IsZero() {
		return false
	}
	age := now.UTC().Sub(createdAt.UTC())
	return age <= EvidenceRetention && age >= -5*time.Minute
}

// EvidenceReader reads one installation-bound evidence item after resolving
// the requesting actor's current view_audit_log permission from the server.
type EvidenceReader struct {
	state     configStateClient
	authority evidenceAuthorityClient
	binding   native.Binding
}

func NewEvidenceReader(state configStateClient, authority evidenceAuthorityClient) *EvidenceReader {
	if state == nil {
		return &EvidenceReader{}
	}
	return &EvidenceReader{state: state, authority: authority, binding: state.Binding()}
}

// Read performs a fresh authority lookup before touching encrypted state.
// Any missing dependency, lookup failure, absent actor, or permission denial
// returns the same unavailable error so callers cannot infer evidence metadata.
func (r *EvidenceReader) Read(ctx context.Context, actor, evidenceID id.ID) (Evidence, error) {
	if r == nil || r.state == nil || r.authority == nil || !validConfigBinding(r.binding) || actor.IsZero() || evidenceID.IsZero() {
		return Evidence{}, ErrEvidenceAccess
	}
	resolved, present, err := r.authority.BotActorAuthority(ctx, r.binding.Community, actor)
	if err != nil || !present || resolved.EffectiveBits&permViewAuditLog == 0 {
		return Evidence{}, ErrEvidenceAccess
	}
	value, err := r.state.StateGet(ctx, evidenceStateArea, evidenceKey(r.binding, evidenceID))
	if err != nil || value.Tombstone || value.Revision == 0 || len(value.Value) == 0 || len(value.Value) > maxEvidenceBytes || cborx.ExpectMajor(value.Value, cborx.MajorArray) != nil {
		return Evidence{}, ErrEvidenceAccess
	}
	var row []any
	if cborx.Unmarshal(value.Value, &row) != nil || len(row) != 13 {
		return Evidence{}, ErrEvidenceAccess
	}
	version, vok := row[0].(uint64)
	instance, iok := configID(row[1])
	community, cok := configID(row[2])
	installation, inok := configID(row[3])
	operationID, ook := configID(row[4])
	storedID, eok := configID(row[5])
	messageID, mok := configID(row[6])
	actionText, aok := row[7].(string)
	ruleText, rok := row[8].(string)
	reason, nok := row[9].(string)
	excerpt, xok := row[10].(string)
	created, tok := row[11].(uint64)
	expires, exok := row[12].(uint64)
	if !vok || version != evidenceVersion || !iok || !cok || !inok || !eok || !mok ||
		!ook || instance != r.binding.Instance || community != r.binding.Community || installation != r.binding.Installation || storedID != evidenceID || operationID != evidenceID ||
		instance.IsZero() || messageID.IsZero() || !aok || !rok || !validEvidenceAction(Action(actionText)) || !validRule(Rule(ruleText)) || !nok || len(reason) == 0 || len(reason) > MaxEvidenceReasonBytes || !utf8.ValidString(reason) || !xok || len(excerpt) > ExcerptMaxBytes || !utf8.ValidString(excerpt) || !tok || !exok || created == 0 || created > uint64(^uint64(0)>>1) {
		return Evidence{}, ErrEvidenceAccess
	}
	createdAt := time.Unix(int64(created), 0).UTC()
	expiresAt := createdAt.Add(EvidenceRetention)
	if expires != uint64(expiresAt.Unix()) || !time.Now().UTC().Before(expiresAt) {
		return Evidence{}, ErrEvidenceAccess
	}
	return Evidence{ID: storedID, OperationID: operationID, MessageID: messageID, Action: Action(actionText), Rule: Rule(ruleText), Reason: reason, Excerpt: excerpt,
		CreatedAt: createdAt, ExpiresAt: expiresAt}, nil
}

func encodeEvidence(binding native.Binding, input EvidenceInput) ([]byte, error) {
	expires := input.CreatedAt.Add(EvidenceRetention)
	return cborx.Marshal([]any{evidenceVersion, binding.Instance, binding.Community, binding.Installation, input.OperationID, input.OperationID,
		input.MessageID, string(input.Action), string(input.Rule), input.Reason, input.Excerpt, uint64(input.CreatedAt.Unix()), uint64(expires.Unix())})
}

func evidenceMatches(value native.StateValue, binding native.Binding, input EvidenceInput) bool {
	if value.Tombstone || value.Revision == 0 || len(value.Value) == 0 || len(value.Value) > maxEvidenceBytes {
		return false
	}
	var row []any
	if cborx.Unmarshal(value.Value, &row) != nil || len(row) != 13 {
		return false
	}
	instance, iok := configID(row[1])
	community, cok := configID(row[2])
	installation, inok := configID(row[3])
	operation, ook := configID(row[4])
	storedID, eok := configID(row[5])
	message, mok := configID(row[6])
	created, tok := row[11].(uint64)
	expires, exok := row[12].(uint64)
	return iok && cok && inok && ook && eok && mok && tok && exok &&
		instance == binding.Instance && community == binding.Community && installation == binding.Installation &&
		operation == input.OperationID && storedID == input.OperationID && message == input.MessageID &&
		row[0] == evidenceVersion && row[7] == string(input.Action) && row[8] == string(input.Rule) &&
		row[9] == input.Reason && row[10] == input.Excerpt && created == uint64(input.CreatedAt.Unix()) && expires == uint64(input.CreatedAt.Add(EvidenceRetention).Unix())
}

func validEvidenceAction(action Action) bool {
	return action == ActionRemove || action == ActionWarn || action == ActionTimeout
}

func evidenceKey(binding native.Binding, evidenceID id.ID) []byte {
	return []byte(fmt.Sprintf("dilla.bot.moderation.evidence.v1/%x/%x/%x/%x", binding.Instance, binding.Community, binding.Installation, evidenceID))
}
