// Package protocol is the agent side of the binjari agent<->server protocol contract (S02).
//
// The JSON Schemas in packages/protocol/schemas are the single source of truth. The TS generator
// (packages/protocol/scripts/gen.ts) writes zz_generated.go and bundle.json here; both are checked for
// freshness by the TS tests, and this package re-derives the protocol hash from the source schemas in
// its own tests so TS and Go provably agree.
package protocol

import (
	_ "embed"
)

// bundleJSON is the canonical JSON of the schema bundle; its SHA-256 is ProtocolHash.
//
//go:embed bundle.json
var bundleJSON []byte

// Direction of a message: who sends it.
const (
	FromAgent  = "agent"
	FromServer = "server"
	FromBoth   = "both"
)

type messageInfo struct {
	Type      string
	From      string
	Corr      string
	Replies   []string
	TimeoutMs int64
}

type httpInfo struct {
	Name    string
	From    string
	Method  string
	Path    string
	Replies []string
}

type errorCodeInfo struct {
	Code        string
	From        string
	Retryable   bool
	Fatal       bool
	AgentAction string
}
