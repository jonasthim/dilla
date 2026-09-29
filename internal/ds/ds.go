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
	"sync/atomic"
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
	ProposalTTLText time.Duration // 24h
	ProposalTTLCall time.Duration // 30s
	CommitDeadline  time.Duration // the deadline_ms in mls.commit_needed

	// Backoff and BackoffJitter are invariant 7's back-off window — "the other devices back off
	// 300 ms + random(0..300 ms)" (protocol/02-delivery-service.md:257) — and NOTHING READS THEM
	// YET. The instance only ever addresses the elected device, so the window is advertised once,
	// in `hello`, to the devices that are not; a client that never receives mls.commit_needed
	// waits it out before volunteering.
	//
	// TASK 27a OWES THE AMENDMENT (deviation B23, ruling 44). `hello` is a seven-element frame in
	// five places that move together — protocol/02:133, `gateway.HelloPayload`
	// (internal/gateway/codec.go), `opSpecs[OpHello]` (internal/gateway/frame.go),
	// `packages/protocol-vectors/src/frames.ts` and the generated `protocol/vectors/frames.json`
	// (a wasm32-wasip1 rebuild, which internal/mlswasi/vectors_test.go pins) — and `gateway.
	// Options` has no field for either value, so `ds.Policy` cannot reach the gateway at all.
	// Task 22, whose Files are three new files in internal/ds, could amend none of it. Task 22's
	// `TestTheBackoffWindowIsAdvertisedInHello` is carried verbatim into that task.
	//
	// Until it lands, a non-elected client has no advertised window: it either volunteers at once,
	// racing the elected committer, or hard-codes 300 ms and drifts the moment an operator tunes
	// these two fields.
	Backoff       time.Duration // 300ms
	BackoffJitter time.Duration // 300ms

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

	// MaxKeyPackagesPerDevice bounds one device's KeyPackage directory: the number of packages
	// `POST /v1/keypackages` will store for a device in one call, refused with E_TOO_LARGE above
	// it.
	//
	// It is NOT a literal invented here. The value is `config.Default().Limits
	// .MaxKeypackagesPerDevice`, which 1a task 4 already fixes at 32 beside the refill threshold
	// of 8, and it is carried on Policy so ONE number governs the refusal here and the
	// `limits.max_keypackages_per_device` element of `GET /v1/instance/limits`. The task brief's
	// NV-B7 proposed 128 for want of a resolution; the shipped config default supersedes it, and
	// nothing else depends on the number — the refusal is a cap, not a protocol constant.
	//
	// internal/config is NOT imported here: it imports nothing of internal/ds, and the reverse
	// would make the delivery service depend on the file format. The composition root copies the
	// configured value across, exactly as it does for MaxCiphertextBytes.
	MaxKeyPackagesPerDevice int // 32
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
		// config.Default().Limits.MaxKeypackagesPerDevice, kept in step by
		// TestPublishRefusesMoreThanThePolicyCap rather than by a comment.
		MaxKeyPackagesPerDevice: 32,
	}
}

// normalisePolicy fills every unset tunable from DefaultPolicy, FIELD BY FIELD.
//
// The earlier form keyed the whole substitution on one field — `if Policy.MaxCiphertextBytes == 0
// { Policy = DefaultPolicy() }` — so a partially filled Policy, which is exactly the shape a
// config-derived one produces, kept every zero it arrived with. A zero `WatchdogInterval` then
// reached `time.NewTicker` inside Start's goroutine, where the panic it raises is unrecoverable
// and takes the process down at startup; a zero `MaxLostRounds` would remove the elected committer
// on its first overdue round.
//
// Every field of Policy is a positive duration or count, so "unset" is "not positive" and an
// operator can never mean zero.
func normalisePolicy(p Policy) Policy {
	d := DefaultPolicy()
	fill := func(v *time.Duration, def time.Duration) {
		if *v <= 0 {
			*v = def
		}
	}
	fillInt := func(v *int, def int) {
		if *v <= 0 {
			*v = def
		}
	}
	fill(&p.ProposalTTLText, d.ProposalTTLText)
	fill(&p.ProposalTTLCall, d.ProposalTTLCall)
	fill(&p.CommitDeadline, d.CommitDeadline)
	fill(&p.Backoff, d.Backoff)
	fill(&p.BackoffJitter, d.BackoffJitter)
	fill(&p.WatchdogInterval, d.WatchdogInterval)
	fillInt(&p.MaxLostRounds, d.MaxLostRounds)
	fill(&p.HandshakeRetention, d.HandshakeRetention)
	fill(&p.MessageRetention, d.MessageRetention)
	fill(&p.HealWindow, d.HealWindow)
	fill(&p.InactivityRemove, d.InactivityRemove)
	fill(&p.FreezeWarn, d.FreezeWarn)
	fill(&p.FreezeMax, d.FreezeMax)
	fillInt(&p.MaxCiphertextBytes, d.MaxCiphertextBytes)
	fillInt(&p.MaxAddsPerCommit, d.MaxAddsPerCommit)
	fillInt(&p.MaxKeyPackagesPerDevice, d.MaxKeyPackagesPerDevice)
	return p
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
	// nil means NewDeviceLists(Store, Wasm), which verifies the stored list in the guest (NV-B8,
	// resolved by task 27a's ABI v3 export device_list_entries).
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

	// accepted counts the commits this DS has accepted, for AcceptedCommits (debug.go).
	accepted atomic.Int64

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
	o.Policy = normalisePolicy(o.Policy)
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
