package main

import (
	"fmt"
	"strings"
)

// Layer is the encoded size and bitrate of a sharer's single-layer VP8 file. With no Go simulcast in
// this wave (DEV-40 b) a "layer" is a file, not a rid.
type Layer string

const (
	LayerQ Layer = "q" // 480×270 @ 15 fps, 150 kbit/s: LiveKit's max(150_000, maxBitrate/4) floor
	LayerH Layer = "h" // 960×540 @ 15 fps, 625 kbit/s: the h1080fps15 share's half-resolution layer
	LayerF Layer = "f" // 1920×1080 @ 15 fps, 2.5 Mbit/s: ScreenSharePresets.h1080fps15
)

// Layers is the order cells are measured in.
var Layers = []Layer{LayerQ, LayerH, LayerF}

// LayerBitrate is the target each layer's fixture is encoded at, in bit/s.
var LayerBitrate = map[Layer]int{LayerQ: 150_000, LayerH: 625_000, LayerF: 2_500_000}

// Cell is one measured configuration of one room. Participants 0…Talkers−1 publish the voice
// fixture, the next DTX publish DTX silence, the next Sharers publish the layer's share; everyone
// subscribes to every track but its own and decrypts it.
type Cell struct {
	Name         string
	Participants int
	Talkers      int
	DTX          int
	Sharers      int
	Layer        Layer
}

// Matrix is SP-29's cells (G37): sharers {1, 3, 10} × viewers {3, 12, 24} × layer {q, h, f}, a
// share's viewers being every other participant (participants = viewers + 1, at most the 25-device
// cap) and a cell with more sharers than participants skipped; plus voice {3 talkers + 22 DTX,
// 25 talkers} in a 25-device call.
func Matrix() []Cell {
	var cells []Cell
	for _, s := range []int{1, 3, 10} {
		for _, v := range []int{3, 12, 24} {
			if s > v+1 {
				continue
			}
			for _, l := range Layers {
				cells = append(cells, Cell{Name: fmt.Sprintf("video-s%d-v%d-%s", s, v, l), Participants: v + 1, Sharers: s, Layer: l})
			}
		}
	}
	return append(cells,
		Cell{Name: "voice-3t-22dtx", Participants: 25, Talkers: 3, DTX: 22},
		Cell{Name: "voice-25t", Participants: 25, Talkers: 25},
	)
}

// Select is "all", or the comma-separated cell names in the order given.
func Select(names string) ([]Cell, error) {
	all := Matrix()
	if names == "all" {
		return all, nil
	}
	byName := map[string]Cell{}
	for _, c := range all {
		byName[c.Name] = c
	}
	var out []Cell
	for _, n := range strings.Split(names, ",") {
		c, ok := byName[strings.TrimSpace(n)]
		if !ok {
			return nil, fmt.Errorf("unknown cell %q (run with -cells all, or one of the Matrix names)", n)
		}
		out = append(out, c)
	}
	return out, nil
}
