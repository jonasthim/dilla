package botstrings

import (
	"strings"
	"testing"
)

func TestMusicSkippedNeverPublishesQueueMetadata(t *testing.T) {
	got := MusicSkipped("private title by private requester https://private.example", "provider unavailable")
	if strings.Contains(got, "private") || got != "Couldn't play a track (provider unavailable). Skipping." {
		t.Fatalf("public notice disclosed queue metadata: %q", got)
	}
}
