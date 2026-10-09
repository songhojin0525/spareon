package protocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sourceBundleHash recomputes protocolHash from packages/protocol/schemas with Go's own strict parser
// and canonicalizer, independently of the TS generator.
func sourceBundleHash(t *testing.T) (string, []byte) {
	t.Helper()
	files := map[string]any{}
	err := filepath.WalkDir(schemaDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".json") {
			return nil
		}
		rel, err := filepath.Rel(schemaDir, path)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		v, err := ParseStrictJSON(data)
		if err != nil {
			t.Fatalf("%s: %v", rel, err)
		}
		files[filepath.ToSlash(rel)] = v
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := CanonicalJSON(map[string]any{"format": "binjari-protocol-bundle/1", "files": files})
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), canonical
}

// TestProtocolHashMatchesTS is S02 acceptance 3: Go derives the same hash from the source schemas as
// the TS generator wrote into ProtocolHash (and into the TS PROTOCOL_HASH constant).
func TestProtocolHashMatchesTS(t *testing.T) {
	got, canonical := sourceBundleHash(t)
	if got != ProtocolHash {
		t.Fatalf("hash from source schemas %s != generated ProtocolHash %s (run pnpm --filter @binjari/protocol gen)", got, ProtocolHash)
	}
	if !bytes.Equal(canonical, bytes.TrimSuffix(bundleJSON, []byte("\n"))) {
		t.Fatal("embedded bundle.json differs from the canonical source bundle (run gen)")
	}
	ts := string(readFile(t, filepath.Join(protocolPkgDir, "src", "generated", "protocol.ts")))
	if !strings.Contains(ts, "export const PROTOCOL_HASH = '"+ProtocolHash+"';") {
		t.Fatal("TS PROTOCOL_HASH differs from Go ProtocolHash")
	}
}

func TestCodecRejectsTamperedBundle(t *testing.T) {
	tampered := bytes.Replace(bundleJSON, []byte(`"maxMessageBytes":1048576`), []byte(`"maxMessageBytes":1048577`), 1)
	if bytes.Equal(tampered, bundleJSON) {
		t.Fatal("tamper target not found")
	}
	if _, err := newCodec(tampered); err == nil {
		t.Fatal("codec accepted a bundle whose hash differs from ProtocolHash")
	}
}
