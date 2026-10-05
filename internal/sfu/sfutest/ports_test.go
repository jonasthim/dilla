package sfutest

import "testing"

func TestFreePortsComeFromOutsideTheFixedRange(t *testing.T) {
	tcp, udp := FreePorts(t)
	for _, p := range []int{tcp, udp} {
		if p == 0 || (p >= 7880 && p <= 7999) {
			t.Errorf("port %d: want a kernel-chosen port outside internal/sfu's fixed 7880-7999", p)
		}
	}
}
