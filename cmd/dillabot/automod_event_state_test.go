//go:build linux

package main

import (
	"testing"

	"github.com/jonasthim/dilla/internal/bot/moderation"
)

func TestLogOnlyModerationConfigDefaults(t *testing.T) {
	cfg := logOnlyModerationConfig()
	if cfg.Enabled {
		t.Fatal("log-only defaults unexpectedly enabled")
	}
	for _, rule := range []moderation.Rule{moderation.RuleRate, moderation.RuleDuplicate, moderation.RuleMentions} {
		if cfg.Actions[rule] != moderation.ActionLog {
			t.Errorf("default action for %s = %q, want log", rule, cfg.Actions[rule])
		}
	}
}

func TestUnavailableModerationBackendFailsClosedForConfiguredActions(t *testing.T) {
	cfg := moderation.Config{Enabled: true, Actions: map[moderation.Rule]moderation.Action{
		moderation.RuleRate: moderation.ActionWarn, moderation.RuleDuplicate: moderation.ActionTimeout,
		moderation.RuleMentions: moderation.ActionLog,
	}}
	setModerationActionsLogOnly(&cfg)
	for rule, action := range cfg.Actions {
		if action != moderation.ActionLog {
			t.Errorf("fallback action for %s = %q, want log", rule, action)
		}
	}
}
