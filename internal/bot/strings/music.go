// Package botstrings contains the Bot's user-facing copy.
package botstrings

import "fmt"

// MusicSkipped publishes only a bounded reason, never queue metadata. The first
// argument is retained for callers compiled against the original copy helper.
func MusicSkipped(_ string, reason string) string {
	switch reason {
	case "audio unavailable":
	default:
		reason = "provider unavailable"
	}
	return fmt.Sprintf("Couldn't play a track (%s). Skipping.", reason)
}

// MusicSkippedBatch coalesces one start's skips without exposing their titles.
func MusicSkippedBatch(count int, reason string) string {
	if count <= 1 {
		return MusicSkipped("", reason)
	}
	return fmt.Sprintf("Couldn't play %d tracks. Skipping.", count)
}
