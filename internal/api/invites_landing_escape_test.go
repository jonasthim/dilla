package api_test

import (
	"net/http"
	"strings"
	"testing"
)

func TestLandingEscapesTheCommunityName(t *testing.T) {
	e, cid, tok := inviteEnvFor(t, "dilla.test")
	name := `<script>alert(1)</script> "q" 'a' & b`
	if status, _ := e.Do(http.MethodPatch, "/v1/communities/"+cid.String(), tok, []any{name, nil, nil, nil}); status != http.StatusOK {
		t.Fatal("PATCH name failed")
	}
	code := mintInvite(t, e, cid, tok, 5, 3600)
	_, page := landingBody(t, e, code)
	for _, bad := range []string{"<script", "alert(1)</", `"q"`, "'a'", "& b"} {
		if strings.Contains(page, bad) {
			t.Errorf("unescaped %q", bad)
		}
	}
}
