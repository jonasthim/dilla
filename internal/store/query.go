package store

import (
	"errors"
	"strings"
	"unicode"
)

// ErrEmptyQuery is returned when nothing searchable survives parsing. FTS5
// answers `syntax error near ""` for an empty MATCH and Postgres would match
// everything, so the caller turns this into 400 E_INVALID_REQUEST rather than
// letting either engine decide.
var ErrEmptyQuery = errors.New("store: query has no searchable term")

// Term is one word of a query. Prefix is set by a trailing '*'.
type Term struct {
	Text   string
	Prefix bool
}

// ParsedQuery is the engine-neutral form of a user's search. Terms and Phrases
// are ANDed; Not is subtracted. interfaces.md §6.7 fixes the three exported
// fields and P2-D6 keeps them exactly.
type ParsedQuery struct {
	Terms   []Term
	Phrases []string
	Not     []string

	// order records the INPUT order of Terms and Phrases, so both renderers emit
	// `"a b" AND "c"*` for `"a b" c*` rather than bucketing terms before phrases.
	// It is unexported, so §6.7's declared shape is unchanged and a ParsedQuery
	// built by hand (order nil) still renders, terms first.
	order []queryItem
}

// queryItem points at one element of Terms (phrase false) or Phrases (true).
type queryItem struct {
	phrase bool
	idx    int
}

// ParseQuery turns raw user input into ParsedQuery. Raw input is safe for
// websearch_to_tsquery and fatal for FTS5 (`fts5: syntax error near "+"`,
// gap-69 §4.2), so every engine-facing string is built from this output and
// never from the input.
//
// The language: bare words are terms; a trailing '*' makes a term a prefix; text
// inside double quotes is a phrase, with "" an escaped quote; a leading '-'
// negates the word or phrase that follows. Everything else is a separator.
func ParseQuery(raw string) (ParsedQuery, error) {
	var q ParsedQuery
	rs := []rune(raw)
	for i := 0; i < len(rs); {
		neg := false
		if rs[i] == '-' {
			neg = true
			i++
		}
		if i < len(rs) && rs[i] == '"' {
			i++
			var sb strings.Builder
			for i < len(rs) {
				if rs[i] == '"' {
					if i+1 < len(rs) && rs[i+1] == '"' {
						sb.WriteRune('"')
						i += 2
						continue
					}
					i++
					break
				}
				sb.WriteRune(rs[i])
				i++
			}
			// An unterminated quote simply ends at the end of the input; its
			// content is still searched, which is what a user means by it.
			if p := normalizeWords(sb.String()); p != "" {
				if neg {
					q.Not = append(q.Not, p)
				} else {
					q.order = append(q.order, queryItem{phrase: true, idx: len(q.Phrases)})
					q.Phrases = append(q.Phrases, p)
				}
			}
			continue
		}
		start := i
		for i < len(rs) && isWordRune(rs[i]) {
			i++
		}
		if i == start {
			i++ // a separator, or a stray '-'
			continue
		}
		word := strings.ToLower(string(rs[start:i]))
		prefix := false
		if i < len(rs) && rs[i] == '*' {
			prefix = true
			i++
		}
		if neg {
			q.Not = append(q.Not, word)
		} else {
			q.order = append(q.order, queryItem{idx: len(q.Terms)})
			q.Terms = append(q.Terms, Term{Text: word, Prefix: prefix})
		}
	}
	// A negation-only query is legal — `-spam` is a real search a moderator
	// types — so Not counts towards "something searchable". Only a query with
	// nothing at all in it is ErrEmptyQuery, which is what a bare '-' produces.
	if len(q.Terms) == 0 && len(q.Phrases) == 0 && len(q.Not) == 0 {
		return ParsedQuery{}, ErrEmptyQuery
	}
	return q, nil
}

// items returns the positive elements in input order. A ParsedQuery built by hand
// carries no order, so it falls back to terms then phrases.
func (q ParsedQuery) items() []queryItem {
	if len(q.order) == len(q.Terms)+len(q.Phrases) {
		return q.order
	}
	out := make([]queryItem, 0, len(q.Terms)+len(q.Phrases))
	for i := range q.Terms {
		out = append(out, queryItem{idx: i})
	}
	for i := range q.Phrases {
		out = append(out, queryItem{phrase: true, idx: i})
	}
	return out
}

// isWordRune matches what unicode61 treats as a token character: letters,
// numbers and marks. Everything else separates, which is why `c++` is `c`.
func isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsNumber(r) || unicode.IsMark(r)
}

// normalizeWords lower-cases a phrase and collapses its separators to single
// spaces, so the two renderers see the same word list.
func normalizeWords(s string) string {
	fields := strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !isWordRune(r) })
	return strings.Join(fields, " ")
}

// FTS5 renders the MATCH string. Every term is double quoted with embedded
// quotes doubled, a prefix term takes its '*' after the closing quote, terms are
// joined with AND and negations are prefixed with NOT.
func (q ParsedQuery) FTS5() string {
	var parts []string
	for _, it := range q.items() {
		if it.phrase {
			parts = append(parts, quoteFTS5(q.Phrases[it.idx]))
			continue
		}
		t := q.Terms[it.idx]
		s := quoteFTS5(t.Text)
		if t.Prefix {
			s += "*"
		}
		parts = append(parts, s)
	}
	out := strings.Join(parts, " AND ")
	if out == "" {
		out = `""`
	}
	for _, n := range q.Not {
		out += " NOT " + quoteFTS5(n)
	}
	return out
}

func quoteFTS5(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }

// FTS5Match renders the whole MATCH expression for readable_messages_fts over
// the given channel scope (the 32-char hex ids of channel_hex). The scope lives
// INSIDE the expression: intersecting two doclists is 20x faster than
// post-filtering a global match (gap-69 §2.6).
//
// A query with no positive term cannot use FTS5(): its `"" NOT "raids"` is the
// empty phrase, which FTS5 matches against nothing, so a negation-only search
// would answer nothing on SQLite and everything-but on Postgres. The channel
// scope is the positive side instead — `-raids` means "every message in scope
// without raids" — and each negation is subtracted from it.
func (q ParsedQuery) FTS5Match(channelHexes []string) string {
	scope := make([]string, 0, len(channelHexes))
	for _, h := range channelHexes {
		scope = append(scope, quoteFTS5(h))
	}
	out := `{channel_hex} : (` + strings.Join(scope, " OR ") + `)`
	if len(q.Terms) == 0 && len(q.Phrases) == 0 {
		for _, n := range q.Not {
			out += ` NOT body : (` + quoteFTS5(n) + `)`
		}
		return out
	}
	return out + ` AND body : (` + q.FTS5() + `)`
}

// TSQuery renders the to_tsquery input. websearch_to_tsquery is not used: it
// drops the prefix syntax dilla's search palette needs (gap-69 §3.6), so the
// tsquery is built from the parsed terms instead.
func (q ParsedQuery) TSQuery() string {
	var parts []string
	for _, it := range q.items() {
		if it.phrase {
			words := strings.Split(q.Phrases[it.idx], " ")
			for i := range words {
				words[i] = quoteTS(words[i])
			}
			parts = append(parts, strings.Join(words, " <-> "))
			continue
		}
		t := q.Terms[it.idx]
		s := quoteTS(t.Text)
		if t.Prefix {
			s += ":*"
		}
		parts = append(parts, s)
	}
	out := strings.Join(parts, " & ")
	for _, n := range q.Not {
		words := strings.Split(n, " ")
		for i := range words {
			words[i] = quoteTS(words[i])
		}
		// `!` binds tighter than `<->`, so a negated phrase is parenthesised:
		// `!'a' <-> 'b'` would be "a word other than a, then b".
		neg := strings.Join(words, " <-> ")
		if len(words) > 1 {
			neg = "(" + neg + ")"
		}
		out += " & !" + neg
	}
	return strings.TrimPrefix(strings.TrimSpace(out), "& ")
}

func quoteTS(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
