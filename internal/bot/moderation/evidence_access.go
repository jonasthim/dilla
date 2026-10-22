package moderation

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

const (
	evidenceStateArea = uint64(9)
	evidenceVersion   = uint64(1)
	permViewAuditLog  = uint64(1 << 17)
	maxEvidenceBytes  = 4 << 10
)

var ErrEvidenceAccess = errors.New("moderation evidence unavailable")

type evidenceAuthorityClient interface {
	BotActorAuthority(context.Context, id.ID, id.ID) (client.ActorAuthority, bool, error)
}

// Evidence is sensitive content held only in the helper's encrypted state.
// Read access is checked against the actor's current server permissions each time.
type Evidence struct {
	ID        id.ID
	MessageID id.ID
	Action    Action
	Rule      Rule
	Excerpt   string
	CreatedAt time.Time
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
	if cborx.Unmarshal(value.Value, &row) != nil || len(row) != 10 {
		return Evidence{}, ErrEvidenceAccess
	}
	version, vok := row[0].(uint64)
	instance, iok := configID(row[1])
	community, cok := configID(row[2])
	installation, inok := configID(row[3])
	storedID, eok := configID(row[4])
	messageID, mok := configID(row[5])
	actionText, aok := row[6].(string)
	ruleText, rok := row[7].(string)
	excerpt, xok := row[8].(string)
	created, tok := row[9].(uint64)
	if !vok || version != evidenceVersion || !iok || !cok || !inok || !eok || !mok ||
		instance != r.binding.Instance || community != r.binding.Community || installation != r.binding.Installation || storedID != evidenceID ||
		!aok || !rok || !validEvidenceAction(Action(actionText)) || !validRule(Rule(ruleText)) || !xok || len(excerpt) > ExcerptMaxBytes || !tok || created == 0 || created > uint64(^uint64(0)>>1) {
		return Evidence{}, ErrEvidenceAccess
	}
	return Evidence{ID: storedID, MessageID: messageID, Action: Action(actionText), Rule: Rule(ruleText), Excerpt: excerpt,
		CreatedAt: time.Unix(int64(created), 0).UTC()}, nil
}

func validEvidenceAction(action Action) bool {
	return action == ActionRemove || action == ActionWarn || action == ActionTimeout
}

func evidenceKey(binding native.Binding, evidenceID id.ID) []byte {
	return []byte(fmt.Sprintf("dilla.bot.moderation.evidence.v1/%x/%x/%x/%x", binding.Instance, binding.Community, binding.Installation, evidenceID))
}
