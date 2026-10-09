package protocol

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf8"
)

// TimestampLayout is the only wire time format: RFC 3339, UTC, exactly milliseconds.
const TimestampLayout = "2006-01-02T15:04:05.000Z"

// FormatTimestamp renders t in the wire format (converted to UTC).
func FormatTimestamp(t time.Time) string { return t.UTC().Format(TimestampLayout) }

// ParseTimestamp accepts only the canonical spelling of a real instant (2026-02-30 is rejected).
// Callers treat a failure as "time unknown" (ARCHITECTURE 7: uncertain schedule = no work).
func ParseTimestamp(s string) (time.Time, error) {
	t, err := time.Parse(TimestampLayout, s)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse timestamp: %w", err)
	}
	if FormatTimestamp(t) != s {
		return time.Time{}, fmt.Errorf("parse timestamp: %q is not canonical", s)
	}
	return t, nil
}

// NewUUIDv7 builds a UUIDv7 (RFC 9562) from an explicit instant and a randomness source.
func NewUUIDv7(now time.Time, rnd io.Reader) (string, error) {
	ms := now.UnixMilli()
	if ms < 0 || ms >= 1<<48 {
		return "", fmt.Errorf("uuidv7: time out of range")
	}
	var r [10]byte
	if _, err := io.ReadFull(rnd, r[:]); err != nil {
		return "", fmt.Errorf("uuidv7: read random: %w", err)
	}
	var b [16]byte
	for i := 5; i >= 0; i-- {
		b[i] = byte(ms)
		ms >>= 8
	}
	b[6] = 0x70 | (r[0] & 0x0f)
	b[7] = r[1]
	b[8] = 0x80 | (r[2] & 0x3f)
	copy(b[9:], r[3:10])
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:], nil
}

// NewMessage builds an envelope (version 1). Validation happens in EncodeMessage.
func NewMessage(msgType, id, ts string, corr *string, payload any) *Message {
	return &Message{V: 1, Type: msgType, ID: id, TS: ts, Corr: corr, Payload: payload}
}

func sanitize(s string, maxRunes int, allowed func(r rune) bool, empty string) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if n == maxRunes {
			break
		}
		if r == utf8.RuneError || !allowed(r) {
			r = '_'
		}
		b.WriteRune(r)
		n++
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		return empty
	}
	return out
}

func isAlnum(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
}

// SanitizeDisplayText maps hardware strings (GPU/CPU names) onto the displayText schema: allowed ASCII
// characters only (others become '_'), at most 128 characters, never empty. THREAT_MODEL WEB-03.
func SanitizeDisplayText(s string) string {
	return sanitize(s, 128, func(r rune) bool {
		return isAlnum(r) || strings.ContainsRune(" ()._,:/+#@[]-", r)
	}, "unknown")
}

// SanitizeToken maps version-like strings (driver, runtime, OS build) onto the token schema.
func SanitizeToken(s string) string {
	return sanitize(strings.ReplaceAll(s, " ", "_"), 64, func(r rune) bool {
		return isAlnum(r) || strings.ContainsRune("._+-", r)
	}, "unknown")
}

// SanitizeDiagnostic maps an internal error description onto the diagnosticText schema (error.message).
// It must still never be given buyer content.
func SanitizeDiagnostic(s string) string {
	return sanitize(s, 256, func(r rune) bool {
		return isAlnum(r) || strings.ContainsRune(" ()._,:/+#@=[]-", r)
	}, "")
}

// CapabilitiesDigest is hello.capabilitiesDigest: SHA-256 of the canonical JSON of the capabilities
// payload (TS twin: capabilitiesDigest).
func CapabilitiesDigest(p *CapabilitiesPayload) (string, error) {
	raw, err := marshal(p)
	if err != nil {
		return "", fmt.Errorf("capabilities digest: %w", err)
	}
	canonical, err := CanonicalizeJSONText(raw)
	if err != nil {
		return "", fmt.Errorf("capabilities digest: %w", err)
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}
