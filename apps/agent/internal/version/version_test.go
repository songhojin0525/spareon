package version

import (
	"runtime"
	"strings"
	"testing"
)

func TestStringIncludesBuildMetadata(t *testing.T) {
	oldV, oldC := Version, Commit
	t.Cleanup(func() { Version, Commit = oldV, oldC })
	Version, Commit = "1.2.3", "abc123"

	got := String("binjari-agent")
	want := "binjari-agent 1.2.3 (commit abc123, " + runtime.Version() + " " + runtime.GOOS + "/" + runtime.GOARCH + ")"
	if got != want {
		t.Fatalf("String() = %q, want %q", got, want)
	}
}

func TestDefaultsMarkDevelopmentBuild(t *testing.T) {
	if !strings.HasSuffix(Version, "-dev") {
		t.Fatalf("default Version %q should be a -dev version so release builds must set it explicitly", Version)
	}
}
