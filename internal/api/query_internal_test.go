package api

import (
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestQueryLimitAndCursorSaturateInsteadOfWrapping(t *testing.T) {
	for _, tc := range []struct {
		query      string
		wantLimit  int32
		wantCursor int64
		wantFrom   uint64
	}{
		{"", 64, 0, 0},
		{"limit=5&after=9&from=9", 5, 9, 9},
		{"limit=2147483647&after=9223372036854775807&from=9223372036854775807",
			math.MaxInt32, math.MaxInt64, math.MaxInt64},
		// 2^32+1 and 2^64-1 wrapped to 1 and -1 when they were converted without a bound; `from`
		// is a uint64 all the way to the store adapters, where 2^63 wraps to a cursor before the
		// first row.
		{"limit=4294967297&after=18446744073709551615&from=18446744073709551615",
			math.MaxInt32, math.MaxInt64, math.MaxInt64},
		{"from=9223372036854775808", 64, 0, math.MaxInt64},
		{"limit=nonsense&after=-3&from=-3", 64, 0, 0},
	} {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/x?"+tc.query, nil)
		if got := queryLimit(r, "limit", 64); got != tc.wantLimit {
			t.Errorf("?%s: queryLimit = %d, want %d", tc.query, got, tc.wantLimit)
		}
		if got := queryCursor(r, "after"); got != tc.wantCursor {
			t.Errorf("?%s: queryCursor = %d, want %d", tc.query, got, tc.wantCursor)
		}
		if got := queryFrom(r, "from"); got != tc.wantFrom {
			t.Errorf("?%s: queryFrom = %d, want %d", tc.query, got, tc.wantFrom)
		}
	}
}
