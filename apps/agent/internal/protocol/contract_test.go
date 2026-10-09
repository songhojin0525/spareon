package protocol

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// Fixture layout and receiver rules: packages/protocol/test/fixtures.ts (the TS twin of this file).
const sizeFixtureLimit = 1024

type fixture struct {
	rel      string
	folder   string
	caseName string
	data     []byte
	expect   string
}

func listFixtures(t *testing.T, kind string) []fixture {
	t.Helper()
	root := filepath.Join(fixtureDir, kind)
	folders, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	var out []fixture
	for _, d := range folders {
		entries, err := os.ReadDir(filepath.Join(root, d.Name()))
		if err != nil {
			t.Fatal(err)
		}
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".json") {
				names = append(names, e.Name())
			}
		}
		sort.Strings(names)
		for _, name := range names {
			stem := strings.TrimSuffix(name, ".json")
			f := fixture{
				rel:    kind + "/" + d.Name() + "/" + name,
				folder: d.Name(),
				data:   readFile(t, filepath.Join(root, d.Name(), name)),
				expect: "ok",
			}
			if kind == "valid" {
				f.caseName = stem
			} else {
				dot := strings.LastIndex(stem, ".")
				f.caseName, f.expect = stem[:dot], stem[dot+1:]
			}
			out = append(out, f)
		}
	}
	return out
}

func isHTTPBody(name string) bool {
	for _, h := range httpRegistry {
		if h.Name == name {
			return true
		}
	}
	return false
}

func other(s Side) Side {
	if s == SideAgent {
		return SideServer
	}
	return SideAgent
}

func invalidReceiver(t *testing.T, c *Codec, f fixture) (Side, int) {
	t.Helper()
	switch f.folder {
	case "_size":
		return SideServer, sizeFixtureLimit
	case "_envelope", "_json":
		return SideServer, 0
	case "_direction":
		var m struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(f.data, &m); err != nil {
			t.Fatal(err)
		}
		from := c.registry[m.Type].From
		if from != FromAgent && from != FromServer {
			t.Fatalf("%s: no wrong direction for %q", f.rel, m.Type)
		}
		return Side(from), 0
	}
	if info, ok := c.registry[f.folder]; ok {
		if info.From == FromBoth {
			return SideServer, 0
		}
		return other(Side(info.From)), 0
	}
	if isHTTPBody(f.folder) {
		return SideServer, 0
	}
	t.Fatalf("%s: unknown fixture folder", f.rel)
	return "", 0
}

func decodeFixture(c *Codec, f fixture, receiver Side, maxBytes int) (any, *DecodeError) {
	opts := DecodeOptions{MaxBytes: maxBytes}
	if isHTTPBody(f.folder) {
		return c.DecodeHTTPBody(f.folder, f.data, opts)
	}
	m, err := c.DecodeMessage(f.data, receiver, opts)
	if err != nil {
		return nil, err
	}
	return m, nil
}

func canonicalOf(t *testing.T, data []byte) string {
	t.Helper()
	out, err := CanonicalizeJSONText(data)
	if err != nil {
		t.Fatalf("canonicalize: %v", err)
	}
	return string(out)
}

// TestContractValidFixtures: every valid fixture decodes for each receiver and survives
// decode -> encode -> decode with the same meaning (S02 acceptance 2, round trip).
func TestContractValidFixtures(t *testing.T) {
	c := mustCodec(t)
	fixtures := listFixtures(t, "valid")
	if len(fixtures) < len(messageRegistry)+len(httpRegistry) {
		t.Fatalf("only %d valid fixtures", len(fixtures))
	}
	for _, f := range fixtures {
		t.Run(f.rel, func(t *testing.T) {
			want := canonicalOf(t, f.data)
			receivers := []Side{SideServer}
			if !isHTTPBody(f.folder) {
				receivers = c.Receivers(f.folder)
			}
			if len(receivers) == 0 {
				t.Fatalf("folder %q is not a message type or http body", f.folder)
			}
			for _, r := range receivers {
				v, derr := decodeFixture(c, f, r, 0)
				if derr != nil {
					t.Fatalf("receiver %s: %v", r, derr)
				}
				var out []byte
				var err error
				if isHTTPBody(f.folder) {
					out, err = c.EncodeHTTPBody(f.folder, v)
				} else {
					m := v.(*Message)
					if m.Type != f.folder {
						t.Fatalf("type %q, want %q", m.Type, f.folder)
					}
					out, err = c.EncodeMessage(m, other(r))
				}
				if err != nil {
					t.Fatalf("encode: %v", err)
				}
				if got := canonicalOf(t, out); got != want {
					t.Fatalf("round trip changed the message:\n got %s\nwant %s", got, want)
				}
			}
		})
	}
}

// TestContractInvalidFixtures: every invalid fixture is rejected with exactly the expected verdict code.
func TestContractInvalidFixtures(t *testing.T) {
	c := mustCodec(t)
	fixtures := listFixtures(t, "invalid")
	if len(fixtures) < 3*(len(messageRegistry)+len(httpRegistry)) {
		t.Fatalf("only %d invalid fixtures", len(fixtures))
	}
	for _, f := range fixtures {
		t.Run(f.rel, func(t *testing.T) {
			r, max := invalidReceiver(t, c, f)
			_, derr := decodeFixture(c, f, r, max)
			got := "ok"
			if derr != nil {
				got = derr.Code
			}
			if got != f.expect {
				t.Fatalf("verdict %q, want %q", got, f.expect)
			}
		})
	}
}

// TestAgentFailSafePause (same rule as the TS contract test): decoded by the agent, a rejection
// pauses when the message's type cannot be known or it is a stop command (registry onInvalid
// "pause"); the server never pauses. Type is reported whenever the envelope was valid.
func TestAgentFailSafePause(t *testing.T) {
	c := mustCodec(t)
	untyped := map[string]bool{CodeMessageTooLarge: true, CodeMalformedJSON: true, CodeInvalidEnvelope: true}
	pausing := 0
	for _, f := range listFixtures(t, "invalid") {
		if isHTTPBody(f.folder) {
			continue
		}
		_, max := invalidReceiver(t, c, f)
		for _, r := range []Side{SideAgent, SideServer} {
			_, derr := c.DecodeMessage(f.data, r, DecodeOptions{MaxBytes: max})
			if derr == nil {
				continue // a misdirected fixture can be valid for the other side
			}
			want := false
			if r == SideAgent {
				want = untyped[derr.Code] ||
					(derr.Code == CodeInvalidPayload && c.registry[derr.Type].OnInvalid == "pause")
			}
			if derr.Pause != want {
				t.Errorf("%s as %s: %s pause %v, want %v", f.rel, r, derr.Code, derr.Pause, want)
			}
			if want && r == SideAgent && derr.Code == CodeInvalidPayload {
				pausing++
			}
			if untyped[derr.Code] != (derr.Type == "") {
				t.Errorf("%s as %s: %s with type %q", f.rel, r, derr.Code, derr.Type)
			}
		}
	}
	if pausing < 9 {
		t.Fatalf("only %d stop-command fixtures pause; want >= 3 per stop command", pausing)
	}
	for _, typ := range []string{TypeControlPause, TypeControlKill, TypeJobCancel} {
		if c.registry[typ].OnInvalid != "pause" {
			t.Errorf("%s must pause when invalid", typ)
		}
	}
	for _, typ := range []string{TypeControlResume, TypeJobOffer, TypeConfigUpdate} {
		if c.registry[typ].OnInvalid != "drop" {
			t.Errorf("%s must not pause when invalid", typ)
		}
	}
}

func TestDecodeDefaultLimit(t *testing.T) {
	c := mustCodec(t)
	big := make([]byte, LimitMaxMessageBytes+1)
	for i := range big {
		big[i] = ' '
	}
	for _, max := range []int{0, -1} {
		if _, derr := c.DecodeMessage(big, SideServer, DecodeOptions{MaxBytes: max}); derr == nil || derr.Code != CodeMessageTooLarge {
			t.Fatalf("MaxBytes %d: %v, want message_too_large at the default 1 MiB", max, derr)
		}
	}
	if _, derr := c.DecodeMessage(big[:LimitMaxMessageBytes], SideServer, DecodeOptions{}); derr == nil || derr.Code != CodeMalformedJSON {
		t.Fatalf("at the limit: %v, want malformed_json (size accepted)", derr)
	}
}

func TestEveryTypeHasFixtures(t *testing.T) {
	valid := listFixtures(t, "valid")
	invalid := listFixtures(t, "invalid")
	var names []string
	for _, m := range messageRegistry {
		names = append(names, m.Type)
	}
	for _, h := range httpRegistry {
		names = append(names, h.Name)
	}
	for _, n := range names {
		v, inv := 0, 0
		kinds := map[string]bool{}
		for _, f := range valid {
			if f.folder == n {
				v++
			}
		}
		for _, f := range invalid {
			if f.folder == n {
				inv++
				for _, p := range []string{"missing-", "type-", "extra-", "size-"} {
					if strings.HasPrefix(f.caseName, p) {
						kinds[p] = true
					}
				}
			}
		}
		if v < 1 || inv < 3 || !kinds["missing-"] || !kinds["type-"] || !(kinds["extra-"] || kinds["size-"]) {
			t.Errorf("%s: %d valid, %d invalid, kinds %v", n, v, inv, kinds)
		}
	}
}

func TestDecodedPayloadIsTyped(t *testing.T) {
	c := mustCodec(t)
	data := readFile(t, filepath.Join(fixtureDir, "valid", "job.offer", "basic.json"))
	m, derr := c.DecodeMessage(data, SideAgent, DecodeOptions{})
	if derr != nil {
		t.Fatal(derr)
	}
	p, ok := m.Payload.(*JobOfferPayload)
	if !ok {
		t.Fatalf("payload is %T", m.Payload)
	}
	if p.Params.Seed != 123456789 || p.Params.TemperatureMilli != 700 || p.Input == nil || len(p.Input.Messages) != 2 {
		t.Fatalf("unexpected payload %+v", p)
	}
	if !bytes.Contains([]byte(p.Input.Messages[1].Content), []byte("😀")) {
		t.Fatal("unicode content lost")
	}
}
