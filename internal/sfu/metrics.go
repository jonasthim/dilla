package sfu

import (
	"strings"

	"github.com/livekit/protocol/livekit"
	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
	"google.golang.org/protobuf/proto"
)

// otherValue replaces a closed label's value that is not one of its known ones.
const otherValue = "other"

// labelValues is one served label: nil when every value comes from LiveKit's own code, else the
// closed set of values served as they are.
type labelValues map[string]bool

// node is LiveKit's two constant labels, fixed per process (prometheus.Init).
var node = map[string]labelValues{"node_id": nil, "node_type": nil}

// enumNames is the closed set of a protobuf enum's names: an unknown number's String() is the
// number itself, which a client chooses.
func enumNames(names map[int32]string) labelValues {
	s := labelValues{}
	for _, n := range names {
		s[n] = true
	}
	return s
}

var (
	trackSources = enumNames(livekit.TrackSource_name)
	trackTypes   = enumNames(livekit.TrackType_name)
	clientSDKs   = enumNames(livekit.ClientInfo_SDK_name)
	partKinds    = enumNames(livekit.ParticipantInfo_Kind_name)
	booleans     = labelValues{"true": true, "false": true}
)

// labels is node plus the named labels.
func labels(extra map[string]labelValues) map[string]labelValues {
	out := map[string]labelValues{}
	for k, v := range node {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

// liveKitFamilies is every family livekit-server v1.13.7 (pkg/telemetry/prometheus), and protocol's
// rpc and webhook packages, register that dillad serves, with the labels it serves of each. Every
// other label is aggregated away, and every family not listed is not served. The labels a client
// writes (branch review SFU-1) are:
//
//   - protocol_version on session_join_latency_ms, session_start_time_ms and session_duration_ms:
//     ClientInfo.protocol, the `protocol` parameter or the v1 join request's (rooms.go:290-300,
//     rtcservice.go:514, participant.go:2294,2721) — aggregated away;
//   - sdk on pubsubtime_ms: the v1 join request's ClientInfo.sdk, any int32 — closed to the enum;
//   - source and type on pubsubtime_ms and the stream histograms: the client's AddTrackRequest,
//     which LiveKit bounds by the grant and to audio and video (participant.go:1362-1378) — closed;
//   - kind on pubsubtime_ms: the token's participant kind — closed;
//   - count on pubsubtime_ms: how many subscribers one subscription batch had — aggregated away;
//   - error on track_subscribe_counter: a failed subscription's error text (rooms.go:276-277) —
//     aggregated away;
//   - country on the packet and stream families: empty without GeoIP in OSS LiveKit, a free string
//     otherwise — aggregated away.
//
// Every other label value is a constant in LiveKit's or psrpc's code.
var liveKitFamilies = func() map[string]map[string]labelValues {
	stream := map[string]labelValues{"direction": nil, "source": trackSources, "type": trackTypes}
	psrpc := map[string]labelValues{"role": nil, "kind": nil, "service": nil, "method": nil,
		"error_code": nil, "direction": nil, "outcome": nil}
	f := map[string]map[string]labelValues{
		"livekit_node_messages":                 labels(map[string]labelValues{"type": nil, "status": nil, "direction": nil}),
		"livekit_node_service_operation":        labels(map[string]labelValues{"type": nil, "status": nil, "error_type": nil}),
		"livekit_node_twirp_request_status":     labels(map[string]labelValues{"service": nil, "method": nil, "status": nil, "code": nil}),
		"livekit_node_twirp_request_latency_ms": labels(map[string]labelValues{"service": nil, "method": nil, "status": nil}),
		"livekit_node_packet_total":             labels(map[string]labelValues{"type": nil}),
		"livekit_packet_total":                  labels(map[string]labelValues{"direction": nil, "transmission": nil}),
		"livekit_packet_bytes":                  labels(map[string]labelValues{"direction": nil, "transmission": nil}),
		"livekit_nack_total":                    labels(map[string]labelValues{"direction": nil}),
		"livekit_pli_total":                     labels(map[string]labelValues{"direction": nil}),
		"livekit_fir_total":                     labels(map[string]labelValues{"direction": nil}),
		"livekit_packet_loss_total":             labels(stream),
		"livekit_packet_loss_percent":           labels(stream),
		"livekit_packet_out_of_order_total":     labels(stream),
		"livekit_packet_out_of_order_percent":   labels(stream),
		"livekit_jitter_us":                     labels(stream),
		"livekit_rtt_ms":                        labels(stream),
		"livekit_participant_join_total":        labels(map[string]labelValues{"state": nil, "warp": booleans}),
		"livekit_connection_total":              labels(map[string]labelValues{"kind": nil}),
		"livekit_forward_latency":               labels(nil),
		"livekit_forward_jitter":                labels(nil),
		"livekit_forward_latency_ns":            labels(nil),
		"livekit_quality_rating":                labels(nil),
		"livekit_quality_score":                 labels(nil),
		"livekit_room_total":                    labels(nil),
		"livekit_room_duration_seconds":         labels(nil),
		"livekit_participant_total":             labels(nil),
		"livekit_track_published_total":         labels(map[string]labelValues{"kind": trackTypes}),
		"livekit_track_subscribed_total":        labels(map[string]labelValues{"kind": trackTypes}),
		"livekit_track_publish_counter":         labels(map[string]labelValues{"kind": trackTypes, "state": nil}),
		"livekit_track_subscribe_counter":       labels(map[string]labelValues{"state": nil}),
		"livekit_session_join_latency_ms":       labels(nil),
		"livekit_session_start_time_ms":         labels(map[string]labelValues{"warp": booleans}),
		"livekit_session_duration_ms":           labels(nil),
		"livekit_peer_connection_state":         labels(map[string]labelValues{"transport": nil, "state": nil}),
		"livekit_datapacket_stream_dest_count":  labels(map[string]labelValues{"type": nil, "mime_type": nil}),
		"livekit_datapacket_stream_bytes":       labels(map[string]labelValues{"type": nil, "mime_type": nil}),
		"livekit_debug_ref_count":               labels(map[string]labelValues{"referrer": nil}),
		"livekit_webhook_dispatch_total":        labels(map[string]labelValues{"status": nil, "reason": nil}),
		"livekit_webhook_queue_length":          labels(nil),
		"livekit_psrpc_request_time_ms":         labels(psrpc),
		"livekit_psrpc_stream_send_time_ms":     labels(psrpc),
		"livekit_psrpc_stream_receive_total":    labels(psrpc),
		"livekit_psrpc_stream_count":            labels(psrpc),
		"livekit_psrpc_error_total":             labels(psrpc),
		"livekit_psrpc_bytes_total":             labels(psrpc),
		"livekit_psrpc_requests_received_total": labels(psrpc),
		"livekit_psrpc_requests_expired_total":  labels(psrpc),
		"livekit_psrpc_claim_wait_time_ms":      labels(psrpc),
		"livekit_pubsubtime_ms": labels(map[string]labelValues{"direction": nil, "source": trackSources,
			"type": trackTypes, "sdk": clientSDKs, "kind": partKinds}),
	}
	return f
}()

// LiveKitGatherer is g — prometheus.DefaultGatherer, where LiveKit registers — as dillad's /metrics
// serves it: LiveKit's known families with only their listed labels (liveKitFamilies), the series
// that differed only in an unlisted label summed into one, and the Go runtime's and the process's
// families as they are. Nothing a client writes can add a served series.
func LiveKitGatherer(g prometheus.Gatherer) prometheus.Gatherer { return liveKitGatherer{g} }

type liveKitGatherer struct{ g prometheus.Gatherer }

func (l liveKitGatherer) Gather() ([]*dto.MetricFamily, error) {
	mfs, err := l.g.Gather()
	out := make([]*dto.MetricFamily, 0, len(mfs))
	for _, mf := range mfs {
		name := mf.GetName()
		switch {
		case strings.HasPrefix(name, "go_"), strings.HasPrefix(name, "process_"):
			out = append(out, mf)
		default:
			if keep, ok := liveKitFamilies[name]; ok {
				out = append(out, project(mf, keep))
			}
		}
	}
	return out, err
}

// project keeps mf's listed labels, closes their values, and sums the series that then coincide.
func project(mf *dto.MetricFamily, keep map[string]labelValues) *dto.MetricFamily {
	out := &dto.MetricFamily{Name: mf.Name, Help: mf.Help, Type: mf.Type, Unit: mf.Unit}
	seen := map[string]*dto.Metric{}
	for _, m := range mf.GetMetric() {
		var kept []*dto.LabelPair
		var key strings.Builder
		for _, lp := range m.GetLabel() {
			values, ok := keep[lp.GetName()]
			if !ok {
				continue
			}
			v := lp.GetValue()
			if values != nil && !values[v] {
				v = otherValue
			}
			kept = append(kept, &dto.LabelPair{Name: proto.String(lp.GetName()), Value: proto.String(v)})
			key.WriteString(lp.GetName())
			key.WriteByte(0)
			key.WriteString(v)
			key.WriteByte(0)
		}
		if prev, ok := seen[key.String()]; ok {
			add(prev, m)
			continue
		}
		c, _ := proto.Clone(m).(*dto.Metric)
		c.Label = kept
		if s := c.GetSummary(); s != nil {
			s.Quantile = nil // quantiles cannot be summed; the count and the sum can
		}
		seen[key.String()] = c
		out.Metric = append(out.Metric, c)
	}
	return out
}

// add sums m into into. Two series of one family share the type and, for a histogram, the buckets.
func add(into, m *dto.Metric) {
	switch {
	case into.Counter != nil:
		into.Counter.Value = proto.Float64(into.Counter.GetValue() + m.GetCounter().GetValue())
	case into.Gauge != nil:
		into.Gauge.Value = proto.Float64(into.Gauge.GetValue() + m.GetGauge().GetValue())
	case into.Untyped != nil:
		into.Untyped.Value = proto.Float64(into.Untyped.GetValue() + m.GetUntyped().GetValue())
	case into.Summary != nil:
		into.Summary.SampleCount = proto.Uint64(into.Summary.GetSampleCount() + m.GetSummary().GetSampleCount())
		into.Summary.SampleSum = proto.Float64(into.Summary.GetSampleSum() + m.GetSummary().GetSampleSum())
	case into.Histogram != nil:
		h, o := into.Histogram, m.GetHistogram()
		h.SampleCount = proto.Uint64(h.GetSampleCount() + o.GetSampleCount())
		h.SampleSum = proto.Float64(h.GetSampleSum() + o.GetSampleSum())
		if len(h.Bucket) == len(o.GetBucket()) {
			for i, b := range h.Bucket {
				b.CumulativeCount = proto.Uint64(b.GetCumulativeCount() + o.GetBucket()[i].GetCumulativeCount())
			}
		}
	}
}
