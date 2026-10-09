package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestModelID(t *testing.T) {
	cases := map[string]string{
		"qwen2.5:0.5b":      "qwen2.5-0.5b",
		"Llama3.2:1B":       "llama3.2-1b",
		"fake-echo":         "fake-echo",
		"hf.co/x/y:Q4_K_M":  "hf.co-x-y-q4_k_m",
		"gemma3:270m-it-q8": "gemma3-270m-it-q8",
	}
	for in, want := range cases {
		got, err := ModelID(in)
		if err != nil || got != want {
			t.Errorf("ModelID(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", ":::", "한글"} {
		if _, err := ModelID(bad); err == nil {
			t.Errorf("ModelID(%q) should fail", bad)
		}
	}
}

func TestParseModelFlag(t *testing.T) {
	got, err := ParseModelFlag([]string{"qwen2.5:0.5b", "small=llama3.2:1b"})
	if err != nil {
		t.Fatal(err)
	}
	if got["qwen2.5-0.5b"] != "qwen2.5:0.5b" || got["small"] != "llama3.2:1b" || len(got) != 2 {
		t.Fatalf("got %v", got)
	}
	for _, bad := range [][]string{{"Bad Id=x"}, {"a=x", "a=y"}, {"a="}} {
		if _, err := ParseModelFlag(bad); err == nil {
			t.Errorf("ParseModelFlag(%v) should fail", bad)
		}
	}
}

func TestFakeIsDeterministicAndCancelable(t *testing.T) {
	f := &Fake{NodeName: "pc-1", ModelIDs: []string{"fake-echo"}}
	req := Request{Model: "fake-echo", Messages: []Message{{Role: "user", Content: "hello there"}}, MaxTokens: 16, Seed: 7}
	a, err := f.Generate(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := f.Generate(context.Background(), req)
	if a.Text != b.Text || !strings.HasPrefix(a.Text, "fake reply from pc-1 ") || a.TokensIn != 2 || a.TokensOut != 5 || a.FinishReason != "stop" {
		t.Fatalf("unexpected result %+v", a)
	}
	req.Seed = 8
	if c, _ := f.Generate(context.Background(), req); c.Text == a.Text {
		t.Fatal("a different seed should change the text")
	}
	req.MaxTokens = 2
	if c, _ := f.Generate(context.Background(), req); c.Text != "fake reply" || c.FinishReason != "length" {
		t.Fatalf("max tokens not applied: %+v", c)
	}
	slow := &Fake{Delay: time.Hour}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if _, err := slow.Generate(ctx, req); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("cancel was not immediate")
	}
}

func TestOllamaSuccess(t *testing.T) {
	var got ollamaRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/chat" {
			http.Error(w, "bad path", http.StatusBadRequest)
			return
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &got); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"model":"qwen2.5:0.5b","message":{"role":"assistant","content":"안녕하세요!"},"done":true,"done_reason":"length","prompt_eval_count":12,"eval_count":3,"load_duration":5000000,"prompt_eval_duration":2000000,"eval_duration":30000000}`))
	}))
	defer srv.Close()
	o := &Ollama{BaseURL: srv.URL, Names: map[string]string{"qwen2.5-0.5b": "qwen2.5:0.5b"}}
	res, err := o.Generate(context.Background(), Request{
		Model: "qwen2.5-0.5b", Messages: []Message{{Role: "user", Content: "hi"}},
		MaxTokens: 3, TemperatureMilli: 700, TopPMilli: 900, Stop: []string{"\n\n"}, Seed: 42,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := Result{Text: "안녕하세요!", FinishReason: "length", TokensIn: 12, TokensOut: 3, LoadMs: 5, PromptMs: 2, GenMs: 30}
	if res != want {
		t.Fatalf("result = %+v, want %+v", res, want)
	}
	if got.Model != "qwen2.5:0.5b" || got.Stream || got.Options.NumPredict != 3 || got.Options.Seed != 42 ||
		got.Options.Temperature != 0.7 || got.Options.TopP != 0.9 || len(got.Messages) != 1 || got.Options.Stop[0] != "\n\n" {
		t.Fatalf("request = %+v", got)
	}
}

func TestOllamaErrors(t *testing.T) {
	notFound := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"model not found"}`, http.StatusNotFound)
	}))
	defer notFound.Close()
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer broken.Close()
	garbage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not json"))
	}))
	defer garbage.Close()
	huge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"message":{"content":"` + strings.Repeat("a", maxOutputBytes+1) + `"}}`))
	}))
	defer huge.Close()
	// A port nobody listens on: Ollama not running.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closedURL := "http://" + l.Addr().String()
	_ = l.Close()

	names := map[string]string{"m": "m:1"}
	req := Request{Model: "m", Messages: []Message{{Role: "user", Content: "SECRET PROMPT"}}, MaxTokens: 4}
	cases := []struct {
		url, code string
		retryable bool
	}{
		{notFound.URL, "model_load_failed", true},
		{broken.URL, "runtime_crash", true},
		{garbage.URL, "runtime_crash", true},
		{huge.URL, "output_too_large", false},
		{closedURL, "runtime_start_failed", true},
	}
	for _, c := range cases {
		_, err := (&Ollama{BaseURL: c.url, Names: names}).Generate(context.Background(), req)
		e := AsError(err)
		if e.Code != c.code || e.Retryable != c.retryable {
			t.Errorf("%s: got %s/%v (%v), want %s/%v", c.url, e.Code, e.Retryable, err, c.code, c.retryable)
		}
		if strings.Contains(err.Error(), "SECRET PROMPT") {
			t.Errorf("%s: error leaks the prompt: %v", c.url, err)
		}
	}
	if _, err := (&Ollama{BaseURL: broken.URL, Names: names}).Generate(context.Background(), Request{Model: "other"}); AsError(err).Code != "model_load_failed" {
		t.Errorf("unknown model: %v", err)
	}
}

func TestOllamaCancel(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer srv.Close()
	defer close(release)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := (&Ollama{BaseURL: srv.URL, Names: map[string]string{"m": "m"}}).Generate(ctx, Request{Model: "m", MaxTokens: 1})
		done <- err
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Generate did not return after cancel")
	}
}
