//go:build linux

package helper

import (
	"bytes"
	"testing"
)

func TestPrivateDiagnosticWriterForwardsOnlyFixedTrustClasses(t *testing.T) {
	var out bytes.Buffer
	w := &privateDiagnosticWriter{out: &out}
	if _, err := w.Write([]byte("private body and identifiers must stay hidden\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("dilla_bot_helper trust_sender_refusal=device_list_")); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("stale\n")); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("dilla_bot_helper trust_sender_refusal=unexpected\n")); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "dilla_bot_helper trust_sender_refusal=device_list_stale\n"; got != want {
		t.Fatalf("diagnostic output = %q, want %q", got, want)
	}
}

func TestPrivateDiagnosticWriterBoundsUnterminatedLines(t *testing.T) {
	var out bytes.Buffer
	w := &privateDiagnosticWriter{out: &out}
	if _, err := w.Write(bytes.Repeat([]byte("x"), 1024)); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("\ndilla_bot_helper trust_sender_refusal=credential\n")); err != nil {
		t.Fatal(err)
	}
	if got, want := out.String(), "dilla_bot_helper trust_sender_refusal=credential\n"; got != want {
		t.Fatalf("diagnostic output = %q, want %q", got, want)
	}
}
