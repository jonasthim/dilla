package sfu

import (
	"log/slog"
	"sync"
	"testing"

	"github.com/livekit/protocol/logger"
)

// A goroutine LiveKit started before any Start (lkprom.Init's hwstats sampler logs "high cpu load"
// whenever the host is busy) reads LiveKit's package-level logger while the first installLiveKitLogger
// would write it. The install therefore happens at package init, before any such goroutine exists,
// and a later call only swaps the handler. Under -race this test fails if an install ever writes the
// logger after init.
func TestInstallingTheLiveKitLoggerNeverRacesAReader(t *testing.T) {
	stop, started := make(chan struct{}), make(chan struct{})
	var once sync.Once
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				logger.Infow("background reader")
				once.Do(func() { close(started) })
			}
		}
	}()
	<-started
	for range 50 {
		installLiveKitLogger(slog.DiscardHandler)
	}
	close(stop)
	wg.Wait()
}
