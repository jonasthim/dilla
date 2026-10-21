package api

import (
	"encoding/json"
	"testing"
)

// The preview's width and height reach the client as small positive integers, or as 0 and 0 when Giphy's are not.
func TestGifDimsAreSmallPositiveIntegersOrZero(t *testing.T) {
	for name, tc := range map[string]struct {
		w, h   string
		ww, wh uint64
	}{
		"numbers":         {"200", "113", 200, 113},
		"numeric strings": {`"200"`, `"113"`, 200, 113},
		"the largest":     {"4000", "4000", 4000, 4000},
		"zero width":      {"0", "113", 0, 0},
		"zero height":     {"200", `"0"`, 0, 0},
		"negative":        {"-5", "113", 0, 0},
		"over the cap":    {"4001", "113", 0, 0},
		"huge":            {"99999999999999999999", "113", 0, 0},
		"fraction":        {"12.5", "113", 0, 0},
		"not a number":    {`"wide"`, "113", 0, 0},
		"missing":         {"", "113", 0, 0},
		"null":            {"null", "null", 0, 0},
	} {
		w, h := dims(json.RawMessage(tc.w), json.RawMessage(tc.h))
		if w != tc.ww || h != tc.wh {
			t.Errorf("%s: dims(%q, %q) = %d, %d; want %d, %d", name, tc.w, tc.h, w, h, tc.ww, tc.wh)
		}
	}
}
