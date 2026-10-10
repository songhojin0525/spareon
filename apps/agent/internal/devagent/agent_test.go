package devagent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"spareon/agent/internal/devauth"
	"spareon/agent/internal/protocol"
	"spareon/agent/internal/runtime"
)

const secret = "test-agent-secret-0123456789abcdef"

// fakeServer is a minimal protocol server: real handshake (signature checked), then the test drives it.
type fakeServer struct {
	t      *testing.T
	codec  *protocol.Codec
	srv    *httptest.Server
	conns  chan *serverConn
	authOK bool // false: answer auth.fail(auth_invalid_signature)
}

type serverConn struct {
	t     *testing.T
	codec *protocol.Codec
	ws    *websocket.Conn
	recv  chan *protocol.Message
	mu    sync.Mutex
}

func newFakeServer(t *testing.T) *fakeServer {
	t.Helper()
	codec, err := protocol.NewCodec()
	if err != nil {
		t.Fatal(err)
	}
	fs := &fakeServer{t: t, codec: codec, conns: make(chan *serverConn, 8), authOK: true}
	fs.srv = httptest.NewServer(http.HandlerFunc(fs.handle))
	t.Cleanup(fs.srv.Close)
	return fs
}

func (fs *fakeServer) url() string {
	return "ws" + strings.TrimPrefix(fs.srv.URL, "http") + "/agent/v1/ws"
}

func (fs *fakeServer) handle(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	c := &serverConn{t: fs.t, codec: fs.codec, ws: ws, recv: make(chan *protocol.Message, 64)}
	ctx := r.Context()
	helloMsg := c.readOne(ctx)
	hello, ok := helloMsg.Payload.(*protocol.HelloPayload)
	if !ok {
		_ = ws.CloseNow()
		return
	}
	nonce := strings.Repeat("ab", 32)
	helloID := helloMsg.ID
	c.send("auth.challenge", &helloID, protocol.AuthChallengePayload{Nonce: nonce, ServerTime: protocol.FormatTimestamp(time.Now()), ExpiresInMs: 5000})
	prove := c.readOne(ctx)
	p, ok := prove.Payload.(*protocol.AuthProvePayload)
	if !ok {
		_ = ws.CloseNow()
		return
	}
	pub, _ := protocol.PublicKeyFromSeed(seedFor(hello.NodeID))
	msg, _ := protocol.AuthSigningBytes(nonce, hello.NodeID, hello.ProtocolHash)
	if !fs.authOK || !protocol.VerifyEd25519(pub, msg, p.Signature) {
		c.send("auth.fail", nil, protocol.AuthFailPayload{Code: protocol.ErrorCodeAuthInvalidSignature})
		_ = ws.Close(websocket.StatusPolicyViolation, "auth")
		return
	}
	corr := prove.ID
	c.send("auth.ok", &corr, protocol.AuthOkPayload{
		SessionID: mustID(), ResumeToken: strings.Repeat("cd", 32), ConfigVersion: 1,
		ServerTime: protocol.FormatTimestamp(time.Now()), HeartbeatIntervalMs: 5000,
		Control: protocol.AuthOkControl{Mode: protocol.AuthOkControlModeActive},
	})
	fs.conns <- c
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			close(c.recv)
			return
		}
		m, de := fs.codec.DecodeMessage(data, protocol.SideServer, protocol.DecodeOptions{})
		if de != nil {
			fs.t.Errorf("agent sent an invalid message: %v", de)
			continue
		}
		c.recv <- m
	}
}

// seedFor re-derives the device seed the way the server does (secret + node id only).
func seedFor(nodeID string) string { return devauth.NodeSeed(secret, nodeID) }

func mustID() string {
	id, err := protocol.NewUUIDv7(time.Now(), rand.Reader)
	if err != nil {
		panic(err)
	}
	return id
}

func (c *serverConn) readOne(ctx context.Context) *protocol.Message {
	_, data, err := c.ws.Read(ctx)
	if err != nil {
		return &protocol.Message{}
	}
	m, de := c.codec.DecodeMessage(data, protocol.SideServer, protocol.DecodeOptions{})
	if de != nil {
		c.t.Errorf("handshake decode: %v", de)
		return &protocol.Message{}
	}
	return m
}

func (c *serverConn) send(msgType string, corr *string, payload any) string {
	id := mustID()
	data, err := c.codec.EncodeMessage(protocol.NewMessage(msgType, id, protocol.FormatTimestamp(time.Now()), corr, payload), protocol.SideServer)
	if err != nil {
		c.t.Errorf("encode %s: %v", msgType, err)
		return id
	}
	c.sendRaw(data)
	return id
}

func (c *serverConn) sendRaw(data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = c.ws.Write(ctx, websocket.MessageText, data)
}

// expect waits for the next message of the given type (others are skipped and returned in skipped).
func (c *serverConn) expect(t *testing.T, msgType string, within time.Duration) *protocol.Message {
	t.Helper()
	deadline := time.After(within)
	for {
		select {
		case m, ok := <-c.recv:
			if !ok {
				t.Fatalf("connection closed while waiting for %s", msgType)
			}
			if m.Type == msgType {
				return m
			}
		case <-deadline:
			t.Fatalf("no %s within %s", msgType, within)
		}
	}
}

// expectOneOf waits for the next message of any of the given types (others are skipped).
func (c *serverConn) expectOneOf(t *testing.T, within time.Duration, types ...string) *protocol.Message {
	t.Helper()
	deadline := time.After(within)
	for {
		select {
		case m, ok := <-c.recv:
			if !ok {
				t.Fatalf("connection closed while waiting for one of %v", types)
			}
			for _, ty := range types {
				if m.Type == ty {
					return m
				}
			}
		case <-deadline:
			t.Fatalf("none of %v within %s", types, within)
		}
	}
}

// never fails if a message of the given type arrives within d.
func (c *serverConn) never(t *testing.T, msgType string, d time.Duration) {
	t.Helper()
	deadline := time.After(d)
	for {
		select {
		case m, ok := <-c.recv:
			if !ok {
				return
			}
			if m.Type == msgType {
				t.Fatalf("unexpected %s", msgType)
			}
		case <-deadline:
			return
		}
	}
}

func (c *serverConn) offer(model string) (offerID, attemptID string) {
	attemptID = mustID()
	offerID = c.send("job.offer", nil, protocol.JobOfferPayload{
		AttemptID: attemptID, JobKind: protocol.JobOfferJobKindChat,
		Model:  protocol.ModelRef{ID: model, Sha256: devauth.ModelSha256(model)},
		Params: protocol.JobOfferParams{MaxTokens: 16, TemperatureMilli: 700, TopPMilli: 1000, Seed: 3},
		Input:  &protocol.JobInput{Messages: []protocol.JobInputMessage{{Role: protocol.JobInputMessageRoleUser, Content: "hello"}}},
		Stream: false, TimeLimitMs: 60_000, LeaseTTLMs: 15_000,
	})
	return offerID, attemptID
}

type harness struct {
	server *fakeServer
	cancel context.CancelFunc
	done   chan error
}

func start(t *testing.T, cfg Config) (*harness, *serverConn) {
	t.Helper()
	fs := newFakeServer(t)
	cfg.ServerURL = fs.url()
	cfg.Secret = secret
	if cfg.Name == "" {
		cfg.Name = "test-pc"
	}
	if cfg.Runtime == nil {
		cfg.Runtime = &runtime.Fake{NodeName: cfg.Name, ModelIDs: []string{"fake-echo"}}
	}
	cfg.ReconnectMin = 50 * time.Millisecond
	cfg.ReconnectMax = 100 * time.Millisecond
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	h := &harness{server: fs, cancel: cancel, done: make(chan error, 1)}
	go func() { h.done <- a.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		<-h.done
	})
	select {
	case c := <-fs.conns:
		return h, c
	case <-time.After(5 * time.Second):
		t.Fatal("agent did not authenticate")
		return nil, nil
	}
}

func TestCompletesAJob(t *testing.T) {
	_, c := start(t, Config{AlwaysAvailable: true})
	caps := c.expect(t, "capabilities", time.Second).Payload.(*protocol.CapabilitiesPayload)
	if len(caps.CachedModels) != 1 || caps.CachedModels[0].ID != "fake-echo" || caps.Runtime.Name != "fake" {
		t.Fatalf("capabilities = %+v", caps)
	}
	st := c.expect(t, "status", time.Second).Payload.(*protocol.StatusPayload)
	if !st.Eligible || st.State != protocol.StatusStateEligible {
		t.Fatalf("status = %+v", st)
	}
	offerID, attemptID := c.offer("fake-echo")
	acc := c.expect(t, "job.accept", time.Second)
	if acc.Corr == nil || *acc.Corr != offerID || acc.Payload.(*protocol.JobAcceptPayload).AttemptID != attemptID {
		t.Fatalf("accept = %+v", acc)
	}
	done := c.expect(t, "job.complete", 2*time.Second).Payload.(*protocol.JobCompletePayload)
	sum := sha256.Sum256([]byte(*done.OutputText))
	if done.AttemptID != attemptID || done.OutputSha256 != hex.EncodeToString(sum[:]) || !strings.HasPrefix(*done.OutputText, "fake reply from test-pc") {
		t.Fatalf("complete = %+v", done)
	}
}

func TestServerCancelStopsTheJob(t *testing.T) {
	_, c := start(t, Config{AlwaysAvailable: true, Runtime: &runtime.Fake{ModelIDs: []string{"fake-echo"}, Delay: time.Hour}})
	_, attemptID := c.offer("fake-echo")
	c.expect(t, "job.accept", time.Second)
	cancelID := c.send("job.cancel", nil, protocol.JobCancelPayload{AttemptID: attemptID, Reason: protocol.JobCancelReasonDeadline})
	ack := c.expect(t, "ack", time.Second)
	if ack.Corr == nil || *ack.Corr != cancelID || ack.Payload.(*protocol.AckPayload).Result != protocol.AckResultOk {
		t.Fatalf("ack = %+v", ack)
	}
	c.never(t, "job.complete", 300*time.Millisecond)
}

func TestCtrlCReportsPreemptedAndExits(t *testing.T) {
	rt := &runtime.Fake{ModelIDs: []string{"fake-echo"}, Delay: time.Hour}
	h, c := start(t, Config{AlwaysAvailable: true, Runtime: rt})
	_, attemptID := c.offer("fake-echo")
	c.expect(t, "job.accept", time.Second)
	h.cancel()
	// Ctrl+C cancels the generation at once; that canceled result must never be reported as a node
	// failure (job.fail runtime_crash): the server is told the job was preempted for shutdown.
	var p *protocol.JobPreemptedPayload
	deadline := time.After(time.Second)
	for p == nil {
		select {
		case m, ok := <-c.recv:
			if !ok {
				t.Fatal("connection closed before job.preempted")
			}
			switch m.Type {
			case "job.fail":
				t.Fatalf("Ctrl+C was reported as a failure: %+v", m.Payload)
			case "job.preempted":
				p = m.Payload.(*protocol.JobPreemptedPayload)
			}
		case <-deadline:
			t.Fatal("no job.preempted within 1s")
		}
	}
	if p.AttemptID != attemptID || p.Reason != protocol.JobPreemptedReasonShutdown || p.LastSeq != -1 {
		t.Fatalf("preempted = %+v", p)
	}
	select {
	case err := <-h.done:
		if err != nil {
			t.Fatalf("Run returned %v", err)
		}
		h.done <- nil
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after cancel")
	}
	// The runtime was asked to free GPU memory before Run returned (Ollama keeps models loaded otherwise).
	if rt.Releases() < 1 {
		t.Fatal("Ctrl+C did not release the runtime's GPU memory")
	}
}

func TestInvalidKillPausesUntilResume(t *testing.T) {
	rt := &runtime.Fake{ModelIDs: []string{"fake-echo"}, Delay: time.Hour}
	_, c := start(t, Config{AlwaysAvailable: true, Runtime: rt})
	_, attemptID := c.offer("fake-echo")
	c.expect(t, "job.accept", time.Second)
	// A control.kill whose payload is invalid: the agent cannot tell what it meant, so it stops.
	c.sendRaw([]byte(fmt.Sprintf(`{"v":1,"type":"control.kill","id":"%s","ts":"%s","payload":{"scope":"everything","reason":"killSwitch"}}`, mustID(), protocol.FormatTimestamp(time.Now()))))
	p := c.expect(t, "job.preempted", time.Second).Payload.(*protocol.JobPreemptedPayload)
	if p.AttemptID != attemptID || p.Reason != protocol.JobPreemptedReasonPause {
		t.Fatalf("preempted = %+v", p)
	}
	st := c.expect(t, "status", time.Second).Payload.(*protocol.StatusPayload)
	if st.Eligible || st.State != protocol.StatusStatePaused {
		t.Fatalf("status = %+v", st)
	}
	waitReleases(t, rt, 1)
	_, _ = c.offer("fake-echo")
	if r := c.expect(t, "job.reject", time.Second).Payload.(*protocol.JobRejectPayload); r.Reason != protocol.JobRejectReasonPolicy {
		t.Fatalf("reject = %+v", r)
	}
	c.send("control.resume", nil, protocol.ControlResumePayload{Scope: protocol.ControlScopeNode, Reason: protocol.ControlReasonOperatorRequest})
	c.expect(t, "ack", time.Second)
	if st := c.expect(t, "status", time.Second).Payload.(*protocol.StatusPayload); !st.Eligible {
		t.Fatalf("status after resume = %+v", st)
	}
}

func TestWithoutAlwaysAvailableNeverWorks(t *testing.T) {
	_, c := start(t, Config{AlwaysAvailable: false})
	st := c.expect(t, "status", time.Second).Payload.(*protocol.StatusPayload)
	if st.Eligible || len(st.Presence.ReasonCodes) != 1 || st.Presence.ReasonCodes[0] != protocol.StatusPresenceReasonCodeHelperMissing {
		t.Fatalf("status = %+v", st)
	}
	_, _ = c.offer("fake-echo")
	if r := c.expect(t, "job.reject", time.Second).Payload.(*protocol.JobRejectPayload); r.Reason != protocol.JobRejectReasonNotIdle {
		t.Fatalf("reject = %+v", r)
	}
}

func TestRejectsUnknownModelAndSecondJob(t *testing.T) {
	_, c := start(t, Config{AlwaysAvailable: true, Runtime: &runtime.Fake{ModelIDs: []string{"fake-echo"}, Delay: time.Hour}})
	_, _ = c.offer("other-model")
	if r := c.expect(t, "job.reject", time.Second).Payload.(*protocol.JobRejectPayload); r.Reason != protocol.JobRejectReasonModelMissing {
		t.Fatalf("reject = %+v", r)
	}
	_, _ = c.offer("fake-echo")
	c.expect(t, "job.accept", time.Second)
	_, _ = c.offer("fake-echo")
	if r := c.expect(t, "job.reject", time.Second).Payload.(*protocol.JobRejectPayload); r.Reason != protocol.JobRejectReasonBusy {
		t.Fatalf("reject = %+v", r)
	}
}

func TestServerSilenceStopsWorkAndReconnects(t *testing.T) {
	h, c := start(t, Config{
		AlwaysAvailable:    true,
		Runtime:            &runtime.Fake{ModelIDs: []string{"fake-echo"}, Delay: time.Hour},
		ServerSilenceLimit: 400 * time.Millisecond,
		HeartbeatInterval:  time.Hour,
	})
	_, _ = c.offer("fake-echo")
	c.expect(t, "job.accept", time.Second)
	// The server says nothing more: the agent must stop on its own and reconnect.
	select {
	case c2 := <-h.server.conns:
		c2.expect(t, "status", time.Second)
	case <-time.After(3 * time.Second):
		t.Fatal("agent did not reconnect after server silence")
	}
	c.never(t, "job.complete", 100*time.Millisecond)
}

func TestAuthFailureRetries(t *testing.T) {
	fs := newFakeServer(t)
	fs.authOK = false
	var lines []string
	var mu sync.Mutex
	a, err := New(Config{
		ServerURL: fs.url(), Secret: secret, Name: "pc", Runtime: &runtime.Fake{ModelIDs: []string{"fake-echo"}},
		ReconnectMin: 20 * time.Millisecond, ReconnectMax: 40 * time.Millisecond,
		Logf: func(f string, args ...any) { mu.Lock(); lines = append(lines, fmt.Sprintf(f, args...)); mu.Unlock() },
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	if err := a.Run(ctx); err != nil {
		t.Fatalf("Run = %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	failures := 0
	for _, l := range lines {
		if strings.Contains(l, "auth_invalid_signature") {
			failures++
		}
	}
	if failures < 2 {
		t.Fatalf("expected repeated auth failures, got %v", lines)
	}
}

func TestNewRejectsBadInput(t *testing.T) {
	if _, err := New(Config{Secret: secret, Name: "bad name"}); err == nil {
		t.Fatal("missing runtime should fail")
	}
	if _, err := New(Config{Secret: "", Name: "pc", Runtime: &runtime.Fake{}}); !errors.Is(err, devauth.ErrInvalid) {
		t.Fatalf("empty secret: %v", err)
	}
}

// waitReleases waits until the runtime was released exactly n times (release runs in the background).
func waitReleases(t *testing.T, rt *runtime.Fake, n int64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for rt.Releases() < n && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := rt.Releases(); got != n {
		t.Fatalf("runtime released %d times, want %d", got, n)
	}
}

func TestPauseAnswersWhileTheRuntimeReleases(t *testing.T) {
	// The runtime takes 1.5s to unload. The agent must still ack and report status at once (a blocked
	// main loop would go silent towards the server), and take no work until the unload is over.
	rt := &runtime.Fake{ModelIDs: []string{"fake-echo"}, Delay: time.Hour, ReleaseDelay: 1500 * time.Millisecond}
	_, c := start(t, Config{AlwaysAvailable: true, Runtime: rt, ReleaseTimeout: 3 * time.Second})
	_, attemptID := c.offer("fake-echo")
	c.expect(t, "job.accept", time.Second)
	pauseID := c.send("control.pause", nil, protocol.ControlPausePayload{Scope: protocol.ControlScopeNode, Reason: protocol.ControlReasonOperatorRequest})
	if p := c.expect(t, "job.preempted", 300*time.Millisecond).Payload.(*protocol.JobPreemptedPayload); p.AttemptID != attemptID || p.Reason != protocol.JobPreemptedReasonPause {
		t.Fatalf("preempted = %+v", p)
	}
	if ack := c.expect(t, "ack", 300*time.Millisecond); ack.Corr == nil || *ack.Corr != pauseID {
		t.Fatalf("ack = %+v", ack)
	}
	if st := c.expect(t, "status", 300*time.Millisecond).Payload.(*protocol.StatusPayload); st.Eligible {
		t.Fatalf("status = %+v", st)
	}
	// A quick resume does not let a job start while GPU memory is still being freed.
	c.send("control.resume", nil, protocol.ControlResumePayload{Scope: protocol.ControlScopeNode, Reason: protocol.ControlReasonOperatorRequest})
	c.expect(t, "ack", 300*time.Millisecond)
	_, _ = c.offer("fake-echo")
	if r := c.expect(t, "job.reject", 300*time.Millisecond).Payload.(*protocol.JobRejectPayload); r.Reason != protocol.JobRejectReasonBusy {
		t.Fatalf("reject during release = %+v", r)
	}
	// Releases counts calls as they start; wait until the slow unload has actually returned.
	deadline := time.Now().Add(3 * time.Second)
	for rt.ReleasesDone() < 1 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if rt.Releases() != 1 || rt.ReleasesDone() != 1 {
		t.Fatalf("releases started %d, done %d; want 1 and 1", rt.Releases(), rt.ReleasesDone())
	}
	// The agent clears its releasing flag right after Release returns. An offer that lands in that
	// instant is still (correctly) busy, so offer again until one is accepted, within a short bound.
	acceptBy := time.Now().Add(time.Second)
	for {
		_, _ = c.offer("fake-echo")
		m := c.expectOneOf(t, time.Second, "job.accept", "job.reject")
		if m.Type == "job.accept" {
			break
		}
		if m.Type != "job.reject" || m.Payload.(*protocol.JobRejectPayload).Reason != protocol.JobRejectReasonBusy || time.Now().After(acceptBy) {
			t.Fatalf("after the release, offer got %s %+v", m.Type, m.Payload)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestConnectionLossStopsWorkAndReleases(t *testing.T) {
	rt := &runtime.Fake{ModelIDs: []string{"fake-echo"}, Delay: time.Hour}
	h, c := start(t, Config{AlwaysAvailable: true, Runtime: rt})
	_, _ = c.offer("fake-echo")
	c.expect(t, "job.accept", time.Second)
	// The server goes away without a word (crash, restart): the agent cannot receive a kill switch
	// any more, so it stops the job and frees GPU memory before reconnecting.
	_ = c.ws.CloseNow()
	select {
	case c2 := <-h.server.conns:
		c2.expect(t, "status", time.Second)
	case <-time.After(3 * time.Second):
		t.Fatal("agent did not reconnect")
	}
	if rt.Releases() < 1 {
		t.Fatal("connection loss did not release the runtime's GPU memory")
	}
}
