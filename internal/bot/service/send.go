package service

import (
	"context"
	"crypto/sha256"
	"errors"
	"math"

	"github.com/jonasthim/dilla/internal/bot/client"
	"github.com/jonasthim/dilla/internal/bot/native"
	"github.com/jonasthim/dilla/internal/bot/protocol"
	"github.com/jonasthim/dilla/internal/id"
)

var ErrSendTerminal = errors.New("bot send attempt is already accepted or unknown")

type sendNative interface {
	Binding() native.Binding
	InspectGroup(context.Context, id.ID) (native.GroupInfo, error)
	PrepareSend(context.Context, id.ID, id.ID, id.ID, []byte, uint64, uint64) (native.PreparedSend, error)
	ConfirmSendReceipt(context.Context, id.ID, []byte) error
}

type sendAuthority interface {
	DiscoverObserved(context.Context) (client.Discovery, client.ResponseObservation, error)
}

type sendSession interface {
	PostBotMessage(context.Context, id.ID, id.ID, client.BotMessageUpload) (protocol.SendReceipt, error)
	BotMessageReceipt(context.Context, id.ID, id.ID, id.ID, id.ID) (protocol.SendReceipt, error)
	ResolveBotMessage(context.Context, id.ID, id.ID, client.BotMessageResolution) (protocol.SendReceipt, error)
}

// SendCoordinator serializes one bot send against the identity binding and the
// server generation advertised by discovery. Calls with the same input are
// safe to resume after restart because native PrepareSend returns its durable
// ciphertext unchanged.
type SendCoordinator struct {
	native    sendNative
	authority sendAuthority
	binding   native.Binding
}

type SendInput struct {
	OperationID, AttemptID id.ID
	PredecessorAttemptID   *id.ID
	GroupID                id.ID
	RequestBody            []byte
	OriginalNow            uint64
	ExpectedGeneration     uint64
}

func NewSendCoordinator(n *native.Client, authority *client.Client) (*SendCoordinator, error) {
	if n == nil || authority == nil {
		return nil, errors.New("missing send dependency")
	}
	return newSendCoordinator(n, authority)
}

func newSendCoordinator(n sendNative, authority sendAuthority) (*SendCoordinator, error) {
	if n == nil || authority == nil {
		return nil, errors.New("missing send dependency")
	}
	b := n.Binding()
	if b.Instance.IsZero() || b.Community.IsZero() || b.Installation.IsZero() {
		return nil, errors.New("invalid native send binding")
	}
	return &SendCoordinator{native: n, authority: authority, binding: b}, nil
}

// Send prepares one immutable attempt, then either posts its exact ciphertext
// or recovers the same attempt by receipt lookup and resolution. It never
// creates a replacement attempt automatically.
func (s *SendCoordinator) Send(ctx context.Context, session *client.Session, in SendInput) (protocol.SendReceipt, error) {
	if session == nil {
		return protocol.SendReceipt{}, errors.New("missing send session")
	}
	return s.send(ctx, session, in)
}

func (s *SendCoordinator) send(ctx context.Context, session sendSession, in SendInput) (protocol.SendReceipt, error) {
	return s.sendWithPreflight(ctx, session, in, nil)
}

// sendWithPreflight checks authorization after looking up a durable receipt.
// A receipt already accepted by the server remains authoritative and is
// confirmed unchanged; an attempt with no receipt must pass preflight before
// any native preparation or network send can occur.
func (s *SendCoordinator) sendWithPreflight(ctx context.Context, session sendSession, in SendInput, preflight func(context.Context) error) (protocol.SendReceipt, error) {
	if s == nil || session == nil || in.OperationID.IsZero() || in.AttemptID.IsZero() || in.GroupID.IsZero() || in.ExpectedGeneration == 0 || in.ExpectedGeneration > math.MaxInt64 || in.OriginalNow > math.MaxInt64 || len(in.RequestBody) == 0 || in.PredecessorAttemptID != nil && in.PredecessorAttemptID.IsZero() {
		return protocol.SendReceipt{}, errors.New("invalid send input")
	}
	if err := ctx.Err(); err != nil {
		return protocol.SendReceipt{}, err
	}
	discovery, _, err := s.authority.DiscoverObserved(ctx)
	if err != nil {
		return protocol.SendReceipt{}, err
	}
	if discovery.InstanceID != s.binding.Instance || discovery.Generation == 0 || discovery.Generation > math.MaxInt64 {
		return protocol.SendReceipt{}, client.ErrInstanceChanged
	}
	// A durable server receipt is authoritative even if the local helper has
	// already sealed its outbox entry and no longer permits PrepareSend.
	receipt, lookupErr := session.BotMessageReceipt(ctx, s.binding.Community, in.OperationID, in.AttemptID, in.GroupID)
	if lookupErr == nil {
		if !receiptMatchesInput(receipt, s.binding.Community, in) {
			return protocol.SendReceipt{}, client.ErrProtocol
		}
		body, encodeErr := protocol.EncodeReceipt(receipt)
		if encodeErr != nil {
			return protocol.SendReceipt{}, encodeErr
		}
		if err = s.native.ConfirmSendReceipt(ctx, in.OperationID, body); err != nil {
			return protocol.SendReceipt{}, err
		}
		if receipt.Outcome == protocol.ReceiptUnknownAfterRestore {
			return receipt, ErrSendTerminal
		}
		return receipt, nil
	}
	if !errors.Is(lookupErr, client.ErrBotSendReceiptNotFound) {
		return protocol.SendReceipt{}, lookupErr
	}
	if preflight != nil {
		if err := preflight(ctx); err != nil {
			return protocol.SendReceipt{}, err
		}
	}
	group, err := s.native.InspectGroup(ctx, in.GroupID)
	if err != nil {
		return protocol.SendReceipt{}, err
	}
	if group.ID != in.GroupID || group.State != 2 || group.Community == nil || *group.Community != s.binding.Community || group.Epoch > math.MaxInt64 {
		return protocol.SendReceipt{}, errors.New("native send group does not match identity binding")
	}
	if in.PredecessorAttemptID != nil {
		previous, lookupErr := session.BotMessageReceipt(ctx, s.binding.Community, in.OperationID, *in.PredecessorAttemptID, in.GroupID)
		if lookupErr != nil {
			return protocol.SendReceipt{}, lookupErr
		}
		if previous.AttemptID != *in.PredecessorAttemptID || previous.OperationID != in.OperationID || previous.Outcome != protocol.ReceiptClosedNotAccepted || protocol.ValidateReceiptContext(previous, s.binding.Community, in.GroupID) != nil {
			return protocol.SendReceipt{}, ErrSendTerminal
		}
		previousBody, encodeErr := protocol.EncodeReceipt(previous)
		if encodeErr != nil {
			return protocol.SendReceipt{}, encodeErr
		}
		if err = s.native.ConfirmSendReceipt(ctx, in.OperationID, previousBody); err != nil {
			return protocol.SendReceipt{}, err
		}
	}

	prepared, err := s.native.PrepareSend(ctx, in.OperationID, in.AttemptID, in.GroupID, in.RequestBody, in.OriginalNow, in.ExpectedGeneration)
	if err != nil {
		return protocol.SendReceipt{}, err
	}
	if len(prepared.Ciphertext) == 0 || prepared.Epoch > math.MaxInt64 || prepared.Class > 1 {
		return protocol.SendReceipt{}, errors.New("native helper returned invalid prepared send")
	}
	predecessor := cloneID(in.PredecessorAttemptID)
	upload := client.BotMessageUpload{OperationID: in.OperationID, AttemptID: in.AttemptID, PredecessorAttemptID: predecessor, ExpectedGeneration: in.ExpectedGeneration, Epoch: prepared.Epoch, PrivateMessage: append([]byte(nil), prepared.Ciphertext...), Class: prepared.Class}
	resolution := client.BotMessageResolution{AttemptID: in.AttemptID, PredecessorAttemptID: cloneID(predecessor), GroupID: in.GroupID, ExpectedGeneration: in.ExpectedGeneration, Epoch: prepared.Epoch, Class: prepared.Class, CiphertextSHA256: sha256.Sum256(prepared.Ciphertext)}

	// A retry after a crash first checks whether the previous process completed
	// the POST and lost its response.
	if discovery.Generation != in.ExpectedGeneration || prepared.Epoch != group.Epoch {
		receipt, err = session.ResolveBotMessage(ctx, s.binding.Community, in.OperationID, resolution)
		if err != nil {
			return protocol.SendReceipt{}, err
		}
		return s.confirm(ctx, in.OperationID, receipt, upload, resolution)
	}

	receipt, postErr := session.PostBotMessage(ctx, s.binding.Community, in.GroupID, upload)
	if postErr == nil {
		return s.confirm(ctx, in.OperationID, receipt, upload, resolution)
	}
	// A lost or malformed HTTP result is not evidence of refusal. Recheck the
	// exact attempt, then let the server close/resolve that same ciphertext.
	receipt, lookupErr = session.BotMessageReceipt(ctx, s.binding.Community, in.OperationID, in.AttemptID, in.GroupID)
	if lookupErr == nil {
		return s.confirm(ctx, in.OperationID, receipt, upload, resolution)
	}
	if !errors.Is(lookupErr, client.ErrBotSendReceiptNotFound) {
		return protocol.SendReceipt{}, errors.Join(postErr, lookupErr)
	}
	receipt, err = session.ResolveBotMessage(ctx, s.binding.Community, in.OperationID, resolution)
	if err != nil {
		return protocol.SendReceipt{}, errors.Join(postErr, err)
	}
	return s.confirm(ctx, in.OperationID, receipt, upload, resolution)
}

func receiptMatchesInput(receipt protocol.SendReceipt, community id.ID, in SendInput) bool {
	if receipt.OperationID != in.OperationID || receipt.AttemptID != in.AttemptID || receipt.ExpectedGeneration != in.ExpectedGeneration || protocol.ValidateReceiptContext(receipt, community, in.GroupID) != nil {
		return false
	}
	if receipt.PredecessorAttemptID == nil {
		return in.PredecessorAttemptID == nil
	}
	return in.PredecessorAttemptID != nil && *receipt.PredecessorAttemptID == *in.PredecessorAttemptID
}

func (s *SendCoordinator) confirm(ctx context.Context, operation id.ID, receipt protocol.SendReceipt, upload client.BotMessageUpload, resolution client.BotMessageResolution) (protocol.SendReceipt, error) {
	if receipt.OperationID != upload.OperationID || receipt.AttemptID != upload.AttemptID || receipt.PredecessorAttemptID != nil && (upload.PredecessorAttemptID == nil || *receipt.PredecessorAttemptID != *upload.PredecessorAttemptID) || receipt.PredecessorAttemptID == nil && upload.PredecessorAttemptID != nil || receipt.ExpectedGeneration != upload.ExpectedGeneration || receipt.Epoch != upload.Epoch || receipt.Class != upload.Class || !equalHash(receipt.CiphertextHash, resolution.CiphertextSHA256) || protocol.ValidateReceiptContext(receipt, s.binding.Community, resolution.GroupID) != nil {
		return protocol.SendReceipt{}, client.ErrProtocol
	}
	if receipt.Outcome == protocol.ReceiptAccepted || receipt.Outcome == protocol.ReceiptUnknownAfterRestore {
		body, err := protocol.EncodeReceipt(receipt)
		if err != nil {
			return protocol.SendReceipt{}, err
		}
		if err = s.native.ConfirmSendReceipt(ctx, operation, body); err != nil {
			return protocol.SendReceipt{}, err
		}
		if receipt.Outcome == protocol.ReceiptUnknownAfterRestore {
			return receipt, ErrSendTerminal
		}
		return receipt, nil
	}
	if receipt.Outcome != protocol.ReceiptClosedNotAccepted {
		return protocol.SendReceipt{}, client.ErrProtocol
	}
	body, err := protocol.EncodeReceipt(receipt)
	if err != nil {
		return protocol.SendReceipt{}, err
	}
	if err = s.native.ConfirmSendReceipt(ctx, operation, body); err != nil {
		return protocol.SendReceipt{}, err
	}
	return receipt, nil
}

func cloneID(v *id.ID) *id.ID {
	if v == nil {
		return nil
	}
	x := *v
	return &x
}

func equalHash(got []byte, want [32]byte) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range want {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
