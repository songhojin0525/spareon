package protocol

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

type sigVectors struct {
	Key      struct{ Seed, PublicKey string } `json:"key"`
	OtherKey struct{ Seed, PublicKey string } `json:"otherKey"`
	Auth     struct {
		Input struct {
			Nonce        string `json:"nonce"`
			NodeID       string `json:"nodeId"`
			ProtocolHash string `json:"protocolHash"`
		} `json:"input"`
		BytesHex  string `json:"bytesHex"`
		Signature string `json:"signature"`
		Verify    []struct {
			Name         string `json:"name"`
			PublicKey    string `json:"publicKey"`
			Nonce        string `json:"nonce"`
			NodeID       string `json:"nodeId"`
			ProtocolHash string `json:"protocolHash"`
			Signature    string `json:"signature"`
			Valid        bool   `json:"valid"`
		} `json:"verify"`
		BadInputs []struct {
			Name         string `json:"name"`
			Nonce        string `json:"nonce"`
			NodeID       string `json:"nodeId"`
			ProtocolHash string `json:"protocolHash"`
		} `json:"badInputs"`
	} `json:"auth"`
	Enroll struct {
		Input struct {
			Nonce     string `json:"nonce"`
			EnrollID  string `json:"enrollId"`
			PublicKey string `json:"publicKey"`
			FpStore   string `json:"fpStore"`
			FpGlobal  string `json:"fpGlobal"`
		} `json:"input"`
		BytesHex  string `json:"bytesHex"`
		Signature string `json:"signature"`
		Verify    []struct {
			Name      string `json:"name"`
			Nonce     string `json:"nonce"`
			EnrollID  string `json:"enrollId"`
			PublicKey string `json:"publicKey"`
			FpStore   string `json:"fpStore"`
			FpGlobal  string `json:"fpGlobal"`
			Signature string `json:"signature"`
			Valid     bool   `json:"valid"`
		} `json:"verify"`
	} `json:"enroll"`
	Manifests struct {
		TrustedKeys map[string]string `json:"trustedKeys"`
		Cases       []struct {
			Name     string          `json:"name"`
			Kind     string          `json:"kind"`
			Signed   SignedManifest  `json:"signed"`
			Expect   string          `json:"expect"`
			Manifest json.RawMessage `json:"manifest"`
		} `json:"cases"`
	} `json:"manifests"`
}

func loadSigVectors(t *testing.T) sigVectors {
	t.Helper()
	var v sigVectors
	if err := json.Unmarshal(readFile(t, filepath.Join(fixtureDir, "vectors", "signatures.json")), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// TestSignatureVectors is S02 acceptance 4: Go builds the same bytes, makes the same signatures and
// reaches the same verdicts as the TS tests on the same vector file.
func TestSignatureVectors(t *testing.T) {
	v := loadSigVectors(t)
	for _, k := range []struct{ Seed, PublicKey string }{v.Key, v.OtherKey} {
		pub, err := PublicKeyFromSeed(k.Seed)
		if err != nil || pub != k.PublicKey {
			t.Fatalf("public key %s, want %s (%v)", pub, k.PublicKey, err)
		}
	}

	t.Run("auth bytes and signature", func(t *testing.T) {
		in := v.Auth.Input
		b, err := AuthSigningBytes(in.Nonce, in.NodeID, in.ProtocolHash)
		if err != nil {
			t.Fatal(err)
		}
		if hex.EncodeToString(b) != v.Auth.BytesHex {
			t.Fatalf("bytes %x", b)
		}
		sig, err := SignEd25519(v.Key.Seed, b)
		if err != nil || sig != v.Auth.Signature {
			t.Fatalf("signature %s (%v)", sig, err)
		}
	})
	for _, c := range v.Auth.Verify {
		t.Run("auth verify: "+c.Name, func(t *testing.T) {
			ok := false
			if b, err := AuthSigningBytes(c.Nonce, c.NodeID, c.ProtocolHash); err == nil {
				ok = VerifyEd25519(c.PublicKey, b, c.Signature)
			}
			if ok != c.Valid {
				t.Fatalf("verify %v, want %v", ok, c.Valid)
			}
		})
	}
	for _, c := range v.Auth.BadInputs {
		t.Run("auth bad input: "+c.Name, func(t *testing.T) {
			if _, err := AuthSigningBytes(c.Nonce, c.NodeID, c.ProtocolHash); !errors.Is(err, ErrSigningInput) {
				t.Fatalf("err %v, want ErrSigningInput", err)
			}
		})
	}

	t.Run("enroll bytes and signature", func(t *testing.T) {
		in := v.Enroll.Input
		b, err := EnrollSigningBytes(EnrollSigningInput{in.Nonce, in.EnrollID, in.PublicKey, in.FpStore, in.FpGlobal})
		if err != nil {
			t.Fatal(err)
		}
		if hex.EncodeToString(b) != v.Enroll.BytesHex {
			t.Fatalf("bytes %x", b)
		}
		if sig, _ := SignEd25519(v.Key.Seed, b); sig != v.Enroll.Signature {
			t.Fatalf("signature %s", sig)
		}
	})
	for _, c := range v.Enroll.Verify {
		t.Run("enroll verify: "+c.Name, func(t *testing.T) {
			b, err := EnrollSigningBytes(EnrollSigningInput{c.Nonce, c.EnrollID, c.PublicKey, c.FpStore, c.FpGlobal})
			if err != nil {
				t.Fatal(err)
			}
			if ok := VerifyEd25519(c.PublicKey, b, c.Signature); ok != c.Valid {
				t.Fatalf("verify %v, want %v", ok, c.Valid)
			}
		})
	}

	codec := mustCodec(t)
	for _, c := range v.Manifests.Cases {
		t.Run("manifest: "+c.Name, func(t *testing.T) {
			m, code := codec.VerifySignedManifest(c.Kind, c.Signed, v.Manifests.TrustedKeys)
			got := "ok"
			if code != "" {
				got = code
			}
			if got != c.Expect {
				t.Fatalf("verdict %q, want %q", got, c.Expect)
			}
			if got != "ok" {
				return
			}
			out, err := json.Marshal(m)
			if err != nil {
				t.Fatal(err)
			}
			if canonicalOf(t, out) != canonicalOf(t, c.Manifest) {
				t.Fatalf("decoded manifest differs: %s", out)
			}
		})
	}
}
