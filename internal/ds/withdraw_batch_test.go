package ds

import (
	"context"
	"testing"

	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/store"
)

type withdrawnQueryRepo struct {
	store.Repository
	listCalls int
}

func (r *withdrawnQueryRepo) ListWithdrawnProposals(context.Context, id.ID, uint64) ([]store.ProposalRow, error) {
	r.listCalls++
	return nil, nil
}

func (*withdrawnQueryRepo) IsWithdrawn(context.Context, id.ID, uint64, []byte) (bool, error) {
	panic("appliesWithdrawn must not query IsWithdrawn per proposal")
}

func TestAppliesWithdrawnListsOnceForManyAppliedProposals(t *testing.T) {
	repo := &withdrawnQueryRepo{}
	d := &DS{opts: Options{Store: repo}}
	applied := make([]mlswasi.AppliedProposal, 256)
	for i := range applied {
		applied[i].ProposalRef = []byte{byte(i), byte(i >> 8)}
	}

	if err := d.appliesWithdrawn(context.Background(), id.New(), 1, applied); err != nil {
		t.Fatalf("appliesWithdrawn: %v", err)
	}
	if repo.listCalls != 1 {
		t.Fatalf("ListWithdrawnProposals called %d times, want once", repo.listCalls)
	}
}
