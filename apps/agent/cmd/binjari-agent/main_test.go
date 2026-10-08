package main

import (
	"bytes"
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
