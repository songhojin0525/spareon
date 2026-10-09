package protocol

import (
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"testing"
)

type jsonVector struct {
	Name      string  `json:"name"`
	Input     *string `json:"input"`
	InputHex  *string `json:"inputHex"`
	Strict    string  `json:"strict"`
	Canonical *string `json:"canonical"`
}

// TestJSONVectors runs the strict/canonical JSON vectors shared with the TS tests.
func TestJSONVectors(t *testing.T) {
	var doc struct {
		Cases []jsonVector `json:"cases"`
	}
	if err := json.Unmarshal(readFile(t, filepath.Join(fixtureDir, "vectors", "json.json")), &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Cases) < 50 {
		t.Fatalf("only %d vectors", len(doc.Cases))
	}
	for _, v := range doc.Cases {
		t.Run(v.Name, func(t *testing.T) {
			var in []byte
			switch {
			case v.InputHex != nil:
				b, err := hex.DecodeString(*v.InputHex)
				if err != nil {
					t.Fatal(err)
				}
				in = b
			case v.Input != nil:
				in = []byte(*v.Input)
			}
			err := CheckStrictJSON(in)
			if got := err == nil; got != (v.Strict == "ok") {
				t.Fatalf("strict: got ok=%v (%v), want %s", got, err, v.Strict)
			}
			out, err := CanonicalizeJSONText(in)
			if v.Canonical == nil {
				if err == nil {
					t.Fatalf("canonical: got %q, want rejection", out)
				}
				return
			}
			if err != nil {
				t.Fatalf("canonical: %v", err)
			}
			if string(out) != *v.Canonical {
				t.Fatalf("canonical:\n got %q\nwant %q", out, *v.Canonical)
			}
		})
	}
}

func TestCanonicalIsFixedPoint(t *testing.T) {
	inputs := []string{
		`{"b":[1,{"z":null,"a":"é"}],"a":true}`,
		`["😀","｡",""]`,
		`{"":{"":[]}}`,
	}
	for _, s := range inputs {
		once, err := CanonicalizeJSONText([]byte(s))
		if err != nil {
			t.Fatal(err)
		}
		twice, err := CanonicalizeJSONText(once)
		if err != nil {
			t.Fatal(err)
		}
		if string(once) != string(twice) {
			t.Fatalf("not a fixed point: %q -> %q", once, twice)
		}
	}
}
