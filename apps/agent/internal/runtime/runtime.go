// Package runtime runs inference for the agent. The walking skeleton (S04) has two adapters: fake
// (deterministic output, no model) and ollama (a local Ollama server's chat API).
//
// SKELETON(S19): the signed, version-pinned llama.cpp llama-server runtime (ADR 0004, Vulkan for AMD
// test nodes per ADR 0019) and GPU memory release checks replace these adapters for real nodes.
package runtime

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Message is one chat message.
type Message struct {
	Role    string
	Content string
}

// Request is one generation. Numbers follow the protocol (milli units, server-chosen seed).
type Request struct {
	// Model is the protocol model id (for example qwen2.5-0.5b).
	Model            string
	Messages         []Message
	MaxTokens        int64
	TemperatureMilli int64
	TopPMilli        int64
	Stop             []string
	Seed             int64
	Greedy           bool
}

// Result is a finished generation.
type Result struct {
	Text         string
	FinishReason string // "stop" or "length"
	TokensIn     int64
	TokensOut    int64
	LoadMs       int64
	PromptMs     int64
	GenMs        int64
}

// Runtime generates text. Generate must return promptly when ctx is canceled (customer first).
type Runtime interface {
	Name() string // protocol runtimeName: "fake" or "ollama"
	Version() string
	// Models are the protocol model ids this runtime can serve.
	Models() []string
	Generate(ctx context.Context, req Request) (Result, error)
}

// Error carries the protocol error code for job.fail. Buyer content never goes into Err.
type Error struct {
	Code      string
	Retryable bool
	Err       error
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %v", e.Code, e.Err) }
func (e *Error) Unwrap() error { return e.Err }

// AsError maps any error to a protocol code (unknown errors are a retryable runtime crash).
func AsError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return &Error{Code: "runtime_crash", Retryable: true, Err: err}
}

var reModelID = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// ModelID turns a runtime model name (for example Ollama's "qwen2.5:0.5b") into a protocol model id
// ("qwen2.5-0.5b"): lowercase, other characters become '-'. It fails when nothing usable is left.
func ModelID(name string) (string, error) {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			b.WriteRune(r)
		default:
			b.WriteRune('-')
		}
	}
	id := strings.Trim(b.String(), "-._")
	if !reModelID.MatchString(id) {
		return "", fmt.Errorf("model name %q cannot be used as a model id", name)
	}
	return id, nil
}

// ParseModelFlag reads `--model` values: "<id>=<runtime name>" or just "<runtime name>" (the id is
// derived with ModelID). It returns protocol id → runtime name.
func ParseModelFlag(values []string) (map[string]string, error) {
	out := map[string]string{}
	for _, v := range values {
		id, name, hasID := strings.Cut(v, "=")
		if !hasID {
			name = v
			var err error
			if id, err = ModelID(v); err != nil {
				return nil, err
			}
		}
		if !reModelID.MatchString(id) {
			return nil, fmt.Errorf("model id %q must match %s", id, reModelID)
		}
		if name == "" {
			return nil, fmt.Errorf("model %q has an empty runtime name", id)
		}
		if _, dup := out[id]; dup {
			return nil, fmt.Errorf("model id %q given twice", id)
		}
		out[id] = name
	}
	return out, nil
}
