// Command binjari-agent runs on PC-bang PCs and executes inference only while no customer is present.
//
// SKELETON(S17): only the `version` command exists; the agent core arrives in S17.
package main

import (
	"fmt"
	"io"
	"os"

	"binjari/agent/internal/version"
)

const programName = "binjari-agent"

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run executes one CLI invocation and returns the process exit code.
func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		usage(stderr)
		return 2
	}
	switch args[0] {
	case "version", "--version", "-version":
		if _, err := fmt.Fprintln(stdout, version.String(programName)); err != nil {
			return 1
		}
		return 0
	case "help", "--help", "-h":
		usage(stdout)
		return 0
	default:
		_, _ = fmt.Fprintf(stderr, "%s: unknown command %q\n", programName, args[0])
		usage(stderr)
		return 2
	}
}

func usage(w io.Writer) {
	_, _ = fmt.Fprintf(w, "usage: %s <command>\n\ncommands:\n  version   print version and build information\n  help      show this help\n", programName)
}
