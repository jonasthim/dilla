// Package ds is dilla's MLS delivery service: the five roles and the eleven invariants of
// protocol/02-delivery-service.md, over the wazero-hosted Rust core.
//
// The state rule (R12): SQL is the record. A group's PublicGroup blob is written in the same
// transaction as the handshake row that produced it, and on start the DS imports blobs lazily,
// per group, through public_group_import_state — never from_external, which is O(n²) in
// credential validation.
package ds

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/jonasthim/dilla/internal/auth"
	"github.com/jonasthim/dilla/internal/clock"
	"github.com/jonasthim/dilla/internal/gateway"
	"github.com/jonasthim/dilla/internal/id"
	"github.com/jonasthim/dilla/internal/mlswasi"
	"github.com/jonasthim/dilla/internal/obs"
	"github.com/jonasthim/dilla/internal/store"
)

// InstanceKeys are the long-lived instance secrets the DS signs and tags with.
type InstanceKeys struct {
	InstanceID          id.ID
	ExternalSenderKeyID id.ID
	FrankingKeyID       id.ID
	ExternalSenderPriv  [32]byte
	FrankingKey         [32]byte
}

// Policy holds every tunable of protocol/02's invariants.
type Policy struct {
	ProposalTTLText  time.Duration // 24h
	ProposalTTLCall  time.Duration // 30s
	CommitDeadline   time.Duration // the deadline_ms in mls.commit_needed
	Backoff          time.Duration // 300ms
	BackoffJitter    time.Duration // 300ms
	WatchdogInterval time.Duration // 2s
	MaxLostRounds    int           // 3

	HandshakeRetention time.Duration // 30d
	MessageRetention   time.Duration // 30d
	HealWindow         time.Duration // 24h
	InactivityRemove   time.Duration // 90d

	// The freeze has exactly TWO backstop timers, and only two. gap-21-ds.md §5.3
	// ("The two backstop timers (and only two)") and its §11 constants table fix
	// both; R26's "all three" mis-cited gap-56, which is about community join
	// gates and carries no freeze parameter at all. There is no third timer and
	// no probe interval: the liveness path is event-driven — the election re-runs
	// on the first device that reaches READY, not on a tick.
	//
	// FreezeWarn = 24h: dilla_ds_group_frozen_seconds crossing it raises the
	// admin warning on the doctor / diagnostics page. The number equals the text
	// proposal TTL, which is 02's own "one TTL has passed with no committer".
	//
	// FreezeMax = 30d: the group is CLOSED and re-created by the channel owner's
	// device — invariant 11's terminal path (02:99-100). The number equals
	// handshake retention (02:94, 02:113); past it an offline device could not
	// catch up anyway and must resync by external commit.
	FreezeWarn time.Duration // 24h  (gap-21-ds §5.3, §11)
	FreezeMax  time.Duration // 30d  (gap-21-ds §5.3, §11; R26)

	MaxCiphertextBytes int // 131072
	MaxAddsPerCommit   int // 256
}

// DefaultPolicy is every value interfaces.md §6.2 fixes.
func DefaultPolicy() Policy {
	return Policy{
		ProposalTTLText:    24 * time.Hour,
		ProposalTTLCall:    30 * time.Second,
		CommitDeadline:     2 * time.Second,
		Backoff:            300 * time.Millisecond,
		BackoffJitter:      300 * time.Millisecond,
		WatchdogInterval:   2 * time.Second,
		MaxLostRounds:      3,
		HandshakeRetention: 30 * 24 * time.Hour,
		MessageRetention:   30 * 24 * time.Hour,
		HealWindow:         24 * time.Hour,
		InactivityRemove:   90 * 24 * time.Hour,
		FreezeWarn:         24 * time.Hour,
		FreezeMax:          30 * 24 * time.Hour,
		MaxCiphertextBytes: 131072,
		MaxAddsPerCommit:   256,
	}
}

// Session is the authenticated caller of every mutating entry point, and of the four group-scoped
// reads. It is an ALIAS of auth.Session, not a second declaration: interfaces §6.2 as Plan 2's
// P2-D26 amended it puts the type in `internal/auth`, the leaf package, precisely so `auth`,
// `ds`, `gateway` and `api` can all name it without a cycle. Spelling it `ds.Session` at a call
// site is therefore free.
type Session = auth.Session

type Options struct {
	Store   store.Repository
	Wasm    *mlswasi.Runtime
	Gateway *gateway.Gateway
	Clock   clock.Clock
	Log     *slog.Logger
	Metrics *obs.Metrics
	Keys    InstanceKeys
	Policy  Policy

	// The three injected seams interfaces.md §6.2 names. Each has a Plan-1 default, and each
	// default is the conservative one: the rule runs, against a source that cannot yet answer.
	//
	// Channels is invariant 1's channel-mode source. nil means PermissiveChannels{}: the channels
	// table arrives with Plan 2 task 2 (NV-B5).
	Channels Channels
	// ACL is invariant 4's eligibility source. nil means DenyUnlessMember{Store}: the permission
	// resolver arrives with Plan 2 task 3 (NV-B6).
	ACL ACL
	// DeviceLists decodes and verifies a user's signed device list for invariant 4's DSK clause.
	// nil means NewDeviceLists(Store, Wasm), which fails closed until the ABI export exists
	// (NV-B8).
	//
	// ACL and DeviceLists have no call site before tasks 20-24 — checkAddedMember is the first —
	// but they are declared now, with Options, because Options is the one shape both plans read
	// and tasks 21 and 24 are written against all three fields.
	DeviceLists DeviceLists
}

type DS struct {
	opts Options

	// groupLocks serialises every mutation of one group. One commit per epoch is decided here and
	// in SQL: the lock keeps two commits for the same epoch from both passing validation, and the
	// epoch comparison inside the transaction is what makes it durable.
	groupLocks sync.Map // id.ID -> *sync.Mutex

	states *stateCache

	// stale carries one bit out of withGroup's handle lock: a commit whose Merge succeeded and
	// whose transaction then failed has a cached PublicGroup one epoch ahead of SQL, and R12's
	// "SQL is the record" makes that handle unusable. Evicting it from inside withGroup would
	// wait on the very lock withGroup holds, so the group is marked here and evicted by the
	// caller once withGroup has returned.
	staleMu sync.Mutex
	stale   map[id.ID]struct{}

	// supersede carries one ref from `reissue` into the `storeInstanceProposal` it wraps, so that
	// call writes through `ReissueProposal` — which retires the old row and keeps its action_id —
	// rather than through `PutProposal`. Passing it down the call chain instead would put an
	// `oldRef []byte` parameter on both public Propose methods, where it means nothing.
	//
	// It is keyed BY GROUP, not one field. Each re-issue window runs under its own group's lock,
	// so two groups re-issuing at once are both legal — and a single field would let one group's
	// storeInstanceProposal pick up the other's ref and retire a proposal of a group it never
	// touched.
	supersedeMu sync.Mutex
	supersede   map[id.ID][]byte

	// pending is the tail of a join storm: the devices ProposeAddBatch could not fit into this
	// epoch's 256 Adds, waiting for the next commit. It is in memory because `pending_joins` has
	// no table and `store.Repository` no methods yet — see queuePendingJoins for the deviation.
	pendingMu sync.Mutex
	pending   map[id.ID][]id.ID

	// elections is invariant 7's in-flight committer round, one per group. It is in memory on
	// purpose: an election decided while everybody was away is stale by definition, and the
	// instance re-elects on the first device that reaches READY.
	elections elections

	stop     chan struct{}
	stopOnce sync.Once
	wg       sync.WaitGroup
}

// log is the DS's logger. Every call site uses it rather than d.opts.Log directly, so a nil
// logger is one check here instead of one at each of the places that log.
func (d *DS) log() *slog.Logger {
	if d.opts.Log == nil {
		return slog.Default()
	}
	return d.opts.Log
}

func New(o Options) (*DS, error) {
	if o.Clock == nil {
		o.Clock = clock.System()
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
	if o.Policy.MaxCiphertextBytes == 0 {
		o.Policy = DefaultPolicy()
	}
	if o.Channels == nil {
		o.Channels = PermissiveChannels{}
	}
	if o.ACL == nil {
		o.ACL = DenyUnlessMember{Store: o.Store}
	}
	if o.DeviceLists == nil {
		o.DeviceLists = NewDeviceLists(o.Store, o.Wasm)
	}
	ds := &DS{
		opts:   o,
		states: newStateCache(o.Wasm),
		stop:   make(chan struct{}),
	}
	ds.elections.m = map[id.ID]*election{}
	return ds, nil
}

// Start runs the delivery service's background work: invariant 7's 2-second election watchdog and
// the one-minute sweeper that voids proposals past invariant 6's TTL. Task 26 extends the sweeper
// with retention pruning, on the same tick.
//
// Both loops end on Shutdown, which closes d.stop and waits on d.wg. A test that drives the
// watchdog deterministically calls RunWatchdogOnce against a clock.Fake instead of starting it —
// these tickers are wall-clock, because a fake clock in production would be a stopped one.
func (d *DS) Start(ctx context.Context) error {
	d.wg.Add(2)
	go func() {
		defer d.wg.Done()
		d.runWatchdog(ctx)
	}()
	go func() {
		defer d.wg.Done()
		d.runSweeper(ctx)
	}()
	return nil
}

func (d *DS) Shutdown(ctx context.Context) error {
	d.stopOnce.Do(func() { close(d.stop) })
	done := make(chan struct{})
	go func() { d.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		return ctx.Err()
	}
	return d.states.closeAll(ctx)
}

// lock serialises one group's mutations.
func (d *DS) lock(groupID id.ID) func() {
	v, _ := d.groupLocks.LoadOrStore(groupID, &sync.Mutex{})
	mu := v.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func (d *DS) now() int64 { return d.opts.Clock.Now().Unix() }
