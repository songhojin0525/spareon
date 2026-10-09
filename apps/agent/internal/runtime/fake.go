package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Fake answers deterministically without a model: the same input and seed give the same text.
type Fake struct {
	// NodeName appears in the answer so a demo shows which PC answered.
	NodeName string
	ModelIDs []string
	// Delay simulates generation time (canceled immediately by ctx).
	Delay time.Duration
}

// Name implements Runtime.
func (f *Fake) Name() string { return "fake" }

// Version implements Runtime.
func (f *Fake) Version() string { return "1.0.0" }

// Models implements Runtime.
func (f *Fake) Models() []string {
	out := append([]string(nil), f.ModelIDs...)
	sort.Strings(out)
	return out
}

// Generate implements Runtime.
func (f *Fake) Generate(ctx context.Context, req Request) (Result, error) {
	start := time.Now()
	if f.Delay > 0 {
		t := time.NewTimer(f.Delay)
		select {
		case <-ctx.Done():
			t.Stop()
			return Result{}, fmt.Errorf("fake runtime: %w", ctx.Err())
		case <-t.C:
		}
	}
	h := sha256.New()
	h.Write([]byte(req.Model))
	in := int64(0)
	for _, m := range req.Messages {
		h.Write([]byte{0})
		h.Write([]byte(m.Role))
		h.Write([]byte{0})
		h.Write([]byte(m.Content))
		in += int64(len(strings.Fields(m.Content)))
	}
	fmt.Fprintf(h, "\x00%d", req.Seed)
	words := []string{"fake", "reply", "from", f.NodeName, hex.EncodeToString(h.Sum(nil))[:12]}
	finish := "stop"
	if int64(len(words)) > req.MaxTokens {
		words = words[:req.MaxTokens]
		finish = "length"
	}
	return Result{
		Text:         strings.Join(words, " "),
		FinishReason: finish,
		TokensIn:     in,
		TokensOut:    int64(len(words)),
		GenMs:        time.Since(start).Milliseconds(),
	}, nil
}
