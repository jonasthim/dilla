package api

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"math"
	"net/http"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

type botInteractionAdmissionRequest struct {
	_                 struct{} `cbor:",toarray"`
	RequestID         id.ID
	GroupID           id.ID
	ParticipantUser   id.ID
	ParticipantDevice id.ID
}

type botInteractionAdmissionPayload struct {
	_                   struct{} `cbor:",toarray"`
	Version             uint64
	AdmissionID         id.ID
	InstanceID          id.ID
	InstallationID      id.ID
	CommunityID         id.ID
	BotUserID           id.ID
	BotDeviceID         id.ID
	ParticipantUserID   id.ID
	ParticipantDeviceID id.ID
	GroupID             id.ID
	EligibilityRevision uint64
	NotAfter            uint64
}

func (d Deps) registerBotInteractionAdmissions(m *server.Mux) {
	botSession := BotSessionRoute(d.Sessions, d.Limiter)
	m.Handle("POST /v1/bot-runtime/installations/{installation}/interaction-admissions", botSession("POST /v1/bot-runtime/installations/{installation}/interaction-admissions", http.HandlerFunc(d.issueBotInteractionAdmission)))
	d.registerBotInteractionContext(m)
}

func (d Deps) issueBotInteractionAdmission(w http.ResponseWriter, r *http.Request) {
	s, ok := session(r)
	if !ok || s.Bot == nil {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "Bot session required"))
		return
	}
	if err := requireBotWire(s.WireVersion); err != nil {
		server.WriteError(w, err)
		return
	}
	installationID, err := server.PathID(r, "installation")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	var req botInteractionAdmissionRequest
	if err := server.DecodeBody(w, r, maxCBORBody, &req); err != nil {
		refuseCBOR(w, r, err)
		return
	}
	if req.RequestID.IsZero() || req.GroupID.IsZero() || req.ParticipantUser.IsZero() || req.ParticipantDevice.IsZero() {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "admission identifiers must be nonzero"))
		return
	}
	if d.SignBotInteractionAdmission == nil || d.DeviceLists == nil {
		server.WriteError(w, server.Errorf(server.CodeUnavailable, "interaction admission signing or device-list verification unavailable"))
		return
	}
	requestTuple, err := cborx.Marshal([]any{req.GroupID, req.ParticipantUser, req.ParticipantDevice})
	if err != nil {
		server.WriteError(w, server.Errorf(server.CodeInvalidRequest, "invalid admission request"))
		return
	}
	requestHash := sha256.Sum256(requestTuple)
	initial, err := d.Repo.GetBotInstallation(r.Context(), installationID)
	if err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	var payload []byte
	var signature []byte
	err = d.Repo.Tx(r.Context(), func(tx store.Repository) error {
		// Use the community-before-installation lock order shared by lifecycle
		// mutations so PostgreSQL transactions do not deadlock on admission.
		if err := tx.LockCommunity(r.Context(), initial.CommunityID); err != nil {
			return err
		}
		if err := tx.LockBotInstallation(r.Context(), installationID); err != nil {
			return err
		}
		installation, err := tx.GetBotInstallation(r.Context(), installationID)
		if err != nil {
			return err
		}
		if installation.ID != s.Bot.InstallationID || installation.CommunityID != s.Bot.CommunityID || installation.State != store.BotInstallationJoining && installation.State != store.BotInstallationReady || installation.UserID == nil || installation.DeviceID == nil || installation.CredentialVerifiedAt == nil || *installation.UserID != s.UserID || *installation.DeviceID != s.DeviceID {
			return server.Errorf(server.CodeForbidden, "session is not bound to this current installation")
		}
		if s.Bot.State != installation.State || s.Bot.CommunityID != installation.CommunityID {
			return server.Errorf(server.CodeForbidden, "Bot session installation state is stale")
		}
		// Disable and tombstone mutations take this same user-row lock before
		// their eligibility trigger advances the revision fence.
		if err := tx.LockUserForDeviceRegistration(r.Context(), req.ParticipantUser); err != nil {
			return err
		}
		// Lock eligibility before reading device/list state. Device and signed-list
		// triggers use this row, so a concurrent change either precedes these reads
		// or advances the fence after this transaction commits.
		eligibility, ok := tx.(store.BotInteractionEligibility)
		if !ok {
			return server.Errorf(server.CodeUnavailable, "interaction eligibility fencing unavailable")
		}
		revision, err := eligibility.GetBotInteractionEligibilityRevision(r.Context(), installation.CommunityID, req.ParticipantUser)
		if err != nil {
			return err
		}
		if revision == 0 {
			return server.Errorf(server.CodeUnavailable, "participant eligibility revision is not established")
		}
		participant, err := tx.GetUser(r.Context(), req.ParticipantUser)
		if err != nil || participant.Kind != kindHuman || participant.DisabledAt != nil || participant.DeletedAt != nil {
			return server.Errorf(server.CodeForbidden, "active human participant required")
		}
		if _, err := tx.GetMember(r.Context(), installation.CommunityID, participant.ID); err != nil {
			return server.Errorf(server.CodeForbidden, "participant is not a current community member")
		}
		ban, err := tx.GetBan(r.Context(), installation.CommunityID, participant.ID)
		if err == nil && (ban.Expires == nil || *ban.Expires > d.Clock.Now().Unix()) {
			return server.Errorf(server.CodeForbidden, "participant is banned")
		}
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		device, err := tx.GetDevice(r.Context(), req.ParticipantDevice)
		if err != nil || !ds.ActiveHumanInteractionDevice(participant.ID, device) {
			return server.Errorf(server.CodeForbidden, "participant device is not active")
		}
		list, err := tx.GetDeviceList(r.Context(), participant.ID)
		if err != nil {
			return server.Errorf(server.CodeForbidden, "participant has no active signed device list")
		}
		entries, err := d.DeviceLists.Verify(r.Context(), list.Blob, participant.SSKPub, participant.ID)
		if err != nil {
			return server.Errorf(server.CodeForbidden, "participant device list is invalid")
		}
		if !ds.EligibleHumanInteractionDevice(participant.ID, device, entries) {
			return server.Errorf(server.CodeForbidden, "participant device is not in the active signed device list")
		}
		now := d.Clock.Now().Unix()
		if now < 0 || now > math.MaxInt64-30 {
			return server.Errorf(server.CodeUnavailable, "server time outside admission range")
		}
		receipts, ok := tx.(store.BotInteractionAdmissionReceipts)
		if !ok {
			return server.Errorf(server.CodeUnavailable, "interaction admission receipts unavailable")
		}
		if err := receipts.CompactExpiredBotInteractionAdmissionReceipts(r.Context(), installation.ID, now); err != nil {
			return err
		}
		receipt, receiptErr := receipts.GetBotInteractionAdmissionReceipt(r.Context(), installation.ID, req.RequestID)
		reissue := false
		if receiptErr == nil {
			if !bytes.Equal(receipt.RequestHash, requestHash[:]) {
				return server.WithStatus(http.StatusConflict, server.Errorf(server.CodeInvalidRequest, "request id was already used for a different admission"))
			}
			if len(receipt.Payload) == 0 && len(receipt.Signature) == 0 {
				reissue = true
			} else {
				var prior botInteractionAdmissionPayload
				if err := cborx.Unmarshal(receipt.Payload, &prior); err != nil || prior.EligibilityRevision != revision || prior.NotAfter <= uint64(now) {
					return server.WithStatus(http.StatusConflict, server.Errorf(server.CodeInvalidRequest, "admission receipt is no longer current"))
				}
				payload, signature = receipt.Payload, receipt.Signature
				return nil
			}
		}
		if receiptErr != nil && !errors.Is(receiptErr, store.ErrNotFound) {
			return receiptErr
		}
		v := botInteractionAdmissionPayload{Version: 1, AdmissionID: id.New(), InstanceID: d.Instance.InstanceID, InstallationID: installation.ID, CommunityID: installation.CommunityID, BotUserID: *installation.UserID, BotDeviceID: *installation.DeviceID, ParticipantUserID: participant.ID, ParticipantDeviceID: device.ID, GroupID: req.GroupID, EligibilityRevision: revision, NotAfter: uint64(now + 30)}
		payload, err = cborx.Marshal(v)
		if err != nil {
			return err
		}
		signature, err = d.SignBotInteractionAdmission(payload)
		if err != nil || len(signature) != 64 {
			return server.Errorf(server.CodeUnavailable, "interaction admission signing failed")
		}
		newReceipt := store.BotInteractionAdmissionReceipt{InstallationID: installation.ID, RequestID: req.RequestID, RequestHash: requestHash[:], Payload: payload, Signature: signature, NotAfter: now + 30}
		if reissue {
			return receipts.UpdateBotInteractionAdmissionReceipt(r.Context(), newReceipt)
		}
		return receipts.CreateBotInteractionAdmissionReceipt(r.Context(), newReceipt)
	})
	if err != nil {
		server.WriteError(w, d.storeError(r, err))
		return
	}
	d.write(w, r, http.StatusOK, []any{payload, signature})
}
