package ds_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/store"
)

func TestManagedRegistrationRejectsNoncanonicalBodyBeforeStoreAccess(t *testing.T) {
	h := newDSHarness(t)
	installation := id.New()
	request := ds.BotRegisterRequest{
		Session:        auth.Session{Scope: auth.ScopeEnrolled, Bot: &auth.BotSessionBinding{InstallationID: installation, State: store.BotInstallationJoining}},
		InstallationID: installation, OperationID: id.New(), ExpectedGeneration: 1,
		RegistrationBody: []byte{0x80}, Registration: ds.RegisterRequest{GroupID: id.New()},
	}
	_, _, err := h.ds.RegisterWithBotReceipt(context.Background(), request)
	var refusal *ds.Error
	if !errors.As(err, &refusal) || refusal.Code != "E_INVALID_REQUEST" {
		t.Fatalf("noncanonical registration body = %v, want E_INVALID_REQUEST before lookup", err)
	}
}

func TestManagedRegistrationRejectsZeroOperationID(t *testing.T) {
	h := newDSHarness(t)
	installation := id.New()
	request := ds.BotRegisterRequest{
		Session:        auth.Session{Scope: auth.ScopeEnrolled, Bot: &auth.BotSessionBinding{InstallationID: installation, State: store.BotInstallationJoining}},
		InstallationID: installation, ExpectedGeneration: 1, RegistrationBody: []byte{0x80},
	}
	_, _, err := h.ds.RegisterWithBotReceipt(context.Background(), request)
	var refusal *ds.Error
	if !errors.As(err, &refusal) || refusal.Code != "E_INVALID_REQUEST" {
		t.Fatalf("zero operation id = %v, want E_INVALID_REQUEST", err)
	}
}
