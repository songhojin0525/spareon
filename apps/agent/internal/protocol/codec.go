package protocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// Decode pipeline shared with packages/protocol/src/codec.ts. Steps run in this order and the first
// failure decides the verdict code (the contract tests require TS and Go to agree on every fixture):
//
//  1. byte size > max                         -> message_too_large
//  2. strict JSON (strictjson.go)             -> malformed_json
//  3. envelope.json                           -> invalid_envelope
//  4. type not in the registry                -> unknown_type
//  5. receiver is the sender of this type     -> wrong_direction
//  6. messages/<type>.json                    -> invalid_payload
//  7. inline text UTF-8 bytes > limit         -> invalid_payload
//
// HTTP bodies: 1 (LimitMaxHTTPBodyBytes), 2, then http/<name>.json and 7 -> invalid_payload.

// Verdict codes.
const (
	CodeMessageTooLarge = "message_too_large"
	CodeMalformedJSON   = "malformed_json"
	CodeInvalidEnvelope = "invalid_envelope"
	CodeUnknownType     = "unknown_type"
	CodeWrongDirection  = "wrong_direction"
	CodeInvalidPayload  = "invalid_payload"
)

// SchemaBaseURI prefixes every schema $id; ".invalid" never resolves, and no loader is installed.
const SchemaBaseURI = "https://schemas.binjari.invalid/protocol/"

// Side is a protocol endpoint.
type Side string

// Endpoints.
const (
	SideAgent  Side = "agent"
	SideServer Side = "server"
)

// DecodeError is a rejected message. Detail is diagnostic only and never contains message content.
type DecodeError struct {
	Code   string
	Detail string
	// ID is the envelope id when the envelope was valid (for an error reply's corr).
	ID string
	// Type is the envelope type when the envelope was valid (even if unknown or misdirected).
	Type string
	// Pause is the agent fail-safe (PROTOCOL.md 4절): true when the receiver is the agent and the
	// rejected message was a stop command (registry onInvalid "pause") or its type cannot be known
	// (message_too_large, malformed_json, invalid_envelope). The agent then pauses as for
	// control.pause. Always false for the server and for HTTP bodies.
	Pause bool
}

func (e *DecodeError) Error() string { return e.Code + ": " + e.Detail }

// DecodeOptions overrides the byte limit (zero or negative = protocol default, as in TS).
type DecodeOptions struct {
	MaxBytes int
}

// Message is a decoded envelope. Payload is a pointer to the generated payload struct of Type.
type Message struct {
	V       int64   `json:"v"`
	Type    string  `json:"type"`
	ID      string  `json:"id"`
	TS      string  `json:"ts"`
	Corr    *string `json:"corr,omitempty"`
	Payload any     `json:"payload"`
}

type rawMessage struct {
	Payload json.RawMessage `json:"payload"`
}

// Codec validates and (de)serializes protocol messages against one schema bundle.
type Codec struct {
	hash      string
	envelope  *jsonschema.Schema
	messages  map[string]*jsonschema.Schema
	http      map[string]*jsonschema.Schema
	manifests map[string]*jsonschema.Schema
	registry  map[string]messageInfo
	httpInfo  map[string]httpInfo
}

type noLoader struct{}

func (noLoader) Load(url string) (any, error) {
	return nil, fmt.Errorf("schema %s is not in the bundle (remote loading is disabled)", url)
}

// NewCodec compiles the embedded bundle and checks that it hashes to ProtocolHash.
func NewCodec() (*Codec, error) {
	return newCodec(bundleJSON)
}

func newCodec(bundle []byte) (*Codec, error) {
	bundle = bytes.TrimSuffix(bundle, []byte("\n"))
	doc, err := ParseStrictJSON(bundle)
	if err != nil {
		return nil, fmt.Errorf("bundle: %w", err)
	}
	canonical, err := CanonicalJSON(doc)
	if err != nil {
		return nil, fmt.Errorf("bundle: %w", err)
	}
	sum := sha256.Sum256(canonical)
	hash := hex.EncodeToString(sum[:])
	if hash != ProtocolHash {
		return nil, fmt.Errorf("bundle hash %s does not match ProtocolHash %s", hash, ProtocolHash)
	}
	root, ok := doc.(map[string]any)
	if !ok {
		return nil, errors.New("bundle: not an object")
	}
	files, ok := root["files"].(map[string]any)
	if !ok {
		return nil, errors.New("bundle: files missing")
	}
	// The compiler wants the same generic shape (json.Number) that jsonschema.UnmarshalJSON produces.
	c := jsonschema.NewCompiler()
	c.DefaultDraft(jsonschema.Draft2020)
	c.UseLoader(noLoader{})
	for rel, f := range files {
		m, ok := f.(map[string]any)
		if !ok {
			continue
		}
		if _, isSchema := m["$schema"]; !isSchema {
			continue
		}
		if id, _ := m["$id"].(string); id != SchemaBaseURI+rel {
			return nil, fmt.Errorf("bundle: %s has $id %q", rel, id)
		}
		if err := c.AddResource(SchemaBaseURI+rel, m); err != nil {
			return nil, fmt.Errorf("bundle: add %s: %w", rel, err)
		}
	}
	cd := &Codec{
		hash:      hash,
		messages:  map[string]*jsonschema.Schema{},
		http:      map[string]*jsonschema.Schema{},
		manifests: map[string]*jsonschema.Schema{},
		registry:  map[string]messageInfo{},
		httpInfo:  map[string]httpInfo{},
	}
	compile := func(rel string) (*jsonschema.Schema, error) {
		s, err := c.Compile(SchemaBaseURI + rel)
		if err != nil {
			return nil, fmt.Errorf("compile %s: %w", rel, err)
		}
		return s, nil
	}
	if cd.envelope, err = compile("envelope.json"); err != nil {
		return nil, err
	}
	for _, m := range messageRegistry {
		cd.registry[m.Type] = m
		if cd.messages[m.Type], err = compile("messages/" + m.Type + ".json"); err != nil {
			return nil, err
		}
	}
	for _, h := range httpRegistry {
		cd.httpInfo[h.Name] = h
		if cd.http[h.Name], err = compile("http/" + h.Name + ".json"); err != nil {
			return nil, err
		}
	}
	for rel := range files {
		if kind, ok := strings.CutPrefix(rel, "manifests/"); ok {
			kind = strings.TrimSuffix(kind, ".json")
			if cd.manifests[kind], err = compile(rel); err != nil {
				return nil, err
			}
		}
	}
	return cd, nil
}

// ProtocolHash returns the hash of the bundle this codec was built from.
func (c *Codec) ProtocolHash() string { return c.hash }

func reject(code, detail, id string) *DecodeError {
	return &DecodeError{Code: code, Detail: detail, ID: id}
}

func schemaDetail(err error) string {
	var ve *jsonschema.ValidationError
	if errors.As(err, &ve) {
		var locs []string
		for _, c := range ve.Causes {
			locs = append(locs, "/"+strings.Join(c.InstanceLocation, "/"))
			if len(locs) == 3 {
				break
			}
		}
		if len(locs) == 0 {
			locs = append(locs, "/"+strings.Join(ve.InstanceLocation, "/"))
		}
		return "schema violation at " + strings.Join(locs, "; ")
	}
	return "schema violation"
}

// DecodeMessage runs the full pipeline for a WebSocket message received by receiver.
func (c *Codec) DecodeMessage(data []byte, receiver Side, opts DecodeOptions) (*Message, *DecodeError) {
	limit := opts.MaxBytes
	if limit <= 0 {
		limit = LimitMaxMessageBytes
	}
	toAgent := receiver == SideAgent
	early := func(code, detail string) (*Message, *DecodeError) {
		e := reject(code, detail, "")
		e.Pause = toAgent
		return nil, e
	}
	if len(data) > limit {
		return early(CodeMessageTooLarge, fmt.Sprintf("%d > %d", len(data), limit))
	}
	inst, err := ParseStrictJSON(data)
	if err != nil {
		return early(CodeMalformedJSON, err.Error())
	}
	if err := c.envelope.Validate(inst); err != nil {
		return early(CodeInvalidEnvelope, schemaDetail(err))
	}
	env, _ := inst.(map[string]any) // envelope.json guarantees an object
	typ, _ := env["type"].(string)
	id, _ := env["id"].(string)
	info, known := c.registry[typ]
	schema := c.messages[typ]
	typed := func(code, detail string, pause bool) (*Message, *DecodeError) {
		e := reject(code, detail, id)
		e.Type, e.Pause = typ, pause
		return nil, e
	}
	if !known || schema == nil {
		return typed(CodeUnknownType, typ, false)
	}
	if info.From != FromBoth && info.From == string(receiver) {
		return typed(CodeWrongDirection, typ+" is sent by "+info.From, false)
	}
	pause := toAgent && info.OnInvalid == "pause"
	if err := schema.Validate(inst); err != nil {
		return typed(CodeInvalidPayload, schemaDetail(err), pause)
	}
	payload := newPayload(typ)
	var raw rawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return typed(CodeInvalidPayload, "typed decode failed", pause)
	}
	if err := decodeStrict(raw.Payload, payload); err != nil {
		return typed(CodeInvalidPayload, "typed decode failed", pause)
	}
	if n := InlineTextBytes(payload); n > LimitMaxInlineTextBytes {
		return typed(CodeInvalidPayload, fmt.Sprintf("inline text %d > %d", n, LimitMaxInlineTextBytes), pause)
	}
	msg := &Message{V: 1, Type: typ, ID: id, Payload: payload}
	msg.TS, _ = env["ts"].(string)
	if corr, ok := env["corr"].(string); ok {
		msg.Corr = &corr
	}
	return msg, nil
}

func decodeStrict(data []byte, into any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	return dec.Decode(into)
}

// InlineTextBytes sums the UTF-8 bytes of inline buyer text (prompt, messages, prefix, output).
func InlineTextBytes(payload any) int {
	switch p := payload.(type) {
	case *JobOfferPayload:
		if p.Input == nil {
			return 0
		}
		n := 0
		for _, m := range p.Input.Messages {
			n += len(m.Content)
		}
		if p.Input.Prompt != nil {
			n += len(*p.Input.Prompt)
		}
		if p.Input.ContinuationPrefix != nil {
			n += len(*p.Input.ContinuationPrefix)
		}
		return n
	case *JobCompletePayload:
		if p.OutputText != nil {
			return len(*p.OutputText)
		}
	}
	return 0
}

func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

// EncodeMessage serializes msg and runs it through the receiver's decode pipeline, so an invalid
// message is never sent. Payload must be the generated payload struct (or a pointer to it) of msg.Type.
func (c *Codec) EncodeMessage(msg *Message, sender Side) ([]byte, error) {
	out, err := marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("encode %s: %w", msg.Type, err)
	}
	receiver := SideServer
	if sender == SideServer {
		receiver = SideAgent
	}
	if _, derr := c.DecodeMessage(out, receiver, DecodeOptions{}); derr != nil {
		return nil, fmt.Errorf("refusing to send an invalid %s message: %w", msg.Type, derr)
	}
	return out, nil
}

// DecodeHTTPBody validates an enrollment request or response body.
func (c *Codec) DecodeHTTPBody(name string, data []byte, opts DecodeOptions) (any, *DecodeError) {
	schema := c.http[name]
	if schema == nil {
		return nil, reject(CodeUnknownType, name, "")
	}
	limit := opts.MaxBytes
	if limit <= 0 {
		limit = LimitMaxHTTPBodyBytes
	}
	if len(data) > limit {
		return nil, reject(CodeMessageTooLarge, fmt.Sprintf("%d > %d", len(data), limit), "")
	}
	inst, err := ParseStrictJSON(data)
	if err != nil {
		return nil, reject(CodeMalformedJSON, err.Error(), "")
	}
	if err := schema.Validate(inst); err != nil {
		return nil, reject(CodeInvalidPayload, schemaDetail(err), "")
	}
	body := newHTTPBody(name)
	if err := decodeStrict(data, body); err != nil {
		return nil, reject(CodeInvalidPayload, "typed decode failed", "")
	}
	return body, nil
}

// EncodeHTTPBody serializes and validates an enrollment body.
func (c *Codec) EncodeHTTPBody(name string, body any) ([]byte, error) {
	out, err := marshal(body)
	if err != nil {
		return nil, fmt.Errorf("encode %s: %w", name, err)
	}
	if _, derr := c.DecodeHTTPBody(name, out, DecodeOptions{}); derr != nil {
		return nil, fmt.Errorf("refusing to send an invalid %s body: %w", name, derr)
	}
	return out, nil
}

// validManifest checks an already strict-parsed manifest against manifests/<kind>.json.
func (c *Codec) validManifest(kind string, inst any) bool {
	s := c.manifests[kind]
	return s != nil && s.Validate(inst) == nil
}

// Receivers returns who receives msgType ("both" types go either way).
func (c *Codec) Receivers(msgType string) []Side {
	switch c.registry[msgType].From {
	case FromAgent:
		return []Side{SideServer}
	case FromServer:
		return []Side{SideAgent}
	case FromBoth:
		return []Side{SideAgent, SideServer}
	}
	return nil
}
