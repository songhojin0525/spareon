package runtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// DefaultOllamaURL is the local Ollama server.
const DefaultOllamaURL = "http://127.0.0.1:11434"

// maxOllamaResponseBytes bounds what we read from Ollama (the output itself must fit the protocol's
// 256 KiB inline limit; JSON overhead and escapes are allowed for).
const maxOllamaResponseBytes = 4 << 20

// maxOutputBytes is the protocol's inline output limit (limits.json maxInlineTextBytes).
const maxOutputBytes = 262144

// Ollama calls a local Ollama server's chat API without streaming (POST /api/chat, stream:false).
// Development and the S04 demo only: Ollama is not version-pinned or signature-checked (S19).
type Ollama struct {
	BaseURL string
	// Names maps protocol model ids to Ollama model names (e.g. qwen2.5-0.5b → qwen2.5:0.5b).
	Names  map[string]string
	Client *http.Client
}

// Name implements Runtime.
func (o *Ollama) Name() string { return "ollama" }

// Version implements Runtime. SKELETON(S19): Ollama's own version is not queried or pinned.
func (o *Ollama) Version() string { return "unknown" }

// Models implements Runtime.
func (o *Ollama) Models() []string {
	out := make([]string, 0, len(o.Names))
	for id := range o.Names {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

type ollamaMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ollamaOptions struct {
	Temperature float64  `json:"temperature"`
	TopP        float64  `json:"top_p"`
	Seed        int64    `json:"seed"`
	NumPredict  int64    `json:"num_predict"`
	Stop        []string `json:"stop,omitempty"`
}

type ollamaRequest struct {
	Model    string          `json:"model"`
	Messages []ollamaMessage `json:"messages"`
	Stream   bool            `json:"stream"`
	Options  ollamaOptions   `json:"options"`
}

// Release implements Runtime: ask Ollama to unload, now (keep_alive 0), every configured model it has
// loaded. Without this Ollama keeps a model in GPU memory for 5 minutes after the last request. Only
// models listed by /api/ps are unloaded: on some Ollama versions an unload request for a model that is
// not loaded loads it first, which would take GPU memory at the very moment the customer arrives.
func (o *Ollama) Release(ctx context.Context) error {
	loaded, err := o.loaded(ctx)
	if err != nil {
		return fmt.Errorf("ollama release: %w", err)
	}
	var errs []error
	for _, id := range o.Models() {
		name := o.Names[id]
		if !loaded[ollamaTagged(name)] {
			continue
		}
		raw, err := json.Marshal(struct {
			Model     string `json:"model"`
			KeepAlive int    `json:"keep_alive"`
		}{Model: name, KeepAlive: 0})
		if err != nil {
			errs = append(errs, fmt.Errorf("encode unload %s: %w", id, err))
			continue
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.BaseURL+"/api/generate", bytes.NewReader(raw))
		if err != nil {
			errs = append(errs, fmt.Errorf("unload %s: %w", id, err))
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := o.client().Do(req)
		if err != nil {
			errs = append(errs, fmt.Errorf("unload %s: %w", id, err))
			continue
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		_ = resp.Body.Close()
		// 404: the model is not there, so it holds no memory either.
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
			errs = append(errs, fmt.Errorf("unload %s: ollama answered HTTP %d", id, resp.StatusCode))
		}
	}
	if err := errors.Join(errs...); err != nil {
		return fmt.Errorf("ollama release: %w", err)
	}
	return nil
}

// loaded returns the names (always with a tag) of the models Ollama has in memory (GET /api/ps).
func (o *Ollama) loaded(ctx context.Context) (map[string]bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, o.BaseURL+"/api/ps", nil)
	if err != nil {
		return nil, fmt.Errorf("list loaded models: %w", err)
	}
	resp, err := o.client().Do(req)
	if err != nil {
		return nil, fmt.Errorf("list loaded models: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("list loaded models: %w", err)
	}
	if resp.StatusCode == http.StatusNotFound {
		// Without /api/ps the agent cannot tell which models hold GPU memory, and unloading blindly
		// could load one: nothing is unloaded and Ollama frees the memory on its own after 5 minutes.
		return nil, errors.New("list loaded models: this Ollama has no /api/ps (too old) — update Ollama so the agent can free GPU memory at once")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("list loaded models: ollama answered HTTP %d", resp.StatusCode)
	}
	var ps struct {
		Models []struct {
			Name  string `json:"name"`
			Model string `json:"model"`
		} `json:"models"`
	}
	if err := json.Unmarshal(data, &ps); err != nil {
		return nil, errors.New("list loaded models: ollama response is not valid JSON")
	}
	out := map[string]bool{}
	for _, m := range ps.Models {
		out[ollamaTagged(m.Name)] = true
		out[ollamaTagged(m.Model)] = true
	}
	return out, nil
}

// ollamaTagged adds Ollama's implicit ":latest" tag to a model name without one.
func ollamaTagged(name string) string {
	if name == "" || strings.Contains(name, ":") {
		return name
	}
	return name + ":latest"
}

type ollamaResponse struct {
	Message struct {
		Content string `json:"content"`
	} `json:"message"`
	DoneReason         string `json:"done_reason"`
	PromptEvalCount    int64  `json:"prompt_eval_count"`
	EvalCount          int64  `json:"eval_count"`
	LoadDuration       int64  `json:"load_duration"`
	PromptEvalDuration int64  `json:"prompt_eval_duration"`
	EvalDuration       int64  `json:"eval_duration"`
}

func (o *Ollama) client() *http.Client {
	if o.Client != nil {
		return o.Client
	}
	return http.DefaultClient
}

// Generate implements Runtime.
func (o *Ollama) Generate(ctx context.Context, req Request) (Result, error) {
	name, ok := o.Names[req.Model]
	if !ok {
		return Result{}, &Error{Code: "model_load_failed", Retryable: true, Err: fmt.Errorf("model %q is not configured", req.Model)}
	}
	body := ollamaRequest{Model: name, Stream: false, Options: ollamaOptions{
		Temperature: float64(req.TemperatureMilli) / 1000,
		TopP:        float64(req.TopPMilli) / 1000,
		Seed:        req.Seed,
		NumPredict:  req.MaxTokens,
		Stop:        req.Stop,
	}}
	if req.Greedy {
		body.Options.Temperature = 0
	}
	for _, m := range req.Messages {
		body.Messages = append(body.Messages, ollamaMessage(m))
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return Result{}, &Error{Code: "runtime_crash", Retryable: true, Err: fmt.Errorf("encode request: %w", err)}
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, o.BaseURL+"/api/chat", bytes.NewReader(raw))
	if err != nil {
		return Result{}, &Error{Code: "runtime_start_failed", Retryable: true, Err: fmt.Errorf("build request: %w", err)}
	}
	httpReq.Header.Set("Content-Type", "application/json")
	start := time.Now()
	resp, err := o.client().Do(httpReq)
	if err != nil {
		if ctx.Err() != nil {
			return Result{}, fmt.Errorf("ollama: %w", ctx.Err())
		}
		// Usually "connection refused": Ollama is not running. Never include the request body.
		return Result{}, &Error{Code: "runtime_start_failed", Retryable: true, Err: fmt.Errorf("ollama not reachable at %s: %w", o.BaseURL, err)}
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxOllamaResponseBytes+1))
	if err != nil {
		if ctx.Err() != nil {
			return Result{}, fmt.Errorf("ollama: %w", ctx.Err())
		}
		return Result{}, &Error{Code: "runtime_crash", Retryable: true, Err: fmt.Errorf("read response: %w", err)}
	}
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return Result{}, &Error{Code: "model_load_failed", Retryable: true, Err: fmt.Errorf("ollama has no model %q (run: ollama pull %s)", name, name)}
	case resp.StatusCode != http.StatusOK:
		return Result{}, &Error{Code: "runtime_crash", Retryable: true, Err: fmt.Errorf("ollama answered HTTP %d", resp.StatusCode)}
	case len(data) > maxOllamaResponseBytes:
		return Result{}, &Error{Code: "output_too_large", Retryable: false, Err: errors.New("ollama response too large")}
	}
	var out ollamaResponse
	if err := json.Unmarshal(data, &out); err != nil {
		return Result{}, &Error{Code: "runtime_crash", Retryable: true, Err: errors.New("ollama response is not valid JSON")}
	}
	if len(out.Message.Content) > maxOutputBytes {
		return Result{}, &Error{Code: "output_too_large", Retryable: false, Err: fmt.Errorf("output %d bytes > %d", len(out.Message.Content), maxOutputBytes)}
	}
	finish := "stop"
	if out.DoneReason == "length" {
		finish = "length"
	}
	ms := func(ns int64) int64 { return clamp(ns/int64(time.Millisecond), 0, 86_400_000) }
	gen := ms(out.EvalDuration)
	if gen == 0 {
		gen = clamp(time.Since(start).Milliseconds(), 0, 86_400_000)
	}
	return Result{
		Text:         out.Message.Content,
		FinishReason: finish,
		TokensIn:     clamp(out.PromptEvalCount, 0, 10_000_000),
		TokensOut:    clamp(out.EvalCount, 0, 1_000_000),
		LoadMs:       ms(out.LoadDuration),
		PromptMs:     ms(out.PromptEvalDuration),
		GenMs:        gen,
	}, nil
}

func clamp(v, lo, hi int64) int64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
