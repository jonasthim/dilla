package ops_test

import (
	"strings"
	"testing"

	"github.com/jonasthim/dilla/internal/config"
	"github.com/jonasthim/dilla/internal/ops"
)

// E8: doctor says whether GIFs are on, and never prints the key.
func TestTheGiphyLegSaysWhetherGIFsAreOnAndNeverPrintsTheKey(t *testing.T) {
	c := config.Default()
	off := ops.GiphyLeg(*c)
	if off.Name != "giphy" || off.Status != ops.Green || !strings.Contains(off.Detail, "off") {
		t.Fatalf("no key = %+v; want a green leg that says off", off)
	}
	c.Giphy.APIKey = "sekrit-giphy-key"
	c.Giphy.Rating = "g"
	on := ops.GiphyLeg(*c)
	if on.Status != ops.Green || !strings.Contains(on.Detail, "on") || !strings.Contains(on.Detail, "rating g") {
		t.Fatalf("key set = %+v; want a green leg that says on with the rating", on)
	}
	if strings.Contains(on.Detail, "sekrit") || strings.Contains(on.Fix, "sekrit") {
		t.Fatalf("the leg printed the key: %+v", on)
	}
	if len(on.Name) >= 13 {
		t.Fatalf("leg name %q is too long for the text column", on.Name)
	}
}
