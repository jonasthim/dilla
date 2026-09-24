package mlswasi

import (
	"context"
	"fmt"
)

// ProcessedKind is the `kind` field of a public_group_process response.
type ProcessedKind uint8

const (
	KindProposal     ProcessedKind = 0
	KindCommit       ProcessedKind = 1
	KindExternalJoin ProcessedKind = 2
	KindRejected     ProcessedKind = 3
)

// Processed is one processed handshake message.
type Processed struct {
	Kind        ProcessedKind
	Epoch       uint64
	SenderLeaf  *uint32
	Staged      *uint32
	ProposalRef []byte
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
	if err := expectLen(elems, 6, "public_group_process"); err != nil {
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
	if err := expectLen(elems, 5, "validate_key_package"); err != nil {
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
