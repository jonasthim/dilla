package main

import (
	"context"
	"errors"

	"github.com/jonasthim/dilla/internal/bot/service"
)

const maxStructuralEventPollPasses = 4

type structuralEventPoll func(context.Context) (service.StructuralEventPollResult, error)

// drainStructuralEvents follows the poller's bounded More signal for a small,
// fixed number of passes so a busy installation cannot monopolize reconciliation.
func drainStructuralEvents(ctx context.Context, poll structuralEventPoll) (service.StructuralEventPollResult, error) {
	var total service.StructuralEventPollResult
	if ctx == nil || poll == nil {
		return total, errors.New("invalid structural event runtime poll")
	}
	for pass := 0; pass < maxStructuralEventPollPasses; pass++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		result, err := poll(ctx)
		total.Processed += result.Processed
		total.Pages += result.Pages
		if result.AcknowledgedThrough > total.AcknowledgedThrough {
			total.AcknowledgedThrough = result.AcknowledgedThrough
		}
		if err != nil {
			return total, err
		}
		total.More = result.More
		if !result.More {
			break
		}
	}
	return total, nil
}
