package protocol

import (
	"bytes"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestUUIDv7MatchesTSVector(t *testing.T) {
	// Same input as packages/shared/test/ids.test.ts.
	at := time.UnixMilli(0x01898f2b2c3d)
	id, err := NewUUIDv7(at, bytes.NewReader([]byte{0xff, 0x01, 0xff, 2, 3, 4, 5, 6, 7, 8}))
	if err != nil {
		t.Fatal(err)
	}
	if id != "01898f2b-2c3d-7f01-bf02-030405060708" {
		t.Fatalf("got %s", id)
	}
	if !reUUIDv7.MatchString(id) {
		t.Fatal("not a canonical UUIDv7")
	}
	if _, err := NewUUIDv7(time.UnixMilli(-1), bytes.NewReader(make([]byte, 10))); err == nil {
		t.Fatal("negative time accepted")
	}
	if _, err := NewUUIDv7(at, bytes.NewReader(make([]byte, 9))); err == nil {
		t.Fatal("short randomness accepted")
	}
}

func TestTimestamps(t *testing.T) {
	at := time.Date(2026, 10, 9, 13, 36, 0, 7_000_000, time.FixedZone("KST", 9*3600))
	if got := FormatTimestamp(at); got != "2026-10-09T04:36:00.007Z" {
		t.Fatalf("got %s", got)
	}
	if _, err := ParseTimestamp("2026-10-09T04:36:00.007Z"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		"2026-02-30T00:00:00.000Z",
		"2026-10-09T24:00:00.000Z",
		"2026-10-09T04:36:00Z",
		"2026-10-09T04:36:00.000+09:00",
		"2026-10-09T04:36:00.0000Z",
	} {
		if _, err := ParseTimestamp(bad); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}

var (
	displayRe    = regexp.MustCompile(`^[A-Za-z0-9 ()._,:/+#@\[\]-]{1,128}$`)
	tokenRe      = regexp.MustCompile(`^[A-Za-z0-9._+-]{1,64}$`)
	diagnosticRe = regexp.MustCompile(`^[A-Za-z0-9 ()._,:/+#@=\[\]-]{0,256}$`)
)

func TestSanitizersAlwaysMatchTheSchemaPatterns(t *testing.T) {
	inputs := []string{
		"", " ", "NVIDIA GeForce RTX 4090", "Intel(R) Core(TM) i5-12400F", "<script>alert(1)</script>",
		`a"b'c&d`, "한글 GPU", "\x00\xff\xfe", strings.Repeat("x", 500), "560.94 beta", "10.0.22631.4317",
	}
	for _, in := range inputs {
		if out := SanitizeDisplayText(in); !displayRe.MatchString(out) {
			t.Errorf("display %q -> %q", in, out)
		}
		if out := SanitizeToken(in); !tokenRe.MatchString(out) {
			t.Errorf("token %q -> %q", in, out)
		}
		if out := SanitizeDiagnostic(in); !diagnosticRe.MatchString(out) {
			t.Errorf("diagnostic %q -> %q", in, out)
		}
	}
	if got := SanitizeDisplayText("NVIDIA GeForce RTX 4090"); got != "NVIDIA GeForce RTX 4090" {
		t.Fatalf("changed a clean name: %q", got)
	}
}

func TestEncodeRefusesInvalidMessages(t *testing.T) {
	c := mustCodec(t)
	id, ts := "01920000-0000-7000-8000-000000000001", "2026-10-09T04:36:00.000Z"
	// job.accept requires corr.
	if _, err := c.EncodeMessage(NewMessage(TypeJobAccept, id, ts, nil, &JobAcceptPayload{AttemptID: id}), SideAgent); err == nil {
		t.Fatal("encoded job.accept without corr")
	}
	// Agents never send job.offer.
	if _, err := c.EncodeMessage(NewMessage(TypeHeartbeat, id, ts, nil, &HeartbeatPayload{}), SideServer); err == nil {
		t.Fatal("server encoded an agent-only message")
	}
	// A nil required array marshals to null and must be refused.
	st := &StatusPayload{State: StatusStateReady, Presence: StatusPresence{ReasonCodes: []StatusPresenceReasonCode{}}, MeasuredAt: ts}
	if _, err := c.EncodeMessage(NewMessage(TypeStatus, id, ts, nil, st), SideAgent); err == nil {
		t.Fatal("encoded status with null arrays")
	}
	st.GPUs = []StatusGPU{}
	st.RunningAttemptIDs = []string{}
	if _, err := c.EncodeMessage(NewMessage(TypeStatus, id, ts, nil, st), SideAgent); err != nil {
		t.Fatalf("valid status refused: %v", err)
	}
}

func TestInlineTextLimitBoundary(t *testing.T) {
	c := mustCodec(t)
	id, ts := "01920000-0000-7000-8000-000000000001", "2026-10-09T04:36:00.000Z"
	offer := func(content string) *Message {
		return NewMessage(TypeJobOffer, id, ts, nil, &JobOfferPayload{
			AttemptID: id,
			JobKind:   JobOfferJobKindChat,
			Model:     ModelRef{ID: "m", Sha256: strings.Repeat("e1", 32)},
			Params:    JobOfferParams{MaxTokens: 1, TopPMilli: 1000, Stop: []string{}, Seed: 1},
			Input:     &JobInput{Messages: []JobInputMessage{{Role: JobInputMessageRoleUser, Content: content}}},
			Stream:    true, TimeLimitMs: 600000, LeaseTTLMs: 15000,
		})
	}
	atLimit := strings.Repeat("a", LimitMaxInlineTextBytes-2) + "é"
	if _, err := c.EncodeMessage(offer(atLimit), SideServer); err != nil {
		t.Fatalf("at limit refused: %v", err)
	}
	if _, err := c.EncodeMessage(offer(atLimit+"a"), SideServer); err == nil {
		t.Fatal("one byte over the limit accepted")
	}
}
