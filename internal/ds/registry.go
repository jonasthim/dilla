package ds

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"

	"github.com/jonasthim/dilla/internal/auth"
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
	defer d.flushEvictions(ctx, r.GroupID) // after the unlock below: defers run last-in, first-out
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
	// Invariant 1's instance_id: a group bound to another instance is that instance's group, and
	// registering it here would let a client carry one instance's binding — and every signature
	// over it — into another. (The external_senders check needs an ABI accessor; follow-up card.)
	if binding.InstanceID != d.opts.Keys.InstanceID {
		return RegisterResult{}, errBinding(fmt.Sprintf(
			"dilla_binding names instance %s; this instance is %s", binding.InstanceID, d.opts.Keys.InstanceID))
	}
	if err := d.checkChannelMode(ctx, binding); err != nil {
		return RegisterResult{}, err
	}
	// The registration ACL runs after the mode rule, so a text group on a readable channel is
	// E_MODE_READABLE whoever registers it, and before anything is written.
	if err := d.checkRegistrant(ctx, r.Session.UserID, binding); err != nil {
		return RegisterResult{}, err
	}
	// One text group per end-to-end-encrypted channel, one call group per voice channel
	// (protocol/01 § Group kinds). The target lock is held until the group row is written, so two
	// first registrations for one target cannot both pass the check; it is always taken after the
	// group lock and nothing takes the two in the other order.
	if isChannelGroupKind(binding.Kind) {
		unlockTarget := d.lockTarget(binding.Kind, binding.TargetID)
		defer unlockTarget()
		if err := d.checkNoLiveGroup(ctx, r.Session.UserID, binding); err != nil {
			return RegisterResult{}, err
		}
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
		members, mErr = d.replaceMembersTx(ctx, tx, r.GroupID, binding.Kind, state)
		return mErr
	})
	if err != nil {
		return RegisterResult{}, err
	}
	// Always empty for a fresh group; the writer is treated like the other member-set writers.
	d.queueEviction(r.GroupID, members.removed)

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

// Channels is the sliver of the community structure registration needs: invariant 1's channel
// mode, and the registration ACL. It is an injected interface, not a `store.Repository` call,
// because the delivery service deliberately does not learn the channel vocabulary (kinds,
// visibilities, communities, membership): that lives in internal/api, whose
// `api.StructureChannels` is the production implementation over the `channels`, `communities`
// and `members` tables (Plan 2 task 2, which retired Plan 1's `PermissiveChannels` stub, NV-B5).
// The composition root injects it; a DS built without one refuses every registration.
type Channels interface {
	// Channel returns the channel's visibility and mode, or ErrNoChannel when the target is not a
	// channel at all (a DM or a pairing group has no channel row).
	Channel(ctx context.Context, targetID id.ID) (visibility, mode uint8, err error)
	// MayRegister is the registration ACL (Plan 1 follow-up card 14, "any enrolled device may
	// register any group"): may userID register a group bound by b? nil admits. An error wrapping
	// ErrNotEligible refuses with 403 E_FORBIDDEN, one wrapping ErrBindingTarget with 400
	// E_BINDING_INVALID, and any other error means "the source cannot answer", which Register
	// returns as it is — a refusal, never a pass.
	MayRegister(ctx context.Context, userID id.ID, b Binding) error
}

var (
	// ErrNoChannel is what a Channels implementation returns for a target that is not a channel.
	ErrNoChannel = errors.New("ds: no channel row")
	// ErrNotEligible is MayRegister's "this user may not register this group": not a member of
	// the community the binding names, for instance.
	ErrNotEligible = errors.New("not eligible to register this group")
	// ErrBindingTarget is MayRegister's "the binding names no target this group kind can be
	// registered for": a channel of another community, a text group on a voice channel, or a
	// community text group whose target is not a channel at all.
	ErrBindingTarget = errors.New("the binding names no registrable target")
)

// closedChannels is the channel source of a delivery service built without one: no target is a
// channel, and nobody may register anything. Plan 1 shipped a permissive stub here, because it
// had no channels table to read; the table exists now, so the default is the conservative one,
// as ACL's and DeviceLists' are.
type closedChannels struct{}

func (closedChannels) Channel(context.Context, id.ID) (visibility, mode uint8, err error) {
	return 0, 0, ErrNoChannel
}

func (closedChannels) MayRegister(context.Context, id.ID, Binding) error {
	return fmt.Errorf("%w: this delivery service has no channel source", ErrNotEligible)
}

// checkRegistrant is the registration ACL's call site: it asks the channel source and maps its
// two refusals onto the protocol's codes.
func (d *DS) checkRegistrant(ctx context.Context, userID id.ID, b Binding) error {
	err := d.opts.Channels.MayRegister(ctx, userID, b)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrNotEligible):
		return errForbidden(err.Error())
	case errors.Is(err, ErrBindingTarget):
		return errBinding(err.Error())
	default:
		return err
	}
}

// GroupRecreation is the optional half of Channels that invariant 11's re-creation path reads:
// "if no heal succeeds … the group is closed and re-created by the channel owner's device". While
// a restore's heal is pending, every open group of the target is epoch-unknown, and MayRecreate
// says whether userID is the one who may register its replacement (nil admits; an error wrapping
// ErrNotEligible refuses; any other error is "cannot answer"). A Channels that does not implement
// it admits no re-creation before the heal window closes the old group.
type GroupRecreation interface {
	MayRecreate(ctx context.Context, userID id.ID, b Binding) error
}

// isChannelGroupKind is true for the two kinds a channel or DM carries one of: text (0) and
// call (1). Pairing and interaction groups are not channel groups.
func isChannelGroupKind(kind uint8) bool { return kind == 0 || kind == 1 }

// checkNoLiveGroup refuses a registration whose target already has an open group of the same kind
// (409 E_GROUP_EXISTS). A second text group forks the channel's end-to-end encryption, and every
// registration starts an Add storm that spends one KeyPackage of every eligible device; a second
// call group takes over the live call, whose call id every call group of the channel shares. The
// one exception is invariant 11's: when every open group of the target is epoch-unknown, the
// registrant the channel source names (GroupRecreation) may re-create it.
func (d *DS) checkNoLiveGroup(ctx context.Context, userID id.ID, b Binding) error {
	groups, err := d.opts.Store.GroupsForTarget(ctx, b.TargetID, b.Kind)
	if err != nil {
		return err
	}
	if len(groups) == 0 {
		return nil
	}
	for _, g := range groups {
		if !g.EpochUnknown {
			return errGroupExists(fmt.Sprintf(
				"the target already has an open group of this kind (%s); a channel carries one", g.GroupID))
		}
	}
	rc, ok := d.opts.Channels.(GroupRecreation)
	if !ok {
		return errGroupExists("the target's group awaits its heal and this instance names no one to re-create it")
	}
	if err := rc.MayRecreate(ctx, userID, b); err != nil {
		if errors.Is(err, ErrNotEligible) {
			return errGroupExists("the target's group awaits its heal; only the channel owner's device may re-create it")
		}
		return err
	}
	return nil
}

// lockTarget serialises registrations of one kind of group for one target. Its locks live apart
// from the group locks, so a target id that happens to equal some group id cannot contend with,
// or deadlock against, that group's lock.
func (d *DS) lockTarget(kind uint8, target id.ID) func() {
	v, _ := d.targetLocks.LoadOrStore(targetKey{kind: kind, target: target}, &sync.Mutex{})
	// targetLocks only ever holds *sync.Mutex values stored by the line above.
	mu, _ := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

type targetKey struct {
	kind   uint8
	target id.ID
}

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
	// removed is, for a call group, every device that held a leaf before this write and holds none
	// after it — read before mls_members is rewritten, because a removed device has no row
	// afterwards and a resync's Remove of a device's old leaf is not a removal of the device (G29).
	removed []id.ID
}

// replaceMembersTx rewrites mls_members from the PublicGroup's own view inside the caller's
// transaction and returns the fan-out list and, for a call group (kind), the removed devices. The
// credential identity is the core's ten-element CredentialIdentity CBOR
// (`core/dilla-core/src/identity/credential.rs:28-42`), decoded by decodeCredentialIdentity.
//
// joined names the leaves this write's commit put a device into by external commit (an own-leaf
// resync or an external join): each starts a new membership at state.Epoch, whatever held the
// index before.
func (d *DS) replaceMembersTx(ctx context.Context, tx store.Repository, groupID id.ID, kind uint8, state mlswasi.GroupState, joined ...uint32) (memberView, error) {
	before, err := tx.ListMembers(ctx, groupID)
	if err != nil {
		return memberView{}, err
	}
	// added_epoch is the epoch the device took its leaf, kept across rewrites while the same device
	// holds the same leaf: it is what tells a membership from a later one at the same index
	// (ProposeRemoveOfMember). A device that left and came back starts a new membership.
	since := make(map[uint32]store.MemberRow, len(before))
	for _, m := range before {
		if m.RemovedEpoch == nil {
			since[m.LeafIndex] = m
		}
	}
	rows := make([]store.MemberRow, 0, len(state.Members))
	view := memberView{leaves: map[id.ID]uint32{}}
	for _, m := range state.Members {
		deviceID, userID, err := decodeCredentialIdentity(m.CredentialIdentity)
		if err != nil {
			return memberView{}, errCommitInvalid("credential_identity", err.Error())
		}
		added := state.Epoch
		if prev, ok := since[m.LeafIndex]; ok && prev.DeviceID == deviceID && prev.AddedEpoch <= state.Epoch &&
			!slices.Contains(joined, m.LeafIndex) {
			added = prev.AddedEpoch
		}
		rows = append(rows, store.MemberRow{
			GroupID:      groupID,
			LeafIndex:    m.LeafIndex,
			UserID:       userID,
			DeviceID:     deviceID,
			SignatureKey: m.SignatureKey,
			AddedEpoch:   added,
		})
		view.devices = append(view.devices, deviceID)
		view.leaves[deviceID] = m.LeafIndex
	}
	if err := tx.ReplaceMembers(ctx, groupID, state.Epoch, rows); err != nil {
		return memberView{}, err
	}
	for _, m := range before {
		if kind != groupKindCall {
			break
		}
		if _, still := view.leaves[m.DeviceID]; !still && !slices.Contains(view.removed, m.DeviceID) {
			view.removed = append(view.removed, m.DeviceID)
		}
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

// refuseQuarantined is invariant 9's flag, READ: a device three distinct reporters have
// quarantined is removed from the group by an instance Remove, and it must not read its way back
// in — the GroupInfo and the tree are exactly what a rejoin by external commit needs (deviation
// B36) — nor resync itself back into the epoch. E_FORBIDDEN, not E_NOT_FOUND: the answer is about
// the device, which already knows it was quarantined, not about the group. A device the instance
// holds no row for (the fixture's leaves) is not quarantined.
func (d *DS) refuseQuarantined(ctx context.Context, deviceID id.ID) error {
	row, err := d.opts.Store.GetDevice(ctx, deviceID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if row.QuarantinedAt != nil {
		return errForbidden("this device is quarantined by a fork quorum (invariant 9)")
	}
	return nil
}

// requireReader is requireMember widened by exactly one reader: a device whose user the channel
// ACL admits, which is who joins a text or call group by external commit (protocol/01 § Joining:
// "An online device joins by external commit using the GroupInfo and ratchet tree served by the
// DS"). The GroupInfo and the tree are the two reads such a join needs, so only Info and Tree take
// this path; the handshake log and the ciphertext stay member-only. A device the ACL does not
// admit is E_NOT_FOUND, exactly as a stranger is to requireMember, so existence is still not
// probeable. ds.DenyUnlessMember, Plan 1's ACL, admits only a user already in the group.
func (d *DS) requireReader(ctx context.Context, groupID id.ID, session Session) error {
	if err := d.refuseQuarantined(ctx, session.DeviceID); err != nil {
		return err
	}
	err := d.requireMember(ctx, groupID, session)
	if err == nil || session.Scope != auth.ScopeEnrolled {
		return err
	}
	ok, aclErr := d.opts.ACL.Eligible(ctx, groupID, session.UserID)
	if aclErr != nil || !ok {
		return err
	}
	return nil
}

func (d *DS) Info(ctx context.Context, groupID id.ID, session Session) (GroupInfo, error) {
	row, err := d.opts.Store.GetGroup(ctx, groupID)
	if errors.Is(err, store.ErrNotFound) {
		return GroupInfo{}, errNotFound("group")
	}
	if err != nil {
		return GroupInfo{}, err
	}
	if err := d.requireReader(ctx, groupID, session); err != nil {
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
	if err := d.requireReader(ctx, groupID, session); err != nil {
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
