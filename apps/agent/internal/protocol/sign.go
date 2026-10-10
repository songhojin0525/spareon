package protocol

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Signed byte strings, shared with packages/protocol/src/sign.ts and pinned by
// packages/protocol/fixtures/vectors/signatures.json. Each starts with a domain string and "\n" so a
// signature for one purpose never verifies for another; every component is format-checked (no "\n"
// possible) before the bytes are built.
const (
	AuthDomain            = "spareon-auth-v1"
	EnrollDomain          = "spareon-enroll-v1"
	ModelManifestDomain   = "spareon-model-manifest-v1"
	ReleaseManifestDomain = "spareon-release-manifest-v1"
)

// ErrSigningInput is returned when a signing-bytes component has the wrong format.
var ErrSigningInput = errors.New("signing input has the wrong format")

var (
	reHex32  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	reHex64  = regexp.MustCompile(`^[0-9a-f]{128}$`)
	reUUIDv7 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
)

func need(re *regexp.Regexp, v, what string) error {
	if !re.MatchString(v) {
		return fmt.Errorf("%w: %s", ErrSigningInput, what)
	}
	return nil
}

// AuthSigningBytes is "spareon-auth-v1\n" + nonce + "\n" + nodeId + "\n" + protocolHash (ADR 0008).
func AuthSigningBytes(nonce, nodeID, protocolHash string) ([]byte, error) {
	if err := errors.Join(
		need(reHex32, nonce, "nonce"),
		need(reUUIDv7, nodeID, "nodeId"),
		need(reHex32, protocolHash, "protocolHash"),
	); err != nil {
		return nil, err
	}
	return []byte(strings.Join([]string{AuthDomain, nonce, nodeID, protocolHash}, "\n")), nil
}

// EnrollSigningInput are the enroll.complete fields covered by the signature.
type EnrollSigningInput struct {
	Nonce     string
	EnrollID  string
	PublicKey string
	FpStore   string
	FpGlobal  string
}

// EnrollSigningBytes is "spareon-enroll-v1\n" + nonce + "\n" + enrollId + "\n" + publicKey + "\n" +
// fpStore + "\n" + fpGlobal.
func EnrollSigningBytes(in EnrollSigningInput) ([]byte, error) {
	if err := errors.Join(
		need(reHex32, in.Nonce, "nonce"),
		need(reUUIDv7, in.EnrollID, "enrollId"),
		need(reHex32, in.PublicKey, "publicKey"),
		need(reHex32, in.FpStore, "fpStore"),
		need(reHex32, in.FpGlobal, "fpGlobal"),
	); err != nil {
		return nil, err
	}
	return []byte(strings.Join([]string{EnrollDomain, in.Nonce, in.EnrollID, in.PublicKey, in.FpStore, in.FpGlobal}, "\n")), nil
}

func manifestDomain(kind string) (string, bool) {
	switch kind {
	case "model":
		return ModelManifestDomain, true
	case "release":
		return ReleaseManifestDomain, true
	}
	return "", false
}

// ManifestSigningBytes is "spareon-<kind>-manifest-v1\n" + the manifest text exactly as transmitted.
func ManifestSigningBytes(kind, manifestJSON string) ([]byte, error) {
	d, ok := manifestDomain(kind)
	if !ok {
		return nil, fmt.Errorf("%w: unknown manifest kind %q", ErrSigningInput, kind)
	}
	return []byte(d + "\n" + manifestJSON), nil
}

// PublicKeyFromSeed returns the lowercase-hex ed25519 public key of a lowercase-hex 32-byte seed.
func PublicKeyFromSeed(seedHex string) (string, error) {
	if err := need(reHex32, seedHex, "seed"); err != nil {
		return "", err
	}
	seed, _ := hex.DecodeString(seedHex)
	pub, _ := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
	return hex.EncodeToString(pub), nil
}

// SignEd25519 signs msg with a lowercase-hex seed (deterministic; tools and tests only — the agent's
// identity key lives in its KeyStore).
func SignEd25519(seedHex string, msg []byte) (string, error) {
	if err := need(reHex32, seedHex, "seed"); err != nil {
		return "", err
	}
	seed, _ := hex.DecodeString(seedHex)
	return hex.EncodeToString(ed25519.Sign(ed25519.NewKeyFromSeed(seed), msg)), nil
}

// orderL is the edwards25519 group order, little-endian. Signatures with S >= L are rejected.
var orderL = [32]byte{
	0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
}

func scalarIsCanonical(s []byte) bool {
	for i := 31; i >= 0; i-- {
		if s[i] != orderL[i] {
			return s[i] < orderL[i]
		}
	}
	return false // S == L
}

// fieldP is the field prime p = 2^255 - 19, little-endian.
var fieldP = [32]byte{
	0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
	0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
}

// smallOrderY lists the y-coordinates (little-endian hex, sign bit clear) of the 8 small-order points of
// edwards25519: y = 1 (identity), y = p - 1 (order 2), y = 0 (order 4, two points) and the two order-8
// y values (four points).
var smallOrderY = []string{
	"0100000000000000000000000000000000000000000000000000000000000000",
	"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	"0000000000000000000000000000000000000000000000000000000000000000",
	"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
	"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
}

// IsAcceptablePublicKey reports whether a public key may be enrolled and used: lowercase hex of 32
// bytes, canonically encoded (y < p) and not one of the 8 small-order points. crypto/ed25519 (like
// OpenSSL) accepts small-order keys, for which anyone can forge signatures without a private key, and
// non-canonical encodings, which give one key several spellings. Same rules as the TS twin.
func IsAcceptablePublicKey(publicKeyHex string) bool {
	if !reHex32.MatchString(publicKeyHex) {
		return false
	}
	y, _ := hex.DecodeString(publicKeyHex)
	y[31] &= 0x7f
	belowP := false
	for i := 31; i >= 0; i-- {
		if y[i] != fieldP[i] {
			belowP = y[i] < fieldP[i]
			break
		}
	}
	if !belowP {
		return false
	}
	yHex := hex.EncodeToString(y)
	for _, s := range smallOrderY {
		if yHex == s {
			return false
		}
	}
	return true
}

// VerifyEd25519 verifies a signature. Inputs must be lowercase hex of the exact length; anything else,
// a non-canonical S, or a public key IsAcceptablePublicKey refuses is false. Same rules as the TS twin.
func VerifyEd25519(publicKeyHex string, msg []byte, signatureHex string) bool {
	if !IsAcceptablePublicKey(publicKeyHex) || !reHex64.MatchString(signatureHex) {
		return false
	}
	pub, _ := hex.DecodeString(publicKeyHex)
	sig, _ := hex.DecodeString(signatureHex)
	if !scalarIsCanonical(sig[32:]) {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(pub), msg, sig)
}

// Manifest verification failures (error codes from schemas/defs/error-codes.json).
const (
	CodeManifestSignatureInvalid = "manifest_signature_invalid"
	CodeManifestInvalid          = "manifest_invalid"
)

// VerifySignedManifest is verify-then-parse: (1) known keyId, (2) signature over the exact transmitted
// bytes, (3) strict JSON, (4) the text is already canonical, (5) manifest schema. It returns the
// decoded manifest (*ModelManifest or *ReleaseManifest) or an error code.
func (c *Codec) VerifySignedManifest(kind string, signed SignedManifest, trustedKeys map[string]string) (any, string) {
	key, ok := trustedKeys[signed.KeyID]
	if !ok {
		return nil, CodeManifestSignatureInvalid
	}
	msg, err := ManifestSigningBytes(kind, signed.Manifest)
	if err != nil || !VerifyEd25519(key, msg, signed.Signature) {
		return nil, CodeManifestSignatureInvalid
	}
	inst, err := ParseStrictJSON([]byte(signed.Manifest))
	if err != nil {
		return nil, CodeManifestInvalid
	}
	canonical, err := CanonicalJSON(inst)
	if err != nil || !bytes.Equal(canonical, []byte(signed.Manifest)) {
		return nil, CodeManifestInvalid
	}
	if !c.validManifest(kind, inst) {
		return nil, CodeManifestInvalid
	}
	out := newManifest(kind)
	if out == nil || decodeStrict([]byte(signed.Manifest), out) != nil {
		return nil, CodeManifestInvalid
	}
	return out, ""
}
