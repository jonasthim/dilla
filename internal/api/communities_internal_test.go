package api

import (
	"strings"
	"testing"
)

// R16: a member nickname is a display name, not a handle. Free Unicode, NFC,
// at most 64 characters, and no control or bidi character that would let one
// member paint another member's name. The handle rules (ASCII, PRECIS) would
// refuse most of the accepted cases below.
func TestMemberNickFollowsTheDisplayNameRules(t *testing.T) {
	ring := string(rune(0x030a))                         // COMBINING RING ABOVE
	aRing := string(rune(0x00c5))                        // LATIN CAPITAL LETTER A WITH RING ABOVE
	rlo := string(rune(0x202e))                          // RIGHT-TO-LEFT OVERRIDE
	lri := string(rune(0x2066))                          // LEFT-TO-RIGHT ISOLATE
	tree := string(rune(0x1f332))                        // an emoji
	oUmlaut := string(rune(0x00f6))                      // one character, two bytes
	devanagari := "\xe0\xa4\x95\xe0\xa5\x8d\xe0\xa4\xb7" // a conjunct with a virama

	for _, ok := range []string{
		"",                          // no nick: the display name shows
		aRing + "sa " + tree,        // non-ASCII, a space and an emoji
		"Jonas (mod)",               // punctuation a handle refuses
		devanagari,                  // a combining sequence
		strings.Repeat(oUmlaut, 64), // the display-name bound, in characters
	} {
		if _, err := memberNick(ok); err != nil {
			t.Errorf("memberNick(%q) = %v, want accepted", ok, err)
		}
	}
	// NFC: a decomposed A-ring is stored composed.
	if got, err := memberNick("A" + ring + "sa"); err != nil || got != aRing+"sa" {
		t.Errorf("memberNick(decomposed) = %q, %v, want the NFC form", got, err)
	}
	for _, bad := range []string{
		"evil" + rlo + "admin",      // right-to-left override
		"a" + lri + "b",             // isolate
		"line\nbreak",               // control character
		strings.Repeat(oUmlaut, 65), // over the bound
	} {
		if _, err := memberNick(bad); err == nil {
			t.Errorf("memberNick(%q) accepted, want refused", bad)
		}
	}
}
