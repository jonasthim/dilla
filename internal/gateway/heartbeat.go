package gateway

import (
	"math/rand/v2"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/jonasthim/dilla/internal/cborx"
)

// heartbeatPolicy is the liveness contract of protocol/02: the client beats every
// gateway.heartbeat_interval (30 s), the instance closes 4009 when a beat is later than
// interval*2 + 5 s, and the instance's own ping runs on a 20 s period with a 10 s context.
type heartbeatPolicy struct {
	interval time.Duration
	grace    time.Duration
	ping     time.Duration
	pingCtx  time.Duration
}

func newHeartbeatPolicy(interval time.Duration) heartbeatPolicy {
	return heartbeatPolicy{
		interval: interval,
		grace:    interval*2 + 5*time.Second,
		ping:     20 * time.Second,
		pingCtx:  10 * time.Second,
	}
}

// firstDelay jitters the first beat into [0, interval) so 1,500 clients reconnecting after a
// restart do not synchronise onto one second.
func (p heartbeatPolicy) firstDelay() time.Duration {
	return time.Duration(rand.Float64() * float64(p.interval))
}

// rebaseDeadline rewrites element 2 (deadline_ms) of an mls.commit_needed payload, subtracting the
// time the frame spent in the queue. A deadline that has already passed becomes 0, which the
// client reads as "commit now".
func rebaseDeadline(p cbor.RawMessage, waited time.Duration) (cbor.RawMessage, error) {
	var elems []cbor.RawMessage
	if err := cborx.Unmarshal(p, &elems); err != nil {
		return nil, err
	}
	if len(elems) != 4 {
		return nil, frameErr("E_FRAME_SHAPE", "commit_needed payload", CloseDecode)
	}
	deadline, err := rawUint(elems[2])
	if err != nil {
		return nil, err
	}
	waitedMS := uint64(waited / time.Millisecond)
	if waitedMS >= deadline {
		deadline = 0
	} else {
		deadline -= waitedMS
	}
	epoch, err := rawUint(elems[0])
	if err != nil {
		return nil, err
	}
	round, err := rawUint(elems[3])
	if err != nil {
		return nil, err
	}
	var refs [][]byte
	if err := cborx.Unmarshal(elems[1], &refs); err != nil {
		return nil, err
	}
	return CommitNeededPayload(epoch, refs, deadline, round)
}
