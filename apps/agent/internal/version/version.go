// Package version holds build metadata injected at link time.
//
// Release builds set these with:
//
//	go build -ldflags "-X binjari/agent/internal/version.Version=1.2.3 -X binjari/agent/internal/version.Commit=abc123" ./cmd/binjari-agent
package version

import (
	"fmt"
	"runtime"
)

// Version is the semantic version of the agent. Overridden at link time for releases.
var Version = "0.0.0-dev"

// Commit is the source revision the binary was built from. Overridden at link time for releases.
var Commit = "unknown"

// String returns a single human-readable line describing this build.
func String(program string) string {
	return fmt.Sprintf("%s %s (commit %s, %s %s/%s)", program, Version, Commit, runtime.Version(), runtime.GOOS, runtime.GOARCH)
}
