package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"unicode/utf8"
)

// Strict JSON rules shared (algorithm for algorithm) with packages/protocol/src/wire/strict-json.ts:
//   - valid UTF-8 without BOM; whitespace is only space, \t, \n, \r
//   - numbers are integers -?(0|[1-9][0-9]*) with at most 16 digits: no fraction, no exponent
//   - strings: no raw control characters, only standard escapes, \u surrogates must pair
//   - no duplicate keys within one object (compared after unescaping)
//   - at most MaxJSONDepth nested objects/arrays; nothing after the top-level value
//
// Whatever passes is parsed identically by Go's encoding/json and JavaScript's JSON.parse.
const (
	MaxJSONDepth     = 32
	MaxIntegerDigits = 16
)

// ErrStrictJSON wraps every strict-JSON rejection.
var ErrStrictJSON = errors.New("not strict JSON")

// CheckStrictJSON reports whether data satisfies the strict JSON rules.
func CheckStrictJSON(data []byte) error {
	if !utf8.Valid(data) {
		return fmt.Errorf("%w: invalid UTF-8", ErrStrictJSON)
	}
	r := recognizer{s: data}
	if err := r.run(); err != nil {
		return fmt.Errorf("%w: %s", ErrStrictJSON, err.Error())
	}
	return nil
}

type recognizer struct {
	s   []byte
	pos int
}

type scanError struct {
	why string
	at  int
}

func (e *scanError) Error() string { return fmt.Sprintf("%s at offset %d", e.why, e.at) }

func (r *recognizer) fail(why string) error { return &scanError{why: why, at: r.pos} }

func (r *recognizer) peek() int {
	if r.pos < len(r.s) {
		return int(r.s[r.pos])
	}
	return -1
}

func (r *recognizer) run() error {
	r.ws()
	if err := r.value(0); err != nil {
		return err
	}
	r.ws()
	if r.pos != len(r.s) {
		return r.fail("trailing data")
	}
	return nil
}

func (r *recognizer) ws() {
	for {
		c := r.peek()
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			r.pos++
			continue
		}
		return
	}
}

func (r *recognizer) value(depth int) error {
	c := r.peek()
	switch {
	case c == '{':
		return r.object(depth + 1)
	case c == '[':
		return r.array(depth + 1)
	case c == '"':
		return r.str()
	case c == '-' || (c >= '0' && c <= '9'):
		return r.number()
	case c == 't':
		return r.literal("true")
	case c == 'f':
		return r.literal("false")
	case c == 'n':
		return r.literal("null")
	}
	return r.fail("unexpected character")
}

func (r *recognizer) literal(word string) error {
	if bytes.HasPrefix(r.s[r.pos:], []byte(word)) {
		r.pos += len(word)
		return nil
	}
	return r.fail("invalid literal")
}

func (r *recognizer) object(depth int) error {
	if depth > MaxJSONDepth {
		return r.fail("nesting too deep")
	}
	r.pos++ // {
	r.ws()
	if r.peek() == '}' {
		r.pos++
		return nil
	}
	keys := map[string]struct{}{}
	for {
		if r.peek() != '"' {
			return r.fail("expected key")
		}
		start := r.pos
		if err := r.str(); err != nil {
			return err
		}
		var key string
		if err := json.Unmarshal(r.s[start:r.pos], &key); err != nil {
			return r.fail("invalid key")
		}
		if _, dup := keys[key]; dup {
			return r.fail("duplicate key")
		}
		keys[key] = struct{}{}
		r.ws()
		if r.peek() != ':' {
			return r.fail("expected colon")
		}
		r.pos++
		r.ws()
		if err := r.value(depth); err != nil {
			return err
		}
		r.ws()
		switch r.peek() {
		case ',':
			r.pos++
			r.ws()
		case '}':
			r.pos++
			return nil
		default:
			return r.fail("expected comma or closing brace")
		}
	}
}

func (r *recognizer) array(depth int) error {
	if depth > MaxJSONDepth {
		return r.fail("nesting too deep")
	}
	r.pos++ // [
	r.ws()
	if r.peek() == ']' {
		r.pos++
		return nil
	}
	for {
		if err := r.value(depth); err != nil {
			return err
		}
		r.ws()
		switch r.peek() {
		case ',':
			r.pos++
			r.ws()
		case ']':
			r.pos++
			return nil
		default:
			return r.fail("expected comma or closing bracket")
		}
	}
}

func isHex(c int) bool {
	return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f')
}

func hexVal(c int) int {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	default:
		return c - 'A' + 10
	}
}

func (r *recognizer) hex4() (int, error) {
	v := 0
	for i := 0; i < 4; i++ {
		c := r.peek()
		if !isHex(c) {
			return 0, r.fail("invalid unicode escape")
		}
		v = v*16 + hexVal(c)
		r.pos++
	}
	return v, nil
}

func (r *recognizer) str() error {
	r.pos++ // opening quote
	for {
		c := r.peek()
		if c == -1 {
			return r.fail("unterminated string")
		}
		if c == '"' {
			r.pos++
			return nil
		}
		if c < 0x20 {
			return r.fail("control character in string")
		}
		if c != '\\' {
			r.pos++
			continue
		}
		r.pos++ // backslash
		switch r.peek() {
		case '"', '\\', '/', 'b', 'f', 'n', 'r', 't':
			r.pos++
			continue
		case 'u':
		default:
			return r.fail("invalid escape")
		}
		r.pos++
		cu, err := r.hex4()
		if err != nil {
			return err
		}
		if cu >= 0xdc00 && cu <= 0xdfff {
			return r.fail("lone low surrogate escape")
		}
		if cu >= 0xd800 && cu <= 0xdbff {
			if r.peek() != '\\' || r.pos+1 >= len(r.s) || r.s[r.pos+1] != 'u' {
				return r.fail("lone high surrogate escape")
			}
			r.pos += 2
			low, err := r.hex4()
			if err != nil {
				return err
			}
			if low < 0xdc00 || low > 0xdfff {
				return r.fail("lone high surrogate escape")
			}
		}
	}
}

func (r *recognizer) number() error {
	if r.peek() == '-' {
		r.pos++
	}
	start := r.pos
	first := r.peek()
	switch {
	case first == '0':
		r.pos++
	case first >= '1' && first <= '9':
		for c := r.peek(); c >= '0' && c <= '9'; c = r.peek() {
			r.pos++
		}
	default:
		return r.fail("invalid number")
	}
	if r.pos-start > MaxIntegerDigits {
		return r.fail("integer has too many digits")
	}
	if next := r.peek(); next == '.' || next == 'e' || next == 'E' {
		return r.fail("non-integer number")
	}
	return nil
}
