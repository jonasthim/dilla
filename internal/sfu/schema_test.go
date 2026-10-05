package sfu

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/reflect/protoreflect"
)

var updateGolden = flag.Bool("update-golden", false,
	"rewrite testdata/livekit-signal-schema.json from the pinned livekit/protocol module")

// signalRoots: every message and enum livekit-client 2.22.3 and LiveKit v1.13.7 exchange is
// reachable from these eight (gap G39).
var signalRoots = []protoreflect.MessageDescriptor{
	(&livekit.SignalRequest{}).ProtoReflect().Descriptor(),
	(&livekit.SignalResponse{}).ProtoReflect().Descriptor(),
	(&livekit.WrappedJoinRequest{}).ProtoReflect().Descriptor(),
	(&livekit.JoinRequest{}).ProtoReflect().Descriptor(),
	(&livekit.DataPacket{}).ProtoReflect().Descriptor(),
	(&livekit.ClientInfo{}).ProtoReflect().Descriptor(),
	(&livekit.EncryptedPacket{}).ProtoReflect().Descriptor(),
	(&livekit.EncryptedPacketPayload{}).ProtoReflect().Descriptor(),
}

type schemaField struct {
	No       int    `json:"no"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Repeated bool   `json:"repeated"`
	Oneof    string `json:"oneof"`
}

type signalSchema struct {
	Messages map[string][]schemaField     `json:"messages"`
	Enums    map[string]map[string]string `json:"enums"`
}

func fieldType(f protoreflect.FieldDescriptor) string {
	if f.IsMap() {
		return "map<" + fieldType(f.MapKey()) + "," + fieldType(f.MapValue()) + ">"
	}
	switch f.Kind() {
	case protoreflect.EnumKind:
		return "enum:" + string(f.Enum().FullName())
	case protoreflect.MessageKind, protoreflect.GroupKind:
		return "message:" + string(f.Message().FullName())
	}
	return f.Kind().String()
}

// signallingSchema walks the closure of signalRoots: a message's fields, the message and enum
// types they name (a map's value type, never its entry message), recursively.
func signallingSchema() signalSchema {
	s := signalSchema{Messages: map[string][]schemaField{}, Enums: map[string]map[string]string{}}
	addEnum := func(e protoreflect.EnumDescriptor) {
		values := map[string]string{}
		for i := range e.Values().Len() {
			v := e.Values().Get(i)
			values[strconv.Itoa(int(v.Number()))] = string(v.Name())
		}
		s.Enums[string(e.FullName())] = values
	}
	var walk func(m protoreflect.MessageDescriptor)
	walk = func(m protoreflect.MessageDescriptor) {
		name := string(m.FullName())
		// Well-known types (google.protobuf.Timestamp, reached through the data-stream headers) are
		// dumped by neither side (gap G39 walked the livekit files only; task 17's walker skips them
		// too); a field's type string still names them.
		if strings.HasPrefix(name, "google.protobuf.") {
			return
		}
		if _, done := s.Messages[name]; done {
			return
		}
		s.Messages[name] = []schemaField{}
		fields := []schemaField{}
		for i := range m.Fields().Len() {
			f := m.Fields().Get(i)
			sf := schemaField{No: int(f.Number()), Name: string(f.Name()), Type: fieldType(f), Repeated: f.IsList()}
			if o := f.ContainingOneof(); o != nil && !o.IsSynthetic() {
				sf.Oneof = string(o.Name())
			}
			fields = append(fields, sf)
			target := f
			if f.IsMap() {
				target = f.MapValue()
			}
			switch target.Kind() {
			case protoreflect.MessageKind, protoreflect.GroupKind:
				walk(target.Message())
			case protoreflect.EnumKind:
				addEnum(target.Enum())
			}
		}
		sort.Slice(fields, func(a, b int) bool { return fields[a].No < fields[b].No })
		s.Messages[name] = fields
	}
	for _, root := range signalRoots {
		walk(root)
	}
	return s
}

// DEV-66, Go half: the signalling closure of the pinned protocol module, committed. Task 17's
// check-protocol-schema.mjs compares it with @livekit/protocol 1.50.4; a protocol bump that moves a
// field shows up here as a stale golden first.
func TestTheSignallingSchemaGoldenIsCurrent(t *testing.T) {
	s := signallingSchema()
	// Gap G39 counted the same closure at this pin: 106 messages and 30 enums on each side.
	if len(s.Messages) != 106 || len(s.Enums) != 30 {
		t.Errorf("closure: %d messages, %d enums; gap G39 counted 106 and 30 at this protocol pin", len(s.Messages), len(s.Enums))
	}
	got, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	const path = "testdata/livekit-signal-schema.json"
	if *updateGolden {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s: %v (generate it with -update-golden)", path, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s is stale: regenerate with go test ./internal/sfu/ -run TestTheSignallingSchemaGoldenIsCurrent -update-golden", path)
	}
}
