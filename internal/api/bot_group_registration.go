package api

import (
	"bytes"
	"context"
	"math"
	"net/http"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
)

type botGroupRegistrationReceiptResponse struct {
	_           struct{} `cbor:",toarray"`
	OperationID id.ID
	GroupID     id.ID
	BodySHA256  []byte
	Generation  uint64
	Epoch       uint64
	NextSeq     uint64
}

// RegisterBotRegistration mounts the installation-scoped managed-bot first-group routes.
func (h *Groups) RegisterBotRegistration(mux *server.Mux, sessions *auth.Sessions) {
	enrolled := func(f http.HandlerFunc) http.Handler { return sessions.Middleware(f, auth.ScopeEnrolled) }
	mux.Handle("POST /v1/bot-runtime/installations/{installation}/groups", enrolled(dsMeter(h.Limiter, dsClassWrite, h.registerBotGroup)))
	mux.Handle("GET /v1/bot-runtime/installations/{installation}/groups/{operation}", enrolled(dsMeter(h.Limiter, dsClassRead, h.getBotGroupReceipt)))
}

func (h *Groups) registerBotGroup(w http.ResponseWriter, r *http.Request) {
	installation, err := server.PathID(r, "installation")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	raw, err := server.ReadBody(w, r, maxCBORBody)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	var tuple []any
	if cborx.ExpectMajor(raw, cborx.MajorArray) != nil || cborx.Unmarshal(raw, &tuple) != nil || len(tuple) != 3 {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "body is not a managed group registration"))
		return
	}
	operation, ok := registrationID(tuple[0])
	generation, generationOK := tuple[1].(uint64)
	body, bodyOK := tuple[2].([]byte)
	if !ok || !generationOK || generation > math.MaxInt64 || !bodyOK {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "body is not a managed group registration"))
		return
	}
	if len(body) > 65_505 {
		server.WriteError(w, server.Errorf(server.CodeTooLarge, "registration_body exceeds 65,505 bytes"))
		return
	}
	registration, err := decodeRegistrationBody(body)
	if err != nil {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "registration_body is not canonical"))
		return
	}
	session, err := sessionOf(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if session.Bot == nil {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "managed group registration requires a Bot session"))
		return
	}
	registration.Session = session
	receipt, created, err := h.DS.RegisterWithBotReceipt(r.Context(), ds.BotRegisterRequest{
		Session: session, InstallationID: installation, OperationID: operation, ExpectedGeneration: generation,
		RegistrationBody: body, Registration: registration,
	})
	if err != nil {
		server.WriteError(w, dsError(err))
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeBotGroupReceipt(w, status, receipt)
	// A receipt replay is still proof that registration was accepted. The first
	// request may have committed the group but failed while installing its live
	// cache state, before this handler could schedule AfterRegister; retrying the
	// idempotent reconciliation hook closes that gap. Receipt GETs do not trigger
	// work, and refused POSTs never reach this point. This route is device-metered,
	// which bounds retry-driven hook submissions at the API edge.
	if h.AfterRegister != nil {
		groupID := receipt.GroupID
		h.runAfter(w, r, func(ctx context.Context) { h.AfterRegister(ctx, groupID) })
	}
}

func (h *Groups) getBotGroupReceipt(w http.ResponseWriter, r *http.Request) {
	installation, err := server.PathID(r, "installation")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	operation, err := server.PathID(r, "operation")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if operation.IsZero() {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "operation must be nonzero"))
		return
	}
	session, err := sessionOf(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if session.Bot == nil {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "managed group receipts require a Bot session"))
		return
	}
	receipt, err := h.DS.BotGroupRegistrationReceipt(r.Context(), session, installation, operation)
	if err != nil {
		server.WriteError(w, dsError(err))
		return
	}
	writeBotGroupReceipt(w, http.StatusOK, receipt)
}

func writeBotGroupReceipt(w http.ResponseWriter, status int, receipt ds.BotRegisterReceipt) {
	w.Header().Set("Cache-Control", "no-store")
	if err := server.EncodeBody(w, status, botGroupRegistrationReceiptResponse{
		OperationID: receipt.OperationID, GroupID: receipt.GroupID, BodySHA256: receipt.BodySHA256[:],
		Generation: receipt.Generation, Epoch: receipt.Epoch, NextSeq: receipt.NextSeq,
	}); err != nil {
		server.WriteError(w, err)
	}
}

func decodeRegistrationBody(raw []byte) (ds.RegisterRequest, error) {
	var out ds.RegisterRequest
	var tuple []any
	if len(raw) == 0 || cborx.ExpectMajor(raw, cborx.MajorArray) != nil || cborx.Unmarshal(raw, &tuple) != nil || len(tuple) != 4 {
		return out, server.Errorf(server.CodeInvalidRequest, "invalid registration body")
	}
	group, ok := registrationID(tuple[0])
	binding, bindingOK := tuple[1].([]byte)
	info, infoOK := tuple[2].([]byte)
	tree, treeOK := tuple[3].([]byte)
	if !ok || !bindingOK || !infoOK || !treeOK {
		return out, server.Errorf(server.CodeInvalidRequest, "invalid registration body")
	}
	canonical, err := cborx.Marshal([]any{group, binding, info, tree})
	if err != nil || !bytes.Equal(canonical, raw) {
		return out, server.Errorf(server.CodeInvalidRequest, "noncanonical registration body")
	}
	out.GroupID, out.Binding, out.GroupInfo, out.RatchetTree = group, binding, info, tree
	return out, nil
}

func registrationID(v any) (id.ID, bool) {
	var out id.ID
	b, ok := v.([]byte)
	if !ok || len(b) != len(out) {
		return out, false
	}
	copy(out[:], b)
	return out, !out.IsZero()
}
