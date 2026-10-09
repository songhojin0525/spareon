package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// Canonical JSON (a subset of RFC 8785 JCS), shared with packages/protocol/src/wire/canonical-json.ts:
//   - object keys sorted by UTF-16 code units, no insignificant whitespace
//   - strings escape only '"', '\' and control characters below U+0020 (\b \t \n \f \r, others \u00xx)
//   - numbers must be integers with |n| <= 2^53-1, plain decimal; -0 becomes 0

// MaxSafeInteger is 2^53-1, the largest integer JavaScript represents exactly.
const MaxSafeInteger = 1<<53 - 1

// ErrNotCanonicalizable is returned for values canonical JSON cannot carry.
var ErrNotCanonicalizable = errors.New("value cannot be canonicalized")

// ParseStrictJSON checks the strict JSON rules and decodes into generic values (numbers as json.Number).
func ParseStrictJSON(data []byte) (any, error) {
	if err := CheckStrictJSON(data); err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, fmt.Errorf("%w: %s", ErrStrictJSON, err.Error())
	}
	return v, nil
}

// CanonicalizeJSONText strict-parses JSON text and returns its canonical form.
func CanonicalizeJSONText(data []byte) ([]byte, error) {
	v, err := ParseStrictJSON(data)
	if err != nil {
		return nil, err
	}
	return CanonicalJSON(v)
}

// CanonicalJSON writes a generic JSON value (as produced by ParseStrictJSON) in canonical form.
func CanonicalJSON(v any) ([]byte, error) {
	var b bytes.Buffer
	if err := writeCanonical(&b, v); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

func writeCanonical(b *bytes.Buffer, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case json.Number:
		n, err := strconv.ParseInt(string(x), 10, 64)
		if err != nil || n > MaxSafeInteger || n < -MaxSafeInteger {
			return fmt.Errorf("%w: number %q is not a safe integer", ErrNotCanonicalizable, string(x))
		}
		b.WriteString(strconv.FormatInt(n, 10))
	case string:
		return writeCanonicalString(b, x)
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeCanonical(b, e); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return lessUTF16(keys[i], keys[j]) })
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeCanonicalString(b, k); err != nil {
				return err
			}
			b.WriteByte(':')
			if err := writeCanonical(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("%w: unsupported type %T", ErrNotCanonicalizable, v)
	}
	return nil
}

func writeCanonicalString(b *bytes.Buffer, s string) error {
	if !utf8.ValidString(s) {
		return fmt.Errorf("%w: invalid UTF-8 in string", ErrNotCanonicalizable)
	}
	b.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if c < 0x20 {
				fmt.Fprintf(b, `\u%04x`, c)
			} else {
				b.WriteByte(c)
			}
		}
	}
	b.WriteByte('"')
	return nil
}

// lessUTF16 orders strings by UTF-16 code units (the JavaScript default sort), not by UTF-8 bytes.
func lessUTF16(a, b string) bool {
	ua := utf16.Encode([]rune(a))
	ub := utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}
