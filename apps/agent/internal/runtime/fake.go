package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync/atomic"
	"time"
)

// Fake answers deterministically without a model: the same input and seed give the same text.
type Fake struct {
	// NodeName appears in the answer so a demo shows which PC answered.
	NodeName string
	ModelIDs []string
	// Delay simulates generation time (canceled immediately by ctx).
	Delay time.Duration
	// ReleaseDelay simulates a slow unload (bounded by ctx).
	ReleaseDelay time.Duration

	releases     atomic.Int64
	releasesDone atomic.Int64
}

// Release implements Runtime: the fake holds no GPU memory; it only counts calls (for tests).
func (f *Fake) Release(ctx context.Context) error {
	f.releases.Add(1)
	defer f.releasesDone.Add(1)
	if f.ReleaseDelay > 0 {
		t := time.NewTimer(f.ReleaseDelay)
		defer t.Stop()
		select {
		case <-ctx.Done():
			return fmt.Errorf("fake runtime release: %w", ctx.Err())
		case <-t.C:
		}
	}
	return nil
}

// Releases is how many times Release was called.
func (f *Fake) Releases() int64 { return f.releases.Load() }

// ReleasesDone is how many Release calls have returned (with ReleaseDelay, later than Releases).
func (f *Fake) ReleasesDone() int64 { return f.releasesDone.Load() }

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
