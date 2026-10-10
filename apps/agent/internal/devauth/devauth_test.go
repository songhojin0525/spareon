package devauth

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"spareon/agent/internal/protocol"
)

type vectors struct {
	Cases []struct {
		Secret, Name, NodeID, SeedHex, PublicKey, FpStore, FpGlobal string
		AuthNonce, AuthProtocolHash, AuthSignature                  string
	} `json:"cases"`
	Models []struct {
		ID     string `json:"id"`
		Sha256 string `json:"sha256"`
	} `json:"models"`
	InvalidNames []string `json:"invalidNames"`
}

func load(t *testing.T) vectors {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "protocol", "fixtures", "vectors", "dev-identity.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(v.Cases) == 0 || len(v.Models) == 0 || len(v.InvalidNames) == 0 {
		t.Fatal("vector file is missing cases")
	}
	return v
}

func TestDeriveMatchesTSVectors(t *testing.T) {
	for _, c := range load(t).Cases {
		t.Run(c.Name, func(t *testing.T) {
			id, err := Derive(c.Secret, c.Name)
			if err != nil {
				t.Fatalf("Derive: %v", err)
			}
			want := Identity{Name: c.Name, NodeID: c.NodeID, SeedHex: c.SeedHex, PublicKey: c.PublicKey, FpStore: c.FpStore, FpGlobal: c.FpGlobal}
			if id != want {
				t.Fatalf("identity mismatch:\n got %+v\nwant %+v", id, want)
			}
			msg, err := protocol.AuthSigningBytes(c.AuthNonce, id.NodeID, c.AuthProtocolHash)
			if err != nil {
				t.Fatalf("AuthSigningBytes: %v", err)
			}
			sig, err := protocol.SignEd25519(id.SeedHex, msg)
			if err != nil || sig != c.AuthSignature {
				t.Fatalf("signature = %s, %v; want %s", sig, err, c.AuthSignature)
			}
			if !protocol.VerifyEd25519(id.PublicKey, msg, sig) {
				t.Fatal("signature does not verify")
			}
		})
	}
}

func TestDeriveRejectsBadInput(t *testing.T) {
	for _, name := range load(t).InvalidNames {
		if _, err := Derive("secret-aaaaaaaaaaaaaaaaaaaaaaaa", name); !errors.Is(err, ErrInvalid) {
			t.Errorf("name %q: err = %v, want ErrInvalid", name, err)
		}
	}
	if _, err := Derive("", "pc-1"); !errors.Is(err, ErrInvalid) {
		t.Errorf("empty secret: err = %v", err)
	}
}

func TestModelSha256(t *testing.T) {
	for _, m := range load(t).Models {
		if got := ModelSha256(m.ID); got != m.Sha256 {
			t.Errorf("ModelSha256(%s) = %s, want %s", m.ID, got, m.Sha256)
		}
	}
}
