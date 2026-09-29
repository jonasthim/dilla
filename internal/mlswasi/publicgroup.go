package mlswasi

import (
	"context"
	"fmt"

	"github.com/fxamacker/cbor/v2"
)

// ProcessedKind is the `kind` field of a public_group_process response.
type ProcessedKind uint8

const (
	KindProposal     ProcessedKind = 0
	KindCommit       ProcessedKind = 1
	KindExternalJoin ProcessedKind = 2
	KindRejected     ProcessedKind = 3
)

// ProposalKind is the RFC 9420 proposal type as protocol/02-delivery-service.md numbers it.
type ProposalKind uint8

const (
	ProposalAdd                    ProposalKind = 1
	ProposalUpdate                 ProposalKind = 2
	ProposalRemove                 ProposalKind = 3
	ProposalPSK                    ProposalKind = 4
	ProposalReInit                 ProposalKind = 5
	ProposalExternalInit           ProposalKind = 6
	ProposalGroupContextExtensions ProposalKind = 7
)

// AppliedProposal is one proposal a commit resolved. TargetLeaf is set for Remove only;
// CredentialIdentity is the added leaf's credential identity, for Add only.
type AppliedProposal struct {
	ProposalRef        []byte
	Kind               ProposalKind
	SenderLeaf         *uint32
	TargetLeaf         *uint32
	CredentialIdentity []byte
}

// Processed is one processed handshake message.
type Processed struct {
	Kind             ProcessedKind
	Epoch            uint64
	SenderLeaf       *uint32
	Staged           *uint32
	ProposalRef      []byte
	Applied          []AppliedProposal // empty unless Kind == KindCommit
	CommitterUpdated bool              // the commit carries an UpdatePath
	// NewLeaf is the leaf an EXTERNAL commit's joiner lands on once the commit is merged, and nil
	// for everything else (ABI v3). An external commit names no sender leaf, so this is the only
	// way the delivery service learns which leaf the joiner will hold.
	NewLeaf *uint32
}

// DeviceListEntry is one entry of a user's signed device list, as device_list_entries reports
// it after the guest has decoded the list and verified its ssk_signature (NV-B8).
type DeviceListEntry struct {
	DeviceID []byte
	DSKPub   []byte
	Tier     uint8
	Revoked  bool
}

// GroupInfoCheck is the public_group_group_info_validate response. SignatureOK false is a
// verification failure, not a transport error: dillad answers 422 E_COMMIT_INVALID with
// rule = "group_info_signature".
type GroupInfoCheck struct {
	Epoch                   uint64
	GroupID                 []byte
	TreeHash                []byte
	ConfirmedTranscriptHash []byte
	SignatureOK             bool
}

// ProposalDetail is the public_group_proposal_inspect response.
type ProposalDetail struct {
	Kind               ProposalKind
	SenderLeaf         *uint32
	TargetLeaf         *uint32
	CredentialIdentity []byte
}

// PrivateMessageMeta is the private_message_aad response.
type PrivateMessageMeta struct {
	AuthenticatedData []byte
	Epoch             uint64
	ContentType       uint8
}

// Member is one leaf of the public tree.
type Member struct {
	LeafIndex          uint32
	SignatureKey       []byte
	CredentialIdentity []byte
}

// GroupState is the public_group_state response.
type GroupState struct {
	Epoch    uint64
	GroupID  []byte
	TreeHash []byte
	Binding  []byte
	Members  []Member
}

// KeyPackageInfo is the validate_key_package response.
type KeyPackageInfo struct {
	DeviceID   []byte
	UserID     []byte
	LastResort bool
	NotAfter   uint64
	KPRef      []byte // the RFC 9420 KeyPackageRef, the key_packages primary key
}

func rawProposalKind(raw cbor.RawMessage) (ProposalKind, error) {
	v, err := rawUint(raw)
	if err != nil {
		return 0, err
	}
	if v < uint64(ProposalAdd) || v > uint64(ProposalGroupContextExtensions) {
		return 0, fmt.Errorf("mlswasi: proposal kind %d is outside 1..7", v)
	}
	return ProposalKind(v), nil
}

func decodeApplied(raw cbor.RawMessage) ([]AppliedProposal, error) {
	items, err := rawArray(raw)
	if err != nil {
		return nil, err
	}
	out := make([]AppliedProposal, 0, len(items))
	for _, item := range items {
		fields, err := rawArray(item)
		if err != nil {
			return nil, err
		}
		if err := expectLen(fields, 5, "applied proposal"); err != nil {
			return nil, err
		}
		var a AppliedProposal
		if a.ProposalRef, err = rawBytes(fields[0]); err != nil {
			return nil, err
		}
		if a.Kind, err = rawProposalKind(fields[1]); err != nil {
			return nil, err
		}
		if a.SenderLeaf, err = rawOptUint32(fields[2]); err != nil {
			return nil, err
		}
		if a.TargetLeaf, err = rawOptUint32(fields[3]); err != nil {
			return nil, err
		}
		if a.CredentialIdentity, err = rawOptBytes(fields[4]); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, nil
}

// PublicGroup is a handle into one instance's module memory. It is valid only
// inside the instance that created it and only until Close.
type PublicGroup struct {
	inst   *Instance
	handle uint32
}

// PublicGroupFromExternal imports a ratchet tree and a GroupInfo, the DS's
// restore path.
func (i *Instance) PublicGroupFromExternal(ctx context.Context, ratchetTree, groupInfo []byte) (*PublicGroup, error) {
	elems, err := i.call(ctx, "public_group_create", ratchetTree, groupInfo)
	if err != nil {
		return nil, err
	}
	if err := expectLen(elems, 6, "public_group_create"); err != nil {
		return nil, err
	}
	handle, err := rawUint32(elems[1])
	if err != nil {
		return nil, err
	}
	return &PublicGroup{inst: i, handle: handle}, nil
}

// PublicGroupImport restores a group from a versioned state blob produced by
// ExportState.
func (i *Instance) PublicGroupImport(ctx context.Context, state, groupID []byte) (*PublicGroup, error) {
	elems, err := i.call(ctx, "public_group_import_state", state, groupID)
	if err != nil {
		return nil, err
	}
	if err := expectLen(elems, 3, "public_group_import_state"); err != nil {
		return nil, err
	}
	handle, err := rawUint32(elems[1])
	if err != nil {
		return nil, err
	}
	return &PublicGroup{inst: i, handle: handle}, nil
}

// ExportState returns the versioned state blob dillad persists.
func (g *PublicGroup) ExportState(ctx context.Context) ([]byte, error) {
	elems, err := g.inst.call(ctx, "public_group_export_state", uint64(g.handle))
	if err != nil {
		return nil, err
	}
	if err := expectLen(elems, 2, "public_group_export_state"); err != nil {
		return nil, err
	}
	return rawBytes(elems[1])
}

// Close releases the handle inside the guest.
func (g *PublicGroup) Close(ctx context.Context) error {
	elems, err := g.inst.call(ctx, "public_group_close", uint64(g.handle))
	if err != nil {
		return err
	}
	return expectLen(elems, 1, "public_group_close")
}

// Process validates one MLS handshake message against the public state. It
// writes nothing: a commit yields a staged handle that Merge consumes.
func (g *PublicGroup) Process(ctx context.Context, mlsMessage []byte) (Processed, error) {
	elems, err := g.inst.call(ctx, "public_group_process", uint64(g.handle), mlsMessage)
	if err != nil {
		return Processed{}, err
	}
	if err := expectLen(elems, 9, "public_group_process"); err != nil {
		return Processed{}, err
	}
	kind, err := rawUint(elems[1])
	if err != nil {
		return Processed{}, err
	}
	if kind > uint64(KindRejected) {
		return Processed{}, fmt.Errorf("mlswasi: unknown processed kind %d", kind)
	}
	p := Processed{Kind: ProcessedKind(kind)}
	if p.Epoch, err = rawUint(elems[2]); err != nil {
		return Processed{}, err
	}
	if p.SenderLeaf, err = rawOptUint32(elems[3]); err != nil {
		return Processed{}, err
	}
	if p.Staged, err = rawOptUint32(elems[4]); err != nil {
		return Processed{}, err
	}
	if p.ProposalRef, err = rawOptBytes(elems[5]); err != nil {
		return Processed{}, err
	}
	if p.Applied, err = decodeApplied(elems[6]); err != nil {
		return Processed{}, err
	}
	if p.CommitterUpdated, err = rawBool(elems[7]); err != nil {
		return Processed{}, err
	}
	if p.NewLeaf, err = rawOptUint32(elems[8]); err != nil {
		return Processed{}, err
	}
	return p, nil
}

// Merge applies a staged commit and returns the new epoch.
func (g *PublicGroup) Merge(ctx context.Context, staged uint32) (uint64, error) {
	elems, err := g.inst.call(ctx, "public_group_merge", uint64(g.handle), uint64(staged))
	if err != nil {
		return 0, err
	}
	if err := expectLen(elems, 2, "public_group_merge"); err != nil {
		return 0, err
	}
	return rawUint(elems[1])
}

// Tree exports the ratchet tree the DS serves to joiners.
func (g *PublicGroup) Tree(ctx context.Context) (tree, treeHash []byte, epoch uint64, err error) {
	elems, err := g.inst.call(ctx, "public_group_tree", uint64(g.handle))
	if err != nil {
		return nil, nil, 0, err
	}
	if err := expectLen(elems, 4, "public_group_tree"); err != nil {
		return nil, nil, 0, err
	}
	if tree, err = rawBytes(elems[1]); err != nil {
		return nil, nil, 0, err
	}
	if treeHash, err = rawBytes(elems[2]); err != nil {
		return nil, nil, 0, err
	}
	if epoch, err = rawUint(elems[3]); err != nil {
		return nil, nil, 0, err
	}
	return tree, treeHash, epoch, nil
}

// State returns the epoch, identifiers, dilla_binding and members.
func (g *PublicGroup) State(ctx context.Context) (GroupState, error) {
	elems, err := g.inst.call(ctx, "public_group_state", uint64(g.handle))
	if err != nil {
		return GroupState{}, err
	}
	if err := expectLen(elems, 6, "public_group_state"); err != nil {
		return GroupState{}, err
	}
	var s GroupState
	if s.Epoch, err = rawUint(elems[1]); err != nil {
		return GroupState{}, err
	}
	if s.GroupID, err = rawBytes(elems[2]); err != nil {
		return GroupState{}, err
	}
	if s.TreeHash, err = rawBytes(elems[3]); err != nil {
		return GroupState{}, err
	}
	if s.Binding, err = rawBytes(elems[4]); err != nil {
		return GroupState{}, err
	}
	members, err := rawArray(elems[5])
	if err != nil {
		return GroupState{}, err
	}
	s.Members = make([]Member, 0, len(members))
	for _, rawMember := range members {
		fields, err := rawArray(rawMember)
		if err != nil {
			return GroupState{}, err
		}
		if err := expectLen(fields, 3, "public_group_state member"); err != nil {
			return GroupState{}, err
		}
		var m Member
		if m.LeafIndex, err = rawUint32(fields[0]); err != nil {
			return GroupState{}, err
		}
		if m.SignatureKey, err = rawBytes(fields[1]); err != nil {
			return GroupState{}, err
		}
		if m.CredentialIdentity, err = rawBytes(fields[2]); err != nil {
			return GroupState{}, err
		}
		s.Members = append(s.Members, m)
	}
	return s, nil
}

// ProposalPut adds (op 0, blob = the proposal), removes (op 1, blob = the
// proposal ref) or clears (op 2, blob = nil) the guest's proposal queue.
func (g *PublicGroup) ProposalPut(ctx context.Context, op uint8, blob []byte) ([]byte, error) {
	var arg any = blob
	if blob == nil {
		arg = nil
	}
	elems, err := g.inst.call(ctx, "public_group_proposal_put", uint64(g.handle), uint64(op), arg)
	if err != nil {
		return nil, err
	}
	if err := expectLen(elems, 2, "public_group_proposal_put"); err != nil {
		return nil, err
	}
	return rawOptBytes(elems[1])
}

// ProposalList returns the queued proposals as (ref, proposal) pairs.
func (g *PublicGroup) ProposalList(ctx context.Context) ([][2][]byte, error) {
	elems, err := g.inst.call(ctx, "public_group_proposal_list", uint64(g.handle))
	if err != nil {
		return nil, err
	}
	if err := expectLen(elems, 2, "public_group_proposal_list"); err != nil {
		return nil, err
	}
	rows, err := rawArray(elems[1])
	if err != nil {
		return nil, err
	}
	out := make([][2][]byte, 0, len(rows))
	for _, row := range rows {
		pair, err := rawArray(row)
		if err != nil {
			return nil, err
		}
		if err := expectLen(pair, 2, "proposal pair"); err != nil {
			return nil, err
		}
		ref, err := rawBytes(pair[0])
		if err != nil {
			return nil, err
		}
		proposal, err := rawBytes(pair[1])
		if err != nil {
			return nil, err
		}
		out = append(out, [2][]byte{ref, proposal})
	}
	return out, nil
}

// ValidateKeyPackage runs the RFC 9420 validation plus dilla's own checks.
func (i *Instance) ValidateKeyPackage(ctx context.Context, keyPackage []byte) (KeyPackageInfo, error) {
	elems, err := i.call(ctx, "validate_key_package", keyPackage)
	if err != nil {
		return KeyPackageInfo{}, err
	}
	if err := expectLen(elems, 6, "validate_key_package"); err != nil {
		return KeyPackageInfo{}, err
	}
	var info KeyPackageInfo
	if info.DeviceID, err = rawBytes(elems[1]); err != nil {
		return KeyPackageInfo{}, err
	}
	if info.UserID, err = rawBytes(elems[2]); err != nil {
		return KeyPackageInfo{}, err
	}
	if info.LastResort, err = rawBool(elems[3]); err != nil {
		return KeyPackageInfo{}, err
	}
	if info.NotAfter, err = rawUint(elems[4]); err != nil {
		return KeyPackageInfo{}, err
	}
	if info.KPRef, err = rawBytes(elems[5]); err != nil {
		return KeyPackageInfo{}, err
	}
	return info, nil
}

// ExternalProposeAdd signs an external Add proposal as the instance.
func (i *Instance) ExternalProposeAdd(ctx context.Context, groupID []byte, epoch uint64, keyPackage, signingKey []byte) ([]byte, error) {
	elems, err := i.call(ctx, "external_propose_add", groupID, epoch, keyPackage, signingKey)
	if err != nil {
		return nil, err
	}
	if err := expectLen(elems, 2, "external_propose_add"); err != nil {
		return nil, err
	}
	return rawBytes(elems[1])
}

// ExternalProposeRemove signs an external Remove proposal as the instance.
func (i *Instance) ExternalProposeRemove(ctx context.Context, groupID []byte, epoch uint64, leafIndex uint32, signingKey []byte) ([]byte, error) {
	elems, err := i.call(ctx, "external_propose_remove", groupID, epoch, uint64(leafIndex), signingKey)
	if err != nil {
		return nil, err
	}
	if err := expectLen(elems, 2, "external_propose_remove"); err != nil {
		return nil, err
	}
	return rawBytes(elems[1])
}

// ValidateGroupInfo verifies an uploaded GroupInfo against the signature key the DS already holds
// for signerLeaf. The caller names the leaf because VerifiableGroupInfo::signer() is pub(crate) in
// OpenMLS 0.9.0; dillad always has it, from the public_group_process that returned it for the
// commit this GroupInfo accompanies (interfaces.md §0.1 D17).
func (g *PublicGroup) ValidateGroupInfo(ctx context.Context, groupInfo []byte, signerLeaf uint32) (GroupInfoCheck, error) {
	elems, err := g.inst.call(ctx, "public_group_group_info_validate",
		uint64(g.handle), groupInfo, uint64(signerLeaf))
	if err != nil {
		return GroupInfoCheck{}, err
	}
	return decodeGroupInfoCheck(elems, "public_group_group_info_validate")
}

// ValidateStagedGroupInfo verifies an uploaded GroupInfo against the key the COMMITTER of the
// staged commit holds in the epoch that commit produces (ABI v3). It is the check invariant 4
// step (6) needs on the external path: the joiner of an external commit is in no leaf of the
// current tree, so ValidateGroupInfo has no key to check against, and its key exists only in the
// staged commit's UpdatePath. The staged handle is read, never consumed.
func (g *PublicGroup) ValidateStagedGroupInfo(ctx context.Context, staged uint32, groupInfo []byte) (GroupInfoCheck, error) {
	elems, err := g.inst.call(ctx, "public_group_staged_group_info_validate",
		uint64(g.handle), uint64(staged), groupInfo)
	if err != nil {
		return GroupInfoCheck{}, err
	}
	return decodeGroupInfoCheck(elems, "public_group_staged_group_info_validate")
}

// DeviceListEntries decodes a user's signed device list inside the guest, verifies its
// ssk_signature against sskPub and that it names userID, and returns every entry, revoked ones
// flagged (ABI v3, NV-B8). A list that does not verify is an *ABIError with code E_CREDENTIAL.
func (i *Instance) DeviceListEntries(ctx context.Context, list, sskPub, userID []byte) ([]DeviceListEntry, error) {
	elems, err := i.call(ctx, "device_list_entries", list, sskPub, userID)
	if err != nil {
		return nil, err
	}
	if err := expectLen(elems, 2, "device_list_entries"); err != nil {
		return nil, err
	}
	rows, err := rawArray(elems[1])
	if err != nil {
		return nil, err
	}
	out := make([]DeviceListEntry, 0, len(rows))
	for _, row := range rows {
		fields, err := rawArray(row)
		if err != nil {
			return nil, err
		}
		if err := expectLen(fields, 4, "device list entry"); err != nil {
			return nil, err
		}
		var e DeviceListEntry
		if e.DeviceID, err = rawBytes(fields[0]); err != nil {
			return nil, err
		}
		if e.DSKPub, err = rawBytes(fields[1]); err != nil {
			return nil, err
		}
		tier, err := rawUint(fields[2])
		if err != nil {
			return nil, err
		}
		if tier > 255 {
			return nil, fmt.Errorf("mlswasi: device list tier %d does not fit a byte", tier)
		}
		e.Tier = uint8(tier)
		if e.Revoked, err = rawBool(fields[3]); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

// DeviceListEntries is Instance.DeviceListEntries on the instance this group lives in, for a caller
// that holds the group and must not acquire a second instance to verify a device list with.
func (g *PublicGroup) DeviceListEntries(ctx context.Context, list, sskPub, userID []byte) ([]DeviceListEntry, error) {
	return g.inst.DeviceListEntries(ctx, list, sskPub, userID)
}

func decodeGroupInfoCheck(elems []cbor.RawMessage, what string) (GroupInfoCheck, error) {
	if err := expectLen(elems, 6, what); err != nil {
		return GroupInfoCheck{}, err
	}
	var err error
	var c GroupInfoCheck
	if c.Epoch, err = rawUint(elems[1]); err != nil {
		return GroupInfoCheck{}, err
	}
	if c.GroupID, err = rawBytes(elems[2]); err != nil {
		return GroupInfoCheck{}, err
	}
	if c.TreeHash, err = rawBytes(elems[3]); err != nil {
		return GroupInfoCheck{}, err
	}
	if c.ConfirmedTranscriptHash, err = rawBytes(elems[4]); err != nil {
		return GroupInfoCheck{}, err
	}
	if c.SignatureOK, err = rawBool(elems[5]); err != nil {
		return GroupInfoCheck{}, err
	}
	return c, nil
}

// ProposalInspect reports the kind and target of one queued proposal. The DS calls it on
// POST /v1/groups/{id}/proposal only: for its own proposals it knows both by construction.
func (g *PublicGroup) ProposalInspect(ctx context.Context, proposalRef []byte) (ProposalDetail, error) {
	elems, err := g.inst.call(ctx, "public_group_proposal_inspect", uint64(g.handle), proposalRef)
	if err != nil {
		return ProposalDetail{}, err
	}
	if err := expectLen(elems, 5, "public_group_proposal_inspect"); err != nil {
		return ProposalDetail{}, err
	}
	var d ProposalDetail
	if d.Kind, err = rawProposalKind(elems[1]); err != nil {
		return ProposalDetail{}, err
	}
	if d.SenderLeaf, err = rawOptUint32(elems[2]); err != nil {
		return ProposalDetail{}, err
	}
	if d.TargetLeaf, err = rawOptUint32(elems[3]); err != nil {
		return ProposalDetail{}, err
	}
	if d.CredentialIdentity, err = rawOptBytes(elems[4]); err != nil {
		return ProposalDetail{}, err
	}
	return d, nil
}

// Discard releases a staged commit the caller decided not to merge. Every DS refusal path after
// Process must call it — Merge is the only other consumer of a staged handle, and merging is
// exactly what a refusal must not do, so without Discard a client that retries a malformed commit
// in a loop grows the guest's handle table without bound. Discarding an unknown handle is an
// *ABIError with code E_ABI_HANDLE.
func (g *PublicGroup) Discard(ctx context.Context, staged uint32) error {
	elems, err := g.inst.call(ctx, "public_group_staged_discard", uint64(g.handle), uint64(staged))
	if err != nil {
		return err
	}
	return expectLen(elems, 1, "public_group_staged_discard")
}

// PoolSize is how many instances Acquire can hand out at once. It is read by internal/ds, whose
// live-group cache must stay strictly below it or Acquire blocks forever.
func (r *Runtime) PoolSize() int { return r.poolSize }

// PrivateMessageAAD reads the 32-byte franking commitment and the epoch out of a PrivateMessage
// without decrypting it. A message whose authenticated_data is not exactly 32 bytes comes back as
// an *ABIError with code E_ABI_SHAPE, which the DS maps to 422 E_COMMITMENT_INVALID.
func (i *Instance) PrivateMessageAAD(ctx context.Context, privateMessage []byte) (PrivateMessageMeta, error) {
	elems, err := i.call(ctx, "private_message_aad", privateMessage)
	if err != nil {
		return PrivateMessageMeta{}, err
	}
	if err := expectLen(elems, 4, "private_message_aad"); err != nil {
		return PrivateMessageMeta{}, err
	}
	var m PrivateMessageMeta
	if m.AuthenticatedData, err = rawBytes(elems[1]); err != nil {
		return PrivateMessageMeta{}, err
	}
	if m.Epoch, err = rawUint(elems[2]); err != nil {
		return PrivateMessageMeta{}, err
	}
	contentType, err := rawUint(elems[3])
	if err != nil {
		return PrivateMessageMeta{}, err
	}
	// RFC 9420's ContentType is 1 application, 2 proposal, 3 commit; 0 is `reserved`.
	if contentType < 1 || contentType > 3 {
		return PrivateMessageMeta{}, fmt.Errorf("mlswasi: content_type %d is outside 1..3", contentType)
	}
	m.ContentType = uint8(contentType)
	return m, nil
}
