// Package devauth derives the development identity of an S04 walking-skeleton agent from a shared
// secret. packages/protocol/src/dev-identity.ts is the TS twin; both are pinned by
// packages/protocol/fixtures/vectors/dev-identity.json.
//
// SKELETON(S10): enrollment (enroll.start/complete, a stored device key, hardware fingerprints) replaces
// this package. Until then an agent and the server that share DEV_AGENT_SECRET derive the same node id,
// fingerprints and ed25519 device key, so the real hello -> auth.challenge -> auth.prove handshake runs
// unchanged. Anyone who knows the secret can act as any node: development only.
package devauth

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"time"

	"binjari/agent/internal/protocol"
)

// NodeIDEpochMs is the timestamp embedded in derived node ids (2026-01-01T00:00:00Z).
const NodeIDEpochMs = 1_767_225_600_000

const (
	domainNodeID   = "binjari-dev-node-id-v1"
	domainNodeKey  = "binjari-dev-node-key-v1"
	domainFpStore  = "binjari-dev-fp-store-v1"
	domainFpGlobal = "binjari-dev-fp-global-v1"
	domainModel    = "binjari-dev-model-v1"
)

var reName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// ErrInvalid reports a bad name or secret.
var ErrInvalid = errors.New("devauth: invalid input")

// Identity is everything an agent needs for hello and auth.prove.
type Identity struct {
	Name      string
	NodeID    string
	SeedHex   string
	PublicKey string
	FpStore   string
	FpGlobal  string
}

func mac(secret, domain, value string) []byte {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(domain + "\n" + value))
	return m.Sum(nil)
}

// ValidName reports whether name may be used as a node name (1..64 of A-Z a-z 0-9 . _ -).
func ValidName(name string) bool { return reName.MatchString(name) }

// Derive returns the identity of the agent called name.
func Derive(secret, name string) (Identity, error) {
	if secret == "" {
		return Identity{}, fmt.Errorf("%w: secret is empty", ErrInvalid)
	}
	if !ValidName(name) {
		return Identity{}, fmt.Errorf("%w: node name must be 1..64 characters of A-Z a-z 0-9 . _ -", ErrInvalid)
	}
	nodeID, err := protocol.NewUUIDv7(time.UnixMilli(NodeIDEpochMs), bytes.NewReader(mac(secret, domainNodeID, name)))
	if err != nil {
		return Identity{}, fmt.Errorf("devauth: node id: %w", err)
	}
	seed := NodeSeed(secret, nodeID)
	pub, err := protocol.PublicKeyFromSeed(seed)
	if err != nil {
		return Identity{}, fmt.Errorf("devauth: public key: %w", err)
	}
	return Identity{
		Name:      name,
		NodeID:    nodeID,
		SeedHex:   seed,
		PublicKey: pub,
		FpStore:   hex.EncodeToString(mac(secret, domainFpStore, name)),
		FpGlobal:  hex.EncodeToString(mac(secret, domainFpGlobal, name)),
	}, nil
}

// NodeSeed is the ed25519 seed (lowercase hex) of a node: what a server re-derives from the node id
// alone to check auth.prove.
func NodeSeed(secret, nodeID string) string {
	return hex.EncodeToString(mac(secret, domainNodeKey, nodeID))
}

// ModelSha256 is the placeholder model digest used until signed model manifests exist.
// SKELETON(S09): replaced by the manifest sha256 from the model registry.
func ModelSha256(modelID string) string {
	sum := sha256.Sum256([]byte(domainModel + "\n" + modelID))
	return hex.EncodeToString(sum[:])
}
