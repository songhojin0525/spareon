// Command spareon-agent runs on PC-bang PCs and executes inference only while no customer is present.
//
// SKELETON(S17): `run` is the S04 walking-skeleton console mode (internal/devagent); the agent core,
// Windows service and session helper arrive in S17-S18.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"regexp"
	"strings"
	"syscall"
	"time"

	"spareon/agent/internal/devagent"
	"spareon/agent/internal/devauth"
	"spareon/agent/internal/runtime"
	"spareon/agent/internal/version"
)

const programName = "spareon-agent"

// secretEnv lets the secret stay out of the process list and shell history.
const secretEnv = "SPAREON_DEV_AGENT_SECRET"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := runWith(ctx, os.Args[1:], os.Stdout, os.Stderr, os.Getenv)
	stop()
	os.Exit(code)
}

// run executes one CLI invocation without signal handling (tests).
func run(args []string, stdout, stderr io.Writer) int {
	return runWith(context.Background(), args, stdout, stderr, func(string) string { return "" })
}

func runWith(ctx context.Context, args []string, stdout, stderr io.Writer, getenv func(string) string) int {
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
	case "run":
		return runAgent(ctx, args[1:], stdout, stderr, getenv)
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
	_, _ = fmt.Fprintf(w, `usage: %s <command>

commands:
  run       connect to a development server and run jobs (S04 walking skeleton, console mode)
  version   print version and build information
  help      show this help

run flags (see docs/DEMO_0.md):
  --server URL          ws://HOST:PORT/agent/v1/ws (default ws://127.0.0.1:8080/agent/v1/ws)
  --secret S            development agent secret (or env %s)
  --name NAME           this PC's name, 1-64 of A-Z a-z 0-9 . _ - (default: computer name)
  --runtime fake|ollama (default fake)
  --model M             model to serve; repeat for more. "qwen2.5:0.5b" or "id=ollama-name"
  --ollama-url URL      (default %s)
  --fake-delay D        simulated generation time for the fake runtime (e.g. 500ms)
  --always-available    no customer detection yet: required to receive jobs
`, programName, secretEnv, runtime.DefaultOllamaURL)
}

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

var reNameUnsafe = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func defaultName() string {
	h, err := os.Hostname()
	if err != nil {
		return "pc"
	}
	n := reNameUnsafe.ReplaceAllString(h, "-")
	if len(n) > 64 {
		n = n[:64]
	}
	if !devauth.ValidName(n) {
		return "pc"
	}
	return n
}

func runAgent(ctx context.Context, args []string, stdout, stderr io.Writer, getenv func(string) string) int {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stderr)
	server := fs.String("server", "ws://127.0.0.1:8080/agent/v1/ws", "")
	secret := fs.String("secret", "", "")
	name := fs.String("name", defaultName(), "")
	rtName := fs.String("runtime", "fake", "")
	ollamaURL := fs.String("ollama-url", runtime.DefaultOllamaURL, "")
	fakeDelay := fs.Duration("fake-delay", 0, "")
	always := fs.Bool("always-available", false, "")
	var models multiFlag
	fs.Var(&models, "model", "")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	fail := func(format string, a ...any) int {
		_, _ = fmt.Fprintf(stderr, "%s run: %s\n", programName, fmt.Sprintf(format, a...))
		return 2
	}
	if *secret == "" {
		*secret = getenv(secretEnv)
	}
	if *secret == "" {
		return fail("--secret (or %s) is required: copy it from the server's console", secretEnv)
	}
	if !strings.HasPrefix(*server, "ws://") && !strings.HasPrefix(*server, "wss://") {
		return fail("--server must start with ws:// or wss://")
	}
	var rt runtime.Runtime
	switch *rtName {
	case "fake":
		ids := []string(models)
		if len(ids) == 0 {
			ids = []string{"fake-echo"}
		}
		parsed, err := runtime.ParseModelFlag(ids)
		if err != nil {
			return fail("%v", err)
		}
		f := &runtime.Fake{NodeName: *name, Delay: *fakeDelay}
		for id := range parsed {
			f.ModelIDs = append(f.ModelIDs, id)
		}
		rt = f
	case "ollama":
		if len(models) == 0 {
			return fail("--runtime ollama needs at least one --model (e.g. --model qwen2.5:0.5b)")
		}
		parsed, err := runtime.ParseModelFlag(models)
		if err != nil {
			return fail("%v", err)
		}
		rt = &runtime.Ollama{BaseURL: strings.TrimRight(*ollamaURL, "/"), Names: parsed}
	default:
		return fail("--runtime must be fake or ollama")
	}
	logf := func(format string, a ...any) {
		_, _ = fmt.Fprintf(stdout, "%s %s\n", time.Now().Format("15:04:05"), fmt.Sprintf(format, a...))
	}
	agent, err := devagent.New(devagent.Config{
		ServerURL:       *server,
		Secret:          *secret,
		Name:            *name,
		Runtime:         rt,
		AlwaysAvailable: *always,
		AgentVersion:    version.Version,
		Logf:            logf,
	})
	if err != nil {
		return fail("%v", err)
	}
	logf("%s 시작: 이름 %s → 대시보드 표시 %s, 노드 ID %s", programName, *name, agent.Label(), agent.NodeID())
	logf("런타임 %s, 모델 %s, 서버 %s", rt.Name(), strings.Join(rt.Models(), ", "), *server)
	if !*always {
		logf("주의: --always-available 없이 실행 중입니다. 손님 감지 기능이 아직 없으므로 작업을 받지 않습니다.")
	}
	if err := agent.Run(ctx); err != nil {
		logf("오류: %v", err)
		return 1
	}
	logf("종료합니다")
	return 0
}
