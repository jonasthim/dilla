// Package botstrings contains the Bot's user-facing copy.
package botstrings

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
)

var musicURL = regexp.MustCompile(`(?i)(?:[a-z][a-z0-9+.-]*://|www\.)\S+`)

// MusicSkipped includes a bounded title and a fixed reason, never a provider URL.
func MusicSkipped(title, reason string) string {
	title = musicURL.ReplaceAllString(title, "")
	title = strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return ' '
		}
		return r
	}, title)), " ")
	if title == "" {
		title = "this track"
	}
	return fmt.Sprintf("Couldn't play %s (%s). Skipping.", title, reason)
}
