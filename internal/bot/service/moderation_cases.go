package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jonasthim/dilla/internal/bot/moderation"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

const (
	moderationCaseStateArea   = uint64(4)
	moderationPurgeCursorArea = uint64(8)
	moderationCaseVersion     = uint64(1)
	moderationCaseRetention   = 90 * 24 * time.Hour
	moderationCaseScanLimit   = uint64(100)
	moderationCaseMaxValue    = 16 << 10
	moderationCaseMaxCursor   = 128
)

var moderationPurgeCursorKey = []byte("dilla.bot.moderation.purge-cursor.v1")

var (
	ErrModerationCaseState              = errors.New("invalid moderation case state")
	ErrModerationCaseConflict           = errors.New("moderation case conflicts with existing source revision")
	ErrModerationCaseBinding            = errors.New("moderation case belongs to another installation or community")
	ErrModerationEnforcementUnavailable = errors.New("moderation enforcement backend unavailable")
)

type moderationCaseNative interface {
	Binding() native.Binding
	StateGet(context.Context, uint64, []byte) (native.StateValue, error)
	StateScan(context.Context, uint64, []byte, uint64) (native.StatePage, error)
	StateTransaction(context.Context, id.ID, []native.StateChange) ([]uint64, error)
}

// ModerationEnforcementBackend must apply an action idempotently by source
// message and revision. That lets a retry recover after an uncertain helper
// response without repeating the enforcement effect.
type ModerationEnforcementBackend interface {
	EnforceModerationAction(context.Context, ModerationAction) error
}

// ModerationCase is an installation-bound record stored in encrypted helper
// app state. Excerpt is retained only as a bounded, explicitly supplied preview.
type ModerationCase struct {
	Community, Channel, Actor, Message string
	SourceRevision                     uint64
	Rules                              []moderation.Rule
	Action                             moderation.Action
	Timeout                            time.Duration
	Excerpt                            string
	ReceivedAt                         time.Time
}

// Reason is deterministic from the matched rules and contains no message text.
func (c ModerationCase) Reason() string {
	if len(c.Rules) == 0 {
		return "automatic moderation"
	}
	rules := make([]string, len(c.Rules))
	for i, rule := range c.Rules {
		rules[i] = string(rule)
	}
	sort.Strings(rules)
	return "automatic moderation: " + strings.Join(rules, ", ")
}

// ModerationCaseSink stores one case per source message revision. Non-log
// actions require a real enforcement backend and are stored only after it
// reports success.
type ModerationCaseSink struct {
	native  moderationCaseNative
	backend ModerationEnforcementBackend
	binding native.Binding
	now     func() time.Time
}

func NewModerationCaseSink(n moderationCaseNative, backend ModerationEnforcementBackend, now func() time.Time) (*ModerationCaseSink, error) {
	if now == nil {
		now = time.Now
	}
	if n == nil {
		return nil, ErrModerationCaseState
	}
	b := n.Binding()
	if b.Instance.IsZero() || b.Community.IsZero() || b.Installation.IsZero() {
		return nil, ErrModerationCaseBinding
	}
	return &ModerationCaseSink{native: n, backend: backend, binding: b, now: now}, nil
}

func (s *ModerationCaseSink) ApplyModerationAction(ctx context.Context, action ModerationAction) error {
	if s == nil || ctx == nil {
		return ErrModerationCaseState
	}
	row, err := s.makeCase(action)
	if err != nil {
		return err
	}
	key := moderationCaseKey(row.Message, row.SourceRevision)
	encoded, err := encodeModerationCase(row, s.binding)
	if err != nil {
		return err
	}
	current, err := s.native.StateGet(ctx, moderationCaseStateArea, key)
	if err != nil {
		return err
	}
	if current.Revision > 0 && !current.Tombstone {
		if err := s.matchExisting(current.Value, encoded); err != nil {
			return err
		}
		return nil
	}
	if action.Decision.Action != moderation.ActionLog {
		if s.backend == nil {
			return ErrModerationEnforcementUnavailable
		}
		if err = s.backend.EnforceModerationAction(ctx, action); err != nil {
			return err
		}
	}
	if _, err = s.native.StateTransaction(ctx, id.New(), []native.StateChange{{Area: moderationCaseStateArea, Key: key,
		ExpectedRevision: current.Revision, Value: encoded}}); err == nil {
		return nil
	}
	// Helper responses may be lost after commit. A lookup distinguishes that
	// case from a real write failure without recording message contents in logs.
	actual, readErr := s.native.StateGet(ctx, moderationCaseStateArea, key)
	if readErr == nil && actual.Revision > 0 && !actual.Tombstone {
		if matchErr := s.matchExisting(actual.Value, encoded); matchErr == nil {
			return nil
		} else if errors.Is(matchErr, ErrModerationCaseConflict) {
			return matchErr
		}
	}
	return err
}

func (s *ModerationCaseSink) makeCase(a ModerationAction) (ModerationCase, error) {
	if a.Community != s.binding.Community.String() || a.SourceRevision == 0 || a.ReceivedAt.IsZero() || a.ReceivedAt.UnixMilli() <= 0 || a.ReceivedAt.UnixMilli() > math.MaxInt64 || a.ReceivedAt.After(s.now().Add(time.Minute)) ||
		!validModerationCaseID(a.Channel) || !validModerationCaseID(a.Actor) || !validModerationCaseID(a.Message) || len(a.Decision.Rules) == 0 {
		return ModerationCase{}, ErrModerationCaseState
	}
	if a.Decision.Action != moderation.ActionLog && a.Decision.Action != moderation.ActionRemove && a.Decision.Action != moderation.ActionWarn && a.Decision.Action != moderation.ActionTimeout {
		return ModerationCase{}, ErrModerationCaseState
	}
	rules := make([]moderation.Rule, 0, len(a.Decision.Rules))
	seen := map[moderation.Rule]bool{}
	for _, rule := range a.Decision.Rules {
		if rule != moderation.RuleRate && rule != moderation.RuleDuplicate && rule != moderation.RuleMentions {
			return ModerationCase{}, ErrModerationCaseState
		}
		if !seen[rule] {
			seen[rule] = true
			rules = append(rules, rule)
		}
	}
	if a.Decision.Action == moderation.ActionTimeout && (a.Decision.Timeout <= 0 || a.Decision.Timeout > moderation.MaxTimeout) {
		return ModerationCase{}, ErrModerationCaseState
	}
	if a.Decision.Action != moderation.ActionTimeout && a.Decision.Timeout != 0 {
		return ModerationCase{}, ErrModerationCaseState
	}
	return ModerationCase{Community: a.Community, Channel: a.Channel, Actor: a.Actor, Message: a.Message, SourceRevision: a.SourceRevision,
		Rules: rules, Action: a.Decision.Action, Timeout: a.Decision.Timeout, Excerpt: moderation.Excerpt(a.Excerpt), ReceivedAt: a.ReceivedAt}, nil
}

func validModerationCaseID(value string) bool {
	if value == "" || len(value) > 128 || strings.ContainsAny(value, "\x00\r\n") {
		return false
	}
	return utf8.ValidString(value)
}

func moderationCaseKey(message string, revision uint64) []byte {
	base, _ := cborx.Marshal([]any{message, revision})
	sum := sha256.Sum256(base)
	return []byte("mc1-" + hex.EncodeToString(sum[:]))
}

func encodeModerationCase(c ModerationCase, b native.Binding) ([]byte, error) {
	rules := make([]any, len(c.Rules))
	for i, rule := range c.Rules {
		rules[i] = string(rule)
	}
	raw, err := cborx.Marshal([]any{moderationCaseVersion, b.Instance, b.Community, b.Installation, c.Community, c.Channel, c.Actor, c.Message,
		c.SourceRevision, rules, string(c.Action), uint64(c.Timeout / time.Millisecond), c.Excerpt, uint64(c.ReceivedAt.UnixMilli())})
	if err != nil || len(raw) > moderationCaseMaxValue {
		return nil, ErrModerationCaseState
	}
	return raw, nil
}

func decodeModerationCase(raw []byte, binding native.Binding) (ModerationCase, error) {
	var a []any
	if len(raw) == 0 || len(raw) > moderationCaseMaxValue || cborx.CheckDeterministic(raw) != nil || cborx.Unmarshal(raw, &a) != nil || len(a) != 14 || a[0] != moderationCaseVersion {
		return ModerationCase{}, ErrModerationCaseState
	}
	instance, iok := moderationCaseID(a[1])
	community, cok := moderationCaseID(a[2])
	installation, nok := moderationCaseID(a[3])
	if !iok || !cok || !nok {
		return ModerationCase{}, ErrModerationCaseState
	}
	if instance != binding.Instance || community != binding.Community || installation != binding.Installation {
		return ModerationCase{}, ErrModerationCaseBinding
	}
	str := func(i int) (string, bool) { v, ok := a[i].(string); return v, ok && validModerationCaseID(v) }
	c := ModerationCase{}
	var ok bool
	if c.Community, ok = str(4); !ok || c.Community != binding.Community.String() {
		return ModerationCase{}, ErrModerationCaseBinding
	}
	if c.Channel, ok = str(5); !ok {
		return ModerationCase{}, ErrModerationCaseState
	}
	if c.Actor, ok = str(6); !ok {
		return ModerationCase{}, ErrModerationCaseState
	}
	if c.Message, ok = str(7); !ok {
		return ModerationCase{}, ErrModerationCaseState
	}
	var uok bool
	if c.SourceRevision, uok = a[8].(uint64); !uok || c.SourceRevision == 0 {
		return ModerationCase{}, ErrModerationCaseState
	}
	arr, ok := a[9].([]any)
	if !ok || len(arr) == 0 || len(arr) > 3 {
		return ModerationCase{}, ErrModerationCaseState
	}
	seen := map[moderation.Rule]bool{}
	for _, item := range arr {
		v, ok := item.(string)
		rule := moderation.Rule(v)
		if !ok || (rule != moderation.RuleRate && rule != moderation.RuleDuplicate && rule != moderation.RuleMentions) || seen[rule] {
			return ModerationCase{}, ErrModerationCaseState
		}
		seen[rule] = true
		c.Rules = append(c.Rules, rule)
	}
	action, ok := a[10].(string)
	c.Action = moderation.Action(action)
	if !ok || (c.Action != moderation.ActionLog && c.Action != moderation.ActionRemove && c.Action != moderation.ActionWarn && c.Action != moderation.ActionTimeout) {
		return ModerationCase{}, ErrModerationCaseState
	}
	ms, ok := a[11].(uint64)
	if !ok || ms > uint64(moderation.MaxTimeout/time.Millisecond) || c.Action == moderation.ActionTimeout && ms == 0 || c.Action != moderation.ActionTimeout && ms != 0 {
		return ModerationCase{}, ErrModerationCaseState
	}
	c.Timeout = time.Duration(ms) * time.Millisecond
	if c.Excerpt, ok = a[12].(string); !ok || !utf8.ValidString(c.Excerpt) || len(c.Excerpt) > moderation.ExcerptMaxBytes {
		return ModerationCase{}, ErrModerationCaseState
	}
	timestamp, ok := a[13].(uint64)
	if !ok || timestamp == 0 || timestamp > math.MaxInt64 {
		return ModerationCase{}, ErrModerationCaseState
	}
	c.ReceivedAt = time.UnixMilli(int64(timestamp))
	return c, nil
}

func moderationCaseID(v any) (id.ID, bool) {
	b, ok := v.([]byte)
	if !ok || len(b) != len(id.ID{}) {
		return id.ID{}, false
	}
	var out id.ID
	copy(out[:], b)
	return out, true
}

func (s *ModerationCaseSink) matchExisting(raw, expected []byte) error {
	if _, err := decodeModerationCase(raw, s.binding); err != nil {
		return err
	}
	if !bytes.Equal(raw, expected) {
		return ErrModerationCaseConflict
	}
	return nil
}

// List returns one bounded page ordered by the deterministic case key. The
// returned cursor can be supplied to the next call; an empty cursor ends paging.
func (s *ModerationCaseSink) List(ctx context.Context, after []byte, limit uint64) ([]ModerationCase, []byte, error) {
	if s == nil || ctx == nil || limit == 0 || limit > moderationCaseScanLimit || after != nil && (len(after) == 0 || len(after) > moderationCaseMaxCursor) {
		return nil, nil, ErrModerationCaseState
	}
	page, err := s.native.StateScan(ctx, moderationCaseStateArea, after, limit)
	if err != nil {
		return nil, nil, err
	}
	rows := make([]ModerationCase, 0, len(page.Entries))
	for _, entry := range page.Entries {
		if entry.Tombstone {
			continue
		}
		row, decErr := decodeModerationCase(entry.Value, s.binding)
		if decErr != nil {
			return nil, nil, decErr
		}
		if string(entry.Key) != string(moderationCaseKey(row.Message, row.SourceRevision)) {
			return nil, nil, ErrModerationCaseState
		}
		rows = append(rows, row)
	}
	return rows, append([]byte(nil), page.Next...), nil
}

// PurgeExpired removes at most one native state page per call. Callers should
// persist the returned cursor and resume until it is nil, including after a restart.
func (s *ModerationCaseSink) PurgeExpired(ctx context.Context, after []byte) (int, []byte, error) {
	if s == nil || ctx == nil || after != nil && (len(after) == 0 || len(after) > moderationCaseMaxCursor) {
		return 0, nil, ErrModerationCaseState
	}
	page, err := s.native.StateScan(ctx, moderationCaseStateArea, after, moderationCaseScanLimit)
	if err != nil {
		return 0, nil, err
	}
	cutoff := s.now().Add(-moderationCaseRetention)
	removed := 0
	for _, entry := range page.Entries {
		if entry.Tombstone {
			continue
		}
		row, decErr := decodeModerationCase(entry.Value, s.binding)
		if decErr != nil {
			return removed, page.Next, decErr
		}
		if string(entry.Key) != string(moderationCaseKey(row.Message, row.SourceRevision)) {
			return removed, page.Next, ErrModerationCaseState
		}
		if row.ReceivedAt.After(cutoff) {
			continue
		}
		_, txErr := s.native.StateTransaction(ctx, id.New(), []native.StateChange{{Area: moderationCaseStateArea, Key: entry.Key, ExpectedRevision: entry.Revision}})
		if txErr == nil {
			removed++
			continue
		}
		actual, readErr := s.native.StateGet(ctx, moderationCaseStateArea, entry.Key)
		if readErr == nil && actual.Tombstone && actual.Revision == entry.Revision+1 {
			removed++
			continue
		}
		return removed, page.Next, fmt.Errorf("purge moderation case: %w", txErr)
	}
	return removed, append([]byte(nil), page.Next...), nil
}

// PurgeExpiredResumable removes one bounded page and stores its cursor in
// encrypted app state, so the next maintenance run can continue after restart.
// If the cursor write has an uncertain result, reading back the desired value
// makes retry safe; repeating a page is also safe because deletes use revisions.
func (s *ModerationCaseSink) PurgeExpiredResumable(ctx context.Context) (int, error) {
	if s == nil || ctx == nil {
		return 0, ErrModerationCaseState
	}
	cursor, err := s.native.StateGet(ctx, moderationPurgeCursorArea, moderationPurgeCursorKey)
	if err != nil {
		return 0, err
	}
	if cursor.Revision > 0 && !cursor.Tombstone && (len(cursor.Value) == 0 || len(cursor.Value) > moderationCaseMaxCursor) {
		return 0, ErrModerationCaseState
	}
	var after []byte
	if cursor.Revision > 0 && !cursor.Tombstone {
		after = append([]byte(nil), cursor.Value...)
	}
	removed, next, err := s.PurgeExpired(ctx, after)
	if err != nil {
		return removed, err
	}
	if len(next) > moderationCaseMaxCursor {
		return removed, ErrModerationCaseState
	}
	if next == nil && (cursor.Revision == 0 || cursor.Tombstone) || next != nil && !cursor.Tombstone && bytes.Equal(next, cursor.Value) {
		return removed, nil
	}
	var value []byte
	if next != nil {
		value = next
	}
	_, txErr := s.native.StateTransaction(ctx, id.New(), []native.StateChange{{Area: moderationPurgeCursorArea, Key: moderationPurgeCursorKey,
		ExpectedRevision: cursor.Revision, Value: value}})
	if txErr == nil {
		return removed, nil
	}
	actual, readErr := s.native.StateGet(ctx, moderationPurgeCursorArea, moderationPurgeCursorKey)
	if readErr == nil && actual.Revision == cursor.Revision+1 && actual.Tombstone == (next == nil) && bytes.Equal(actual.Value, next) {
		return removed, nil
	}
	return removed, fmt.Errorf("persist moderation purge cursor: %w", txErr)
}
