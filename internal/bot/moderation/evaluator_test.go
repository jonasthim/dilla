package moderation

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestThresholdsAndLogOnlyDefault(t *testing.T) {
	base := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	e := New(Config{Enabled: true})
	for i := 1; i <= 6; i++ {
		d := e.Evaluate(Input{CommunityID: "c", SourceID: string(rune('a' + i)), Revision: 1, UserID: "u", ReceivedAt: base.Add(time.Duration(i-1) * 800 * time.Millisecond), Body: "hello"}, base.Add(5*time.Second))
		if i == 6 && (!hasRule(d, RuleRate) || d.Action != ActionLog) {
			t.Fatalf("sixth message decision = %+v, want rate/log", d)
		}
		if i < 6 && hasRule(d, RuleRate) {
			t.Fatalf("message %d unexpectedly triggered rate: %+v", i, d)
		}
	}
}

func TestDuplicateRevisionAndEditReevaluation(t *testing.T) {
	base := time.Now().UTC()
	e := New(Config{Enabled: true, Actions: map[Rule]Action{RuleDuplicate: ActionRemove}})
	first := Input{CommunityID: "c", SourceID: "m1", Revision: 1, UserID: "u", ReceivedAt: base, Body: " Same   text "}
	second := Input{CommunityID: "c", SourceID: "m2", Revision: 1, UserID: "u", ReceivedAt: base.Add(time.Second), Body: "same text"}
	third := Input{CommunityID: "c", SourceID: "m3", Revision: 1, UserID: "u", ReceivedAt: base.Add(2 * time.Second), Body: "SAME text"}
	e.Evaluate(first, base.Add(time.Second))
	if d := e.Evaluate(second, base.Add(time.Second)); hasRule(d, RuleDuplicate) {
		t.Fatalf("second identical body triggered early: %+v", d)
	}
	if d := e.Evaluate(third, base.Add(2*time.Second)); !hasRule(d, RuleDuplicate) || d.Action != ActionRemove {
		t.Fatalf("third identical content should be remove: %+v", d)
	}
	if d := e.Evaluate(third, base.Add(2*time.Second)); !d.DuplicateDelivery || len(d.Rules) != 0 {
		t.Fatalf("duplicate delivery was counted twice: %+v", d)
	}
	edited := first
	edited.Revision = 2
	edited.Edit = true
	edited.Body = "changed"
	if d := e.Evaluate(edited, base.Add(2*time.Second)); hasRule(d, RuleRate) {
		t.Fatalf("edit incorrectly increments message rate: %+v", d)
	}
}

func TestMentionExemptionReplayAndTimeoutDefault(t *testing.T) {
	base := time.Now().UTC()
	e := New(Config{Enabled: true, ExemptUsers: []string{"trusted"}, Actions: map[Rule]Action{RuleMentions: ActionTimeout}})
	mentions := []string{"a", "b", "c", "d", "e", "f", "f"}
	input := Input{CommunityID: "c", SourceID: "m", Revision: 1, UserID: "u", ReceivedAt: base, Body: "secret body", MentionIDs: mentions}
	d := e.Evaluate(input, base)
	if !hasRule(d, RuleMentions) || d.Action != ActionTimeout || d.Timeout != 10*time.Minute {
		t.Fatalf("mention action = %+v", d)
	}
	input.SourceID, input.UserID = "old", "old"
	input.ReceivedAt = base.Add(-time.Minute)
	if d = e.Evaluate(input, base); len(d.Rules) != 0 {
		t.Fatalf("old backlog punished: %+v", d)
	}
	input.SourceID, input.UserID, input.ReceivedAt = "trusted", "trusted", base
	if d = e.Evaluate(input, base); len(d.Rules) != 0 {
		t.Fatalf("exempt user punished: %+v", d)
	}
	input.SourceID, input.UserID, input.ReceivedAt, input.Bot = "bot", "bot", base, true
	if d = e.Evaluate(input, base); len(d.Rules) != 0 {
		t.Fatalf("bot user punished: %+v", d)
	}
}

func TestWindowBoundariesAndEditViolation(t *testing.T) {
	base := time.Now().UTC()
	e := New(Config{Enabled: true, Actions: map[Rule]Action{RuleMentions: ActionWarn}})
	for i := 0; i < 5; i++ {
		e.Evaluate(Input{CommunityID: "c", SourceID: string(rune('a' + i)), Revision: 1, UserID: "u", ReceivedAt: base.Add(time.Duration(i) * time.Second), Body: "ok"}, base.Add(5*time.Second))
	}
	boundary := e.Evaluate(Input{CommunityID: "c", SourceID: "f", Revision: 1, UserID: "u", ReceivedAt: base.Add(5 * time.Second), Body: "ok"}, base.Add(5*time.Second))
	if hasRule(boundary, RuleRate) {
		t.Fatalf("message exactly five seconds outside the open interval was counted: %+v", boundary)
	}
	edit := Input{CommunityID: "c", SourceID: "edit", Revision: 2, UserID: "editor", Edit: true, ReceivedAt: base.Add(5 * time.Second), Body: "edited", MentionIDs: []string{"1", "2", "3", "4", "5", "6"}}
	if d := e.Evaluate(edit, base.Add(5*time.Second)); !hasRule(d, RuleMentions) || d.Action != ActionWarn {
		t.Fatalf("edit violation was not reevaluated: %+v", d)
	}
}

func TestExcerptIsValidUTF8AndByteBounded(t *testing.T) {
	got := Excerpt(strings.Repeat("é", 300))
	if len(got) > 512 || !strings.HasPrefix(got, "é") || !utf8.ValidString(got) {
		t.Fatalf("excerpt invalid or exceeds limit: len=%d", len(got))
	}
	if got := Excerpt("x\xffy"); !utf8.ValidString(got) || got != "x�y" {
		t.Fatalf("short invalid UTF-8 excerpt = %q, want repaired UTF-8", got)
	}
}

func TestRecentReplayRebuildsWindowsWithoutPunishment(t *testing.T) {
	base := time.Now().UTC()
	e := New(Config{Enabled: true, Actions: map[Rule]Action{
		RuleRate: ActionTimeout, RuleDuplicate: ActionRemove, RuleMentions: ActionWarn,
	}})
	for i := 0; i < 5; i++ {
		d := e.Evaluate(Input{CommunityID: "c", SourceID: string(rune('a' + i)), Revision: 1, UserID: "u", ReceivedAt: base.Add(time.Duration(i) * 500 * time.Millisecond), Body: "same", Replay: true}, base.Add(6*time.Second))
		if d.Action != ActionLog || d.Timeout != 0 {
			t.Fatalf("replay event caused action: %+v", d)
		}
	}
	replayMention := e.Evaluate(Input{CommunityID: "c", SourceID: "mention-replay", Revision: 1, UserID: "m", ReceivedAt: base.Add(5 * time.Second), Body: "mentions", MentionIDs: []string{"1", "2", "3", "4", "5", "6"}, Replay: true}, base.Add(6*time.Second))
	if !hasRule(replayMention, RuleMentions) || replayMention.Action != ActionLog {
		t.Fatalf("recent replay did not match without punishing: %+v", replayMention)
	}
	live := e.Evaluate(Input{CommunityID: "c", SourceID: "live", Revision: 1, UserID: "u", ReceivedAt: base.Add(2500 * time.Millisecond), Body: "same"}, base.Add(6*time.Second))
	if !hasRule(live, RuleRate) || live.Action != ActionTimeout {
		t.Fatalf("replayed window was not reconstructed for live decision: %+v", live)
	}
}

func TestCommunityScopesCountersAndDeduplication(t *testing.T) {
	base := time.Now().UTC()
	e := New(Config{Enabled: true, Actions: map[Rule]Action{RuleRate: ActionWarn}})
	for i := 0; i < 5; i++ {
		e.Evaluate(Input{CommunityID: "one", SourceID: string(rune('a' + i)), Revision: 1, UserID: "u", ReceivedAt: base.Add(time.Duration(i) * time.Second), Body: "x"}, base.Add(5*time.Second))
	}
	other := e.Evaluate(Input{CommunityID: "two", SourceID: "other", Revision: 1, UserID: "u", ReceivedAt: base.Add(5 * time.Second), Body: "x"}, base.Add(5*time.Second))
	if hasRule(other, RuleRate) {
		t.Fatalf("community counters crossed: %+v", other)
	}
	first := e.Evaluate(Input{CommunityID: "one", SourceID: "shared", Revision: 1, UserID: "u", ReceivedAt: base.Add(6 * time.Second), Body: "z"}, base.Add(6*time.Second))
	second := e.Evaluate(Input{CommunityID: "two", SourceID: "shared", Revision: 1, UserID: "u", ReceivedAt: base.Add(6 * time.Second), Body: "z"}, base.Add(6*time.Second))
	if first.DuplicateDelivery || second.DuplicateDelivery {
		t.Fatalf("deduplication crossed communities: first=%+v second=%+v", first, second)
	}
}

func hasRule(d Decision, want Rule) bool {
	for _, rule := range d.Rules {
		if rule == want {
			return true
		}
	}
	return false
}
