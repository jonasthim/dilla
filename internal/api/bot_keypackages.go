package api

import (
	"context"
	"net/http"

	"github.com/jonasthim/dilla/internal/auth"
	botprotocol "github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/server"
)

type botKeyPackageCountResponse struct {
	_     struct{} `cbor:",toarray"`
	Count uint64
}

type botKeyPackageReceiptResponse struct {
	_          struct{} `cbor:",toarray"`
	Generation uint64
	UploadHash []byte
	Count      uint64
}

// RegisterBotDirectory mounts the only KeyPackage publication surface available to managed Bots.
func (h *Groups) RegisterBotDirectory(mux *server.Mux, sessions *auth.Sessions) {
	enrolled := func(f http.HandlerFunc) http.Handler { return sessions.Middleware(f, auth.ScopeEnrolled) }
	mux.Handle("POST /v1/bot-runtime/installations/{installation}/keypackages", enrolled(dsMeter(h.Limiter, dsClassWrite, h.publishBotKeyPackages)))
	mux.Handle("GET /v1/bot-runtime/installations/{installation}/keypackages/{operation}", enrolled(dsMeter(h.Limiter, dsClassRead, h.getBotKeyPackageReceipt)))
}

func (h *Groups) publishBotKeyPackages(w http.ResponseWriter, r *http.Request) {
	installation, err := server.PathID(r, "installation")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	raw, err := server.ReadBody(w, r, botprotocol.MaxKeyPackageUploadBody+64)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	body, err := botprotocol.DecodeKeyPackagePublication(raw)
	if err != nil {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "body is not a valid KeyPackage publication"))
		return
	}
	session, err := sessionOf(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	count, accepted, err := h.DS.PublishBotKeyPackages(r.Context(), session, installation, body.OperationID, body.ExpectedGeneration, body.UploadBody)
	if err != nil {
		server.WriteError(w, dsError(err))
		return
	}
	if err := server.EncodeBody(w, http.StatusCreated, botKeyPackageCountResponse{Count: count}); err != nil {
		server.WriteError(w, err)
		return
	}
	if accepted && h.AfterKeyPackages != nil {
		user, device := session.UserID, session.DeviceID
		h.runAfter(w, r, func(ctx context.Context) { h.AfterKeyPackages(ctx, user, device) })
	}
}

func (h *Groups) getBotKeyPackageReceipt(w http.ResponseWriter, r *http.Request) {
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
	receipt, err := h.DS.BotKeyPackagePublicationReceipt(r.Context(), session, installation, operation)
	if err != nil {
		server.WriteError(w, dsError(err))
		return
	}
	if err := server.EncodeBody(w, http.StatusOK, botKeyPackageReceiptResponse{Generation: receipt.Generation, UploadHash: receipt.UploadHash[:], Count: receipt.Count}); err != nil {
		server.WriteError(w, err)
	}
}
