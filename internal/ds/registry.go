package ds

import (
	"context"
	"errors"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
)

type RegisterRequest struct {
	Session     Session
	GroupID     id.ID
	Binding     []byte
	GroupInfo   []byte
	RatchetTree []byte
}

type RegisterResult struct {
	GroupID id.ID
	NextSeq uint64
}

// Register is invariant 1. group_id is 16 bytes chosen by the creating device; the registry
// enforces uniqueness and binds it to the dilla_binding the GroupInfo carries.
func (d *DS) Register(ctx context.Context, r RegisterRequest) (RegisterResult, error) {
	unlock := d.lock(r.GroupID)
	defer unlock()

	if _, err := d.opts.Store.GetGroup(ctx, r.GroupID); err == nil {
		return RegisterResult{}, errGroupExists(r.GroupID.String())
	} else if !errors.Is(err, store.ErrNotFound) {
		return RegisterResult{}, err
	}

	inst, err := d.opts.Wasm.Acquire(ctx)
	if err != nil {
		return RegisterResult{}, err
	}
	release := true
	defer func() {
		if release {
			inst.Release()
		}
	}()

	// from_external is correct here and only here: registration is the one moment the DS has no
	// state of its own and the creator uploads the tree (invariant 2).
	group, err := inst.PublicGroupFromExternal(ctx, r.RatchetTree, r.GroupInfo)
	if err != nil {
		return RegisterResult{}, errInvalid("group_info or ratchet_tree: " + err.Error())
	}
	closeGroup := true
	defer func() {
		if closeGroup {
			_ = group.Close(ctx)
		}
	}()
	state, err := group.State(ctx)
	if err != nil {
		return RegisterResult{}, err
	}

	// The body's binding must be byte-identical to extension 0xF001 inside the group context: a
	// client that signs one binding and declares another is exactly the confusion the extension
	// exists to prevent.
	if string(state.Binding) != string(r.Binding) {
		return RegisterResult{}, errBinding("the body's binding is not the group context's dilla_binding")
	}
	if string(state.GroupID) != string(r.GroupID[:]) {
		return RegisterResult{}, errBinding("group_id does not match the GroupInfo's")
	}

	binding, err := decodeBinding(r.Binding)
	if err != nil {
		return RegisterResult{}, errBinding("undecodable dilla_binding: " + err.Error())
	}
	if err := d.checkChannelMode(ctx, binding); err != nil {
		return RegisterResult{}, err
	}

	row := store.GroupRow{
		GroupID: r.GroupID,
		// Deviation B11: the column is a BLOB and holds the binding's own CBOR bytes. It is not
		// re-encoded from the struct: what the group context signed is what is stored.
		Binding:     r.Binding,
		Kind:        binding.Kind,
		CommunityID: binding.CommunityID,
		TargetID:    binding.TargetID,
		// R9 puts the call id in a companion column, not in the binding: `dilla_binding` has no
		// slot for one. A call group's CallID comes from the request's own target, which for
		// GroupKind Call is the call id.
		CallID:              callIDOf(binding),
		Ciphersuite:         1,
		Epoch:               state.Epoch,
		Seq:                 0,
		GroupInfoBlob:       r.GroupInfo,
		TreeHash:            state.TreeHash,
		ExternalSenderKeyID: d.opts.Keys.ExternalSenderKeyID,
		E2EEVersion:         binding.E2EEVersion,
		MediaVersion:        binding.MediaVersion,
		// NV10: the DS records policy_version at registration and does not refuse a stale value;
		// the refusal arrives when policy_version becomes mutable (Plan 2 task 1).
		PolicyVersion: binding.PolicyVersion,
		Created:       d.now(),
	}
	// R12: the group row, its state blob AND its member rows are one transaction. The member
	// write is not deferred until after the commit: `leafOf` is built on `ListMembers`, so a
	// registered group with no member rows refuses every later commit, proposal and upload from
	// its own creator with E_LEAF_NOT_CURRENT. Only the two gateway calls, which are in-memory
	// and idempotent, happen outside it.
	var members memberView
	err = d.opts.Store.Tx(ctx, func(tx store.Repository) error {
		if err := tx.CreateGroup(ctx, row); err != nil {
			return err
		}
		if err := persistState(ctx, tx, r.GroupID, group, r.GroupInfo); err != nil {
			return err
		}
		var mErr error
		members, mErr = d.replaceMembersTx(ctx, tx, r.GroupID, state)
		return mErr
	})
	if err != nil {
		return RegisterResult{}, err
	}

	if d.opts.Gateway != nil {
		d.opts.Gateway.SetGroupMembers(r.GroupID, members.devices)
		d.opts.Gateway.SetGroupLeaves(r.GroupID, members.leaves)
	}

	if err := d.states.put(ctx, r.GroupID, inst, group); err != nil {
		return RegisterResult{}, err
	}
	release = false
	closeGroup = false
	return RegisterResult{GroupID: r.GroupID, NextSeq: row.Seq + 1}, nil
}

// Channels is the sliver of `store.Structure` invariant 1 needs. It is an injected interface, not
// a `store.Repository` call, because `store.Structure` and its `channels` table arrive in Plan 2
// (`interfaces.md` §4.1: "declared by Plan 1 and implemented from Plan 2 task 1 onward"; the
// table is created by `006_structure.sql`). Calling `d.opts.Store.GetChannel` here would not
// compile against a Plan-1 `store.Repository`, and against a Plan-1 database it would fail with
// `no such table: channels` — not `store.ErrNotFound` — so every Register would 500.
//
// Plan 1 injects `PermissiveChannels{}`, which reports "no channel row" for everything; Plan 2
// task 2 — the task that creates the channels table, not its task 1, which creates communities —
// replaces it with the real `store.Structure` and greens the mode tests. NV-B5 tracks the
// hand-over.
type Channels interface {
	// Channel returns the channel's visibility and mode, or ErrNoChannel when the target is not a
	// channel at all (a DM or a pairing group has no channel row).
	Channel(ctx context.Context, targetID id.ID) (visibility, mode uint8, err error)
}

// ErrNoChannel is what a Channels implementation returns for a target that is not a channel.
var ErrNoChannel = errors.New("ds: no channel row")

// checkChannelMode is invariant 1's refusal. A call group is allowed on any channel; a text group
// is refused when the channel's visibility is invite or discoverable, or its mode is readable.
func (d *DS) checkChannelMode(ctx context.Context, b Binding) error {
	const (
		kindText     = 0
		modeReadable = 1
	)
	if b.Kind != kindText {
		return nil
	}
	visibility, mode, err := d.opts.Channels.Channel(ctx, b.TargetID)
	if errors.Is(err, ErrNoChannel) {
		// DMs and pairing groups have no channel row; only a text group bound to a channel is
		// subject to the mode rule.
		return nil
	}
	if err != nil {
		return err
	}
	if mode == modeReadable || visibility != 0 {
		return errModeReadable()
	}
	return nil
}

type memberView struct {
	devices []id.ID
	leaves  map[id.ID]uint32
}

// replaceMembersTx rewrites mls_members from the PublicGroup's own view inside the caller's
// transaction and returns the fan-out list. The credential identity is the core's ten-element
// CredentialIdentity CBOR (`core/dilla-core/src/identity/credential.rs:28-42`), decoded by
// decodeCredentialIdentity.
func (d *DS) replaceMembersTx(ctx context.Context, tx store.Repository, groupID id.ID, state mlswasi.GroupState) (memberView, error) {
	rows := make([]store.MemberRow, 0, len(state.Members))
	view := memberView{leaves: map[id.ID]uint32{}}
	for _, m := range state.Members {
		deviceID, userID, err := decodeCredentialIdentity(m.CredentialIdentity)
		if err != nil {
			return memberView{}, errCommitInvalid("credential_identity", err.Error())
		}
		rows = append(rows, store.MemberRow{
			GroupID:      groupID,
			LeafIndex:    m.LeafIndex,
			UserID:       userID,
			DeviceID:     deviceID,
			SignatureKey: m.SignatureKey,
			AddedEpoch:   state.Epoch,
		})
		view.devices = append(view.devices, deviceID)
		view.leaves[deviceID] = m.LeafIndex
	}
	if err := tx.ReplaceMembers(ctx, groupID, state.Epoch, rows); err != nil {
		return memberView{}, err
	}
	return view, nil
}

type GroupInfo struct {
	Epoch     uint64
	GroupInfo []byte
	TreeHash  []byte
	NextSeq   uint64
}

// requireMember is the read-path authorisation every group-scoped GET shares. A caller whose
// device is not a current member is answered E_NOT_FOUND, not E_FORBIDDEN, so group existence is
// not probeable: a 403 here would tell any authenticated device on the instance which group ids
// are live.
//
// Without it `info`, `tree`, `handshakes` and `messages` would let any authenticated device read
// another group's ratchet tree, its whole handshake log and its application ciphertext,
// commitments and franking tags — enough to correlate membership and message timing across
// communities. protocol/02 requires a device session on every endpoint in the document and the
// ACL on top.
func (d *DS) requireMember(ctx context.Context, groupID id.ID, session Session) error {
	members, err := d.opts.Store.ListMembers(ctx, groupID)
	if err != nil {
		return err
	}
	for _, m := range members {
		if m.DeviceID == session.DeviceID {
			return nil
		}
	}
	return errNotFound("group")
}

func (d *DS) Info(ctx context.Context, groupID id.ID, session Session) (GroupInfo, error) {
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return GroupInfo{}, errNotFound("group")
	}
	if err != nil {
		return GroupInfo{}, err
	}
	if err := d.requireMember(ctx, groupID, session); err != nil {
		return GroupInfo{}, err
	}
	return GroupInfo{
		Epoch:     row.Epoch,
		GroupInfo: row.GroupInfoBlob,
		TreeHash:  row.TreeHash,
		NextSeq:   row.Seq + 1,
	}, nil
}

type Tree struct {
	Epoch       uint64
	RatchetTree []byte
	TreeHash    []byte
}

// Tree is invariant 2: the DS serves the tree from its own PublicGroup, not from anything a
// committer uploaded.
//
// It takes the group lock like every other path that enters withGroup. Two concurrent
// GET /v1/groups/{id}/tree — the ordinary joiner path — otherwise reach the same
// mlswasi.Instance at once, which the package forbids; the handle lock inside withGroup is the
// second line of defence, and this one keeps the whole read sequence serialised with commits.
func (d *DS) Tree(ctx context.Context, groupID id.ID, session Session) (Tree, error) {
	unlock := d.lock(groupID)
	defer unlock()
	if err := d.requireMember(ctx, groupID, session); err != nil {
		return Tree{}, err
	}
	var out Tree
	err := d.withGroup(ctx, groupID, func(g *mlswasi.PublicGroup) error {
		tree, hash, epoch, err := g.Tree(ctx)
		if err != nil {
			return err
		}
		out = Tree{Epoch: epoch, RatchetTree: tree, TreeHash: hash}
		return nil
	})
	if errors.Is(err, store.ErrNotFound) {
		return Tree{}, errNotFound("group")
	}
	return out, err
}

func (d *DS) Close(ctx context.Context, groupID id.ID) error {
	unlock := d.lock(groupID)
	defer unlock()
	if err := d.opts.Store.CloseGroup(ctx, groupID, d.now()); err != nil {
		return err
	}
	return d.states.evict(ctx, groupID)
}
