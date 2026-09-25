package api

import (
	"errors"
	"net/http"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/ds"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/server"
)

// Groups holds the delivery-service HTTP surface. Bodies are deterministic CBOR fixed-position
// arrays; MLS objects are byte strings (interfaces.md §5.0).
//
// EVERY handler here is written against the surface plan-1a task 6 actually produces —
// `*server.Mux`, `server.DecodeBody(w, r, max, v)` (four arguments), `server.EncodeBody(w, status,
// v)`, `server.WriteError`, `server.PathID`, `server.Errorf` and the four extended constructors
// `server.CommitConflict`, `server.CommitRequired`, `server.CommitInvalid`, `server.Version` — and
// reads the session with `auth.FromContext(r.Context())`, which `(*auth.Sessions).Middleware` put
// there. There is no `server.Handler`, no `server.HandlerWithLimit`, no `server.QueryUint`, no
// `server.SessionOf` and no `server.APIError`: those names appear in no plan and in no contract.
// Deviation B12 records that part 1b invents none of them.
//
// A handler is therefore an ordinary http.HandlerFunc that writes its own refusal, because
// plan-1a's Mux takes an http.Handler and has no error-returning form.
//
// Groups mounts itself rather than hanging off `api.Deps` and `api.Register`, because a nil
// `*ds.DS` must not silently turn three documented routes into 501s: an instance either has a
// delivery service or is not a dilla instance. The composition root (task 27a) builds the DS and
// calls Register beside `api.Register`.
type Groups struct {
	DS      *ds.DS
	MaxBody int64 // §5.3's cap for this group of routes; zero means maxDSBody
}

// maxDSBody is the delivery service's own body cap. It is far above §5.3's 64 KiB general limit
// because a registration carries the whole ratchet tree: the committed 1,500-leaf fixture's is
// 620 KiB, and the MLS ciphertext cap alone is 128 KiB.
const maxDSBody = 2 << 20

func (h *Groups) max() int64 {
	if h.MaxBody == 0 {
		return maxDSBody
	}
	return h.MaxBody
}

func (h *Groups) Register(mux *server.Mux, sessions *auth.Sessions) {
	// Every delivery-service route needs an enrolled device session. The KeyPackage and Welcome
	// routes of task 24 are the only ones that also accept a provisional session, and they say so
	// at their own Register.
	enrolled := func(f http.HandlerFunc) http.Handler {
		return sessions.Middleware(f, auth.ScopeEnrolled)
	}
	mux.Handle("POST /v1/groups", enrolled(h.create))
	mux.Handle("GET /v1/groups/{id}/info", enrolled(h.info))
	mux.Handle("GET /v1/groups/{id}/tree", enrolled(h.tree))
}

// sessionOf is the one place this file reads the request's session. It is a helper in package api,
// not in package server: the context key belongs to internal/auth.
func sessionOf(r *http.Request) (ds.Session, error) {
	s, ok := auth.FromContext(r.Context())
	if !ok {
		return ds.Session{}, server.Errorf(server.CodeUnauthenticated, "no device session")
	}
	return s, nil
}

type createGroupRequest struct {
	_           struct{} `cbor:",toarray"`
	GroupID     id.ID
	Binding     []byte
	GroupInfo   []byte
	RatchetTree []byte
}

type createGroupResponse struct {
	_       struct{} `cbor:",toarray"`
	GroupID id.ID
	NextSeq uint64
}

func (h *Groups) create(w http.ResponseWriter, r *http.Request) {
	var body createGroupRequest
	if err := server.DecodeBody(w, r, h.max(), &body); err != nil {
		server.WriteError(w, err)
		return
	}
	session, err := sessionOf(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	out, err := h.DS.Register(r.Context(), ds.RegisterRequest{
		Session:     session,
		GroupID:     body.GroupID,
		Binding:     body.Binding,
		GroupInfo:   body.GroupInfo,
		RatchetTree: body.RatchetTree,
	})
	if err != nil {
		server.WriteError(w, dsError(err))
		return
	}
	if err := server.EncodeBody(w, http.StatusCreated,
		createGroupResponse{GroupID: out.GroupID, NextSeq: out.NextSeq}); err != nil {
		server.WriteError(w, err)
	}
}

type groupInfoResponse struct {
	_         struct{} `cbor:",toarray"`
	Epoch     uint64
	GroupInfo []byte
	TreeHash  []byte
	NextSeq   uint64
}

func (h *Groups) info(w http.ResponseWriter, r *http.Request) {
	groupID, err := server.PathID(r, "id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	session, err := sessionOf(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	out, err := h.DS.Info(r.Context(), groupID, session)
	if err != nil {
		server.WriteError(w, dsError(err))
		return
	}
	if err := server.EncodeBody(w, http.StatusOK, groupInfoResponse{
		Epoch: out.Epoch, GroupInfo: out.GroupInfo, TreeHash: out.TreeHash, NextSeq: out.NextSeq,
	}); err != nil {
		server.WriteError(w, err)
	}
}

type treeResponse struct {
	_           struct{} `cbor:",toarray"`
	Epoch       uint64
	RatchetTree []byte
	TreeHash    []byte
}

func (h *Groups) tree(w http.ResponseWriter, r *http.Request) {
	groupID, err := server.PathID(r, "id")
	if err != nil {
		server.WriteError(w, err)
		return
	}
	session, err := sessionOf(r)
	if err != nil {
		server.WriteError(w, err)
		return
	}
	out, err := h.DS.Tree(r.Context(), groupID, session)
	if err != nil {
		server.WriteError(w, dsError(err))
		return
	}
	if err := server.EncodeBody(w, http.StatusOK, treeResponse{
		Epoch: out.Epoch, RatchetTree: out.RatchetTree, TreeHash: out.TreeHash,
	}); err != nil {
		server.WriteError(w, err)
	}
}

// dsError maps a *ds.Error onto plan-1a's *server.Error, which writes protocol/02's CBOR body.
// The four codes that carry extra elements go through 1a's own constructors rather than through a
// generic "extra fields" struct: the element order of each extended shape is fixed in one place,
// and `scripts/check-protocol-docs.mjs` diffs 1a's code vocabulary against protocol/02 in both
// directions. A non-ds error is returned unchanged, and WriteError turns it into a 500 with an
// empty detail.
func dsError(err error) error {
	var e *ds.Error
	if !errors.As(err, &e) {
		return err
	}
	switch server.Code(e.Code) {
	case server.CodeCommitConflict:
		return server.CommitConflict(e.WinningCommit, e.Proposals)
	case server.CodeCommitRequired:
		var ms uint64
		if e.RetryAfterMS != nil {
			ms = *e.RetryAfterMS
		}
		return server.CommitRequired(e.Proposals, ms)
	case server.CodeCommitInvalid:
		return server.CommitInvalid(e.Rule)
	case server.CodeRateLimited:
		var ms uint64
		if e.RetryAfterMS != nil {
			ms = *e.RetryAfterMS
		}
		return server.RateLimited(ms)
	default:
		return server.Errorf(server.Code(e.Code), "%s", e.Detail)
	}
}
