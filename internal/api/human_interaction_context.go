package api

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"net/http"
	"reflect"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
	"github.com/jonasthim/dilla/internal/store"
)

const currentInteractionContextDomain = "dilla bot current interaction context v1\x00"

type currentInteractionContextWire struct {
	_                   struct{} `cbor:",toarray"`
	Version             uint64
	InstanceID          id.ID
	InstanceKeyID       id.ID
	InstanceSignerPub   []byte
	IssuedAt            uint64
	NotAfter            uint64
	Registration        currentInteractionRegistrationWire
	Binding             currentInteractionBindingWire
	Epoch               uint64
	LeafCount           uint64
	TreeHash            []byte
	Roster              []currentInteractionLeafWire
	EligibilityRevision uint64
	PolicyVersion       uint64
	E2EEVersion         uint64
	MediaVersion        uint64
	Bot                 interactionSnapshotListWire
	Participant         interactionSnapshotListWire
}

type currentInteractionRegistrationWire struct {
	_              struct{} `cbor:",toarray"`
	InstallationID id.ID
	OperationID    id.ID
	UserID         id.ID
	DeviceID       id.ID
	CommunityID    id.ID
	GroupID        id.ID
	BodySHA256     []byte
	Generation     uint64
	Epoch          uint64
	NextSeq        uint64
	AcceptedAt     uint64
}

type currentInteractionBindingWire struct {
	_                   struct{} `cbor:",toarray"`
	InstanceID          id.ID
	InstallationID      id.ID
	CommunityID         id.ID
	BotUserID           id.ID
	ParticipantUserID   id.ID
	ParticipantDeviceID id.ID
	PolicyVersion       uint64
	E2EEVersion         uint64
	MediaVersion        uint64
}

type currentInteractionLeafWire struct {
	_            struct{} `cbor:",toarray"`
	LeafIndex    uint32
	UserID       id.ID
	DeviceID     id.ID
	SignatureKey []byte
}

func (h *Groups) currentInteractionAdmissionContext(w http.ResponseWriter, r *http.Request) {
	d := h.Deps
	s, err := sessionOf(r)
	if err != nil || s.Bot != nil || s.Scope != 0 || s.UserID.IsZero() || s.DeviceID.IsZero() {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "enrolled human session required"))
		return
	}
	groupID, err := server.PathID(r, "id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	if h.DS == nil || d.Repo == nil || d.Clock == nil || d.DeviceLists == nil || d.SignBotCurrentInteractionContext == nil || len(d.ExternalSenderPub) != ed25519.PublicKeySize {
		server.WriteError(w, server.Errorf(server.CodeUnavailable, "current interaction context unavailable"))
		return
	}
	current, err := h.DS.CurrentBotInteractionGroupContext(r.Context(), groupID)
	if err != nil || current.Binding.ParticipantUserID != s.UserID || current.Binding.ParticipantDeviceID != s.DeviceID {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "current interaction context unavailable"))
		return
	}
	now := d.Clock.Now().Unix()
	if now < 0 || current.Registration.AcceptedAt < 0 {
		server.WriteError(w, server.Errorf(server.CodeUnavailable, "current interaction context unavailable"))
		return
	}
	var user store.UserRow
	var device store.DeviceRow
	var bot store.UserRow
	var botDevice store.DeviceRow
	var botList, participantList store.DeviceListRow
	var revision uint64
	err = d.Repo.Tx(r.Context(), func(tx store.Repository) error {
		communityID := current.Binding.CommunityID
		if err := tx.LockCommunity(r.Context(), communityID); err != nil {
			return err
		}
		if err := tx.LockBotInstallation(r.Context(), current.Binding.InstallationID); err != nil {
			return err
		}
		install, err := tx.GetBotInstallation(r.Context(), current.Binding.InstallationID)
		if err != nil || (install.State != store.BotInstallationJoining && install.State != store.BotInstallationReady) || install.RemovedAt != nil || install.CommunityID != communityID || install.UserID == nil || install.DeviceID == nil || *install.UserID != current.Binding.BotUserID || *install.DeviceID != current.Registration.DeviceID {
			return errors.New("inactive Bot installation")
		}
		lockedUsers := []id.ID{*install.UserID, s.UserID}
		if bytes.Compare(lockedUsers[0][:], lockedUsers[1][:]) > 0 {
			lockedUsers[0], lockedUsers[1] = lockedUsers[1], lockedUsers[0]
		}
		for i, uid := range lockedUsers {
			if i > 0 && uid == lockedUsers[i-1] {
				continue
			}
			if err := tx.LockUserForDeviceRegistration(r.Context(), uid); err != nil {
				return err
			}
		}
		bot, err = tx.GetUser(r.Context(), *install.UserID)
		if err != nil || bot.Kind != 1 || bot.Flags != 0 || bot.DisabledAt != nil || bot.DeletedAt != nil {
			return errors.New("inactive Bot account")
		}
		botDevice, err = tx.GetDevice(r.Context(), *install.DeviceID)
		if err != nil || botDevice.UserID != bot.ID || botDevice.VerifiedAt == nil || botDevice.RevokedAt != nil || botDevice.QuarantinedAt != nil {
			return errors.New("inactive Bot device")
		}
		user, err = tx.GetUser(r.Context(), s.UserID)
		if err != nil || user.Kind != kindHuman || user.DisabledAt != nil || user.DeletedAt != nil {
			return errors.New("inactive human participant")
		}
		device, err = tx.GetDevice(r.Context(), s.DeviceID)
		if err != nil || device.UserID != user.ID || device.VerifiedAt == nil || device.RevokedAt != nil || device.QuarantinedAt != nil {
			return errors.New("inactive participant device")
		}
		if _, err := tx.GetMember(r.Context(), communityID, user.ID); err != nil {
			return err
		}
		if _, err := tx.GetMember(r.Context(), communityID, bot.ID); err != nil {
			return err
		}
		community, err := tx.GetCommunity(r.Context(), communityID)
		if err != nil || community.PolicyVersion != current.Binding.PolicyVersion {
			return errors.New("community policy changed")
		}
		for _, uid := range []id.ID{user.ID, bot.ID} {
			ban, e := tx.GetBan(r.Context(), communityID, uid)
			if e == nil && (ban.Expires == nil || *ban.Expires > now) {
				return errors.New("current member is banned")
			}
			if e != nil && !errors.Is(e, store.ErrNotFound) {
				return e
			}
		}
		participantList, err = tx.GetDeviceList(r.Context(), user.ID)
		if err != nil {
			return err
		}
		botList, err = tx.GetDeviceList(r.Context(), bot.ID)
		if err != nil {
			return err
		}
		participantEntries, err := d.DeviceLists.Verify(r.Context(), participantList.Blob, user.SSKPub, user.ID)
		if err != nil || !deviceListContains(participantEntries, device) {
			return errors.New("participant device absent from signed list")
		}
		botEntries, err := d.DeviceLists.Verify(r.Context(), botList.Blob, bot.SSKPub, bot.ID)
		if err != nil || !deviceListContains(botEntries, botDevice) {
			return errors.New("Bot device absent from signed list")
		}
		eligibility, ok := tx.(store.BotInteractionEligibility)
		if !ok {
			return errors.New("eligibility revision unavailable")
		}
		revision, err = eligibility.GetBotInteractionEligibilityRevision(r.Context(), communityID, user.ID)
		if err != nil || revision == 0 {
			return errors.New("eligibility revision unavailable")
		}
		instance, err := tx.GetInstance(r.Context())
		if err != nil || instance.InstanceID != current.Binding.InstanceID || instance.InstanceID != d.Instance.InstanceID || instance.ExternalSenderKeyID != d.Instance.ExternalSenderKeyID {
			return errors.New("instance key context stale")
		}
		return nil
	})
	if err != nil {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "current interaction context unavailable"))
		return
	}
	if len(botList.Blob) == 0 || len(participantList.Blob) == 0 || len(botList.Blob) > maxInteractionListBlob || len(participantList.Blob) > maxInteractionListBlob || !validSnapshotList(interactionSnapshotDeviceList{UserID: bot.ID, Version: botList.Version, UMKPub: bot.UMKPub, SSKPub: bot.SSKPub, SSKBindingSignature: bot.SigUMKSSK, Blob: botList.Blob, Signature: botList.SSKSignature, PrevHash: botList.PrevHash}) || !validSnapshotList(interactionSnapshotDeviceList{UserID: user.ID, Version: participantList.Version, UMKPub: user.UMKPub, SSKPub: user.SSKPub, SSKBindingSignature: user.SigUMKSSK, Blob: participantList.Blob, Signature: participantList.SSKSignature, PrevHash: participantList.PrevHash}) {
		server.WriteError(w, server.Errorf(server.CodeForbidden, "current interaction context unavailable"))
		return
	}
	nowU := uint64(now)
	wire := currentInteractionContextWire{Version: 1, InstanceID: current.Binding.InstanceID, InstanceKeyID: d.Instance.ExternalSenderKeyID, InstanceSignerPub: append([]byte(nil), d.ExternalSenderPub...), IssuedAt: nowU, NotAfter: nowU + 30,
		Registration: currentInteractionRegistrationWire{InstallationID: current.Registration.InstallationID, OperationID: current.Registration.OperationID, UserID: current.Registration.UserID, DeviceID: current.Registration.DeviceID, CommunityID: current.Registration.CommunityID, GroupID: current.Registration.GroupID, BodySHA256: current.Registration.BodySHA256, Generation: current.Registration.Generation, Epoch: current.Registration.Epoch, NextSeq: current.Registration.NextSeq, AcceptedAt: uint64(current.Registration.AcceptedAt)},
		Binding:      currentInteractionBindingWire{InstanceID: current.Binding.InstanceID, InstallationID: current.Binding.InstallationID, CommunityID: current.Binding.CommunityID, BotUserID: current.Binding.BotUserID, ParticipantUserID: current.Binding.ParticipantUserID, ParticipantDeviceID: current.Binding.ParticipantDeviceID, PolicyVersion: current.Binding.PolicyVersion, E2EEVersion: current.Binding.E2EEVersion, MediaVersion: current.Binding.MediaVersion},
		Epoch:        current.Epoch, LeafCount: current.LeafCount, TreeHash: current.TreeHash, EligibilityRevision: revision, PolicyVersion: current.Binding.PolicyVersion, E2EEVersion: current.Binding.E2EEVersion, MediaVersion: current.Binding.MediaVersion,
		Bot:         snapshotListWire(interactionSnapshotDeviceList{UserID: bot.ID, UMKPub: bot.UMKPub, SSKPub: bot.SSKPub, SSKBindingSignature: bot.SigUMKSSK, Version: botList.Version, Blob: botList.Blob, Signature: botList.SSKSignature, PrevHash: botList.PrevHash}),
		Participant: snapshotListWire(interactionSnapshotDeviceList{UserID: user.ID, UMKPub: user.UMKPub, SSKPub: user.SSKPub, SSKBindingSignature: user.SigUMKSSK, Version: participantList.Version, Blob: participantList.Blob, Signature: participantList.SSKSignature, PrevHash: participantList.PrevHash})}
	for _, leaf := range current.Roster {
		wire.Roster = append(wire.Roster, currentInteractionLeafWire{LeafIndex: leaf.LeafIndex, UserID: leaf.UserID, DeviceID: leaf.DeviceID, SignatureKey: leaf.SignatureKey})
	}
	payload, err := cborx.Marshal(wire)
	if err != nil || len(payload) > maxInteractionSnapshot {
		server.WriteError(w, server.Errorf(server.CodeUnavailable, "current interaction context exceeds response limit"))
		return
	}
	var sig []byte
	err = h.DS.WithCurrentBotInteractionGroupContext(r.Context(), groupID, func(latest ds.CurrentBotInteractionGroupContext) error {
		// Device lists and policy above were read in their own transaction. Bind the
		// signature to that exact MLS state, then keep the group's lock through signing.
		if !reflect.DeepEqual(current, latest) {
			return errors.New("current interaction group changed before signing")
		}
		var signErr error
		sig, signErr = d.SignBotCurrentInteractionContext(payload)
		return signErr
	})
	if err != nil || len(sig) != ed25519.SignatureSize {
		server.WriteError(w, server.Errorf(server.CodeUnavailable, "current interaction context signing failed"))
		return
	}
	d.write(w, r, http.StatusOK, []any{payload, sig})
}
