package store

import (
	"cmp"
	"context"
	"slices"
)

// MaxSearchChannels caps the number of channels ONE engine statement may name:
// an unbounded OR chain inside an FTS5 MATCH, or an unbounded bytea array, is
// what this avoids. A wider scope is not truncated — ReadableSearchQuery carries
// BeforeSeq and no channel cursor, so a caller has no way to page past a
// silently dropped channel. Instead ChunkedSearch splits the scope into chunks
// of this size, searches each, and merges the hits by score before Limit.
const MaxSearchChannels = 64

// DefaultSearchLimit and MaxSearchLimit bound one search: a Limit outside
// 1..MaxSearchLimit is DefaultSearchLimit.
const (
	DefaultSearchLimit = 50
	MaxSearchLimit     = 100
)

// SearchLimit is the Limit a search actually runs with.
func SearchLimit(limit int32) int32 {
	if limit <= 0 || limit > MaxSearchLimit {
		return DefaultSearchLimit
	}
	return limit
}

// ChunkedSearch is both engines' SearchReadable around their one-statement
// search: an empty scope answers nothing, a scope of at most MaxSearchChannels
// runs once, and a wider one runs once per chunk with the hits merged by score.
// one receives a query whose Limit is already SearchLimit's.
func ChunkedSearch(ctx context.Context, q ReadableSearchQuery,
	one func(context.Context, ReadableSearchQuery) ([]ReadableSearchHit, error)) ([]ReadableSearchHit, error) {
	if len(q.ChannelIDs) == 0 {
		return nil, nil
	}
	q.Limit = SearchLimit(q.Limit)
	if len(q.ChannelIDs) <= MaxSearchChannels {
		return one(ctx, q)
	}
	var all []ReadableSearchHit
	for chunk := range slices.Chunk(q.ChannelIDs, MaxSearchChannels) {
		sub := q
		sub.ChannelIDs = chunk
		hits, err := one(ctx, sub)
		if err != nil {
			return nil, err
		}
		all = append(all, hits...)
	}
	return mergeHits(all, q.Limit), nil
}

// mergeHits keeps the limit best hits across chunks. Score is higher-is-better
// on both engines (the SQLite side flips bm25's sign), so one comparator serves
// both; ties break on the newer seq, as each engine's own ORDER BY does.
func mergeHits(all []ReadableSearchHit, limit int32) []ReadableSearchHit {
	slices.SortStableFunc(all, func(a, b ReadableSearchHit) int {
		if c := cmp.Compare(b.Score, a.Score); c != 0 {
			return c
		}
		return cmp.Compare(b.Seq, a.Seq)
	})
	if len(all) > int(limit) {
		all = all[:limit]
	}
	return all
}
