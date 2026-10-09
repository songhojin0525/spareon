package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"binjari/agent/internal/version"
)

func TestRunVersion(t *testing.T) {
	for _, arg := range []string{"version", "--version", "-version"} {
		t.Run(arg, func(t *testing.T) {
			var out, errOut bytes.Buffer
			code := run([]string{arg}, &out, &errOut)
			if code != 0 {
				t.Fatalf("exit code = %d, want 0 (stderr: %s)", code, errOut.String())
			}
			want := version.String(programName) + "\n"
			if out.String() != want {
				t.Fatalf("stdout = %q, want %q", out.String(), want)
			}
			if errOut.Len() != 0 {
				t.Fatalf("unexpected stderr: %q", errOut.String())
			}
		})
	}
}

func TestRunWithoutArgsShowsUsageAndFails(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run(nil, &out, &errOut); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(errOut.String(), "usage:") {
		t.Fatalf("stderr should contain usage, got %q", errOut.String())
	}
}

func TestRunUnknownCommandFails(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := run([]string{"mine-bitcoin"}, &out, &errOut); code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if !strings.Contains(errOut.String(), `unknown command "mine-bitcoin"`) {
		t.Fatalf("stderr = %q", errOut.String())
	}
	if out.Len() != 0 {
		t.Fatalf("stdout should be empty, got %q", out.String())
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("broken pipe") }

func TestRunVersionReportsWriteFailure(t *testing.T) {
	if code := run([]string{"version"}, failingWriter{}, &bytes.Buffer{}); code != 1 {
		t.Fatalf("exit code = %d, want 1 when stdout cannot be written", code)
	}
}

func TestRunAgentValidatesFlags(t *testing.T) {
	cases := []struct {
		args []string
		want string
	}{
		{[]string{"run"}, "--secret"},
		{[]string{"run", "--secret", "s", "--server", "http://x"}, "ws://"},
		{[]string{"run", "--secret", "s", "--runtime", "gpu-magic"}, "fake or ollama"},
		{[]string{"run", "--secret", "s", "--runtime", "ollama"}, "--model"},
		{[]string{"run", "--secret", "s", "--model", "Bad Id=x"}, "model id"},
		{[]string{"run", "--secret", "s", "--name", "has space"}, "node name"},
	}
	for _, c := range cases {
		var out, errOut bytes.Buffer
		if code := run(c.args, &out, &errOut); code != 2 {
			t.Errorf("%v: exit code = %d, want 2", c.args, code)
		}
		if !strings.Contains(errOut.String(), c.want) {
			t.Errorf("%v: stderr = %q, want it to mention %q", c.args, errOut.String(), c.want)
		}
	}
}

func TestRunAgentReadsSecretFromEnv(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // stop immediately: only flag handling and identity derivation run
	var out, errOut bytes.Buffer
	env := func(k string) string {
		if k == secretEnv {
			return "env-secret-0123456789abcdefghij"
		}
		return ""
	}
	code := runWith(ctx, []string{"run", "--name", "pc-1", "--server", "ws://127.0.0.1:1/agent/v1/ws"}, &out, &errOut, env)
	if code != 0 {
		t.Fatalf("exit code = %d (stderr %q)", code, errOut.String())
	}
	if !strings.Contains(out.String(), "--always-available") {
		t.Fatalf("expected the not-available warning, got %q", out.String())
	}
}
