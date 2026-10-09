package protocol

import (
	"os"
	"path/filepath"
	"testing"
)

// The TS package owns the contract files; Go tests read them in place (go test runs in this directory).
var (
	protocolPkgDir = filepath.Join("..", "..", "..", "..", "packages", "protocol")
	fixtureDir     = filepath.Join(protocolPkgDir, "fixtures")
	schemaDir      = filepath.Join(protocolPkgDir, "schemas")
)

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return b
}

func mustCodec(t *testing.T) *Codec {
	t.Helper()
	c, err := NewCodec()
	if err != nil {
		t.Fatalf("NewCodec: %v", err)
	}
	return c
}
