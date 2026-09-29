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
	}{
		{"", 64, 0},
		{"limit=5&after=9", 5, 9},
		{"limit=2147483647&after=9223372036854775807", math.MaxInt32, math.MaxInt64},
		// 2^32+1 and 2^64-1 wrapped to 1 and -1 when they were converted without a bound.
		{"limit=4294967297&after=18446744073709551615", math.MaxInt32, math.MaxInt64},
		{"limit=nonsense&after=-3", 64, 0},
	} {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/x?"+tc.query, nil)
		if got := queryLimit(r, "limit", 64); got != tc.wantLimit {
			t.Errorf("?%s: queryLimit = %d, want %d", tc.query, got, tc.wantLimit)
		}
		if got := queryCursor(r, "after"); got != tc.wantCursor {
			t.Errorf("?%s: queryCursor = %d, want %d", tc.query, got, tc.wantCursor)
		}
	}
}
