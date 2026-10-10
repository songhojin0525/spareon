// Package devagent is the walking-skeleton agent loop (S04): connect, authenticate with the development
// identity, report capabilities and status, accept one job at a time, run it on a runtime adapter and
// report the result. It stops work immediately on Ctrl+C, server cancel/pause/kill, an invalid stop
// command (fail-safe pause) and server silence.
//
// SKELETON(S17): the agent core (state machine, policy, eligibility lease, deadman, resume) replaces
// this package. SKELETON(S18): customer detection — until then only `--always-available` makes a node
// eligible; without it the node reports itself ineligible and never takes work (absolute rule 1).
package devagent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	goruntime "runtime"
	"sync"
	"time"

	"github.com/coder/websocket"

	"binjari/agent/internal/devauth"
	"binjari/agent/internal/protocol"
	"binjari/agent/internal/runtime"
)

// Config configures an agent. Zero durations take the protocol defaults.
type Config struct {
	ServerURL       string
	Secret          string
	Name            string
	Runtime         runtime.Runtime
	AlwaysAvailable bool
	AgentVersion    string
	// Logf prints one console line (never buyer content).
	Logf func(format string, args ...any)

	HeartbeatInterval  time.Duration // T9, default 5s
	ServerSilenceLimit time.Duration // T13, default 10s
	ProgressInterval   time.Duration // default 5s (< lease 15s)
	HandshakeTimeout   time.Duration // T14, default 5s
	ReconnectMin       time.Duration // default 1s
	ReconnectMax       time.Duration // default 10s
	ShutdownGrace      time.Duration // time to report job.preempted on exit, default 1s
	ReleaseTimeout     time.Duration // time to let the runtime free GPU memory, default 5s
}

func (c *Config) defaults() {
	set := func(d *time.Duration, v time.Duration) {
		if *d <= 0 {
			*d = v
		}
	}
	set(&c.HeartbeatInterval, 5*time.Second)
	set(&c.ServerSilenceLimit, 10*time.Second)
	set(&c.ProgressInterval, 5*time.Second)
	set(&c.HandshakeTimeout, 5*time.Second)
	set(&c.ReconnectMin, time.Second)
	set(&c.ReconnectMax, 10*time.Second)
	set(&c.ShutdownGrace, time.Second)
	set(&c.ReleaseTimeout, 5*time.Second)
	if c.Logf == nil {
		c.Logf = func(string, ...any) {}
	}
	if c.AgentVersion == "" {
		c.AgentVersion = "0.0.0-dev"
	}
}

// Agent is one development agent.
type Agent struct {
	cfg     Config
	id      devauth.Identity
	codec   *protocol.Codec
	started time.Time
	caps    protocol.CapabilitiesPayload
	digest  string
	models  map[string]bool
}

// AuthError is an auth.fail from the server.
type AuthError struct{ Code string }

func (e *AuthError) Error() string { return "auth.fail: " + e.Code }

// ErrServerSilent means no message arrived from the server within ServerSilenceLimit (T13).
var ErrServerSilent = errors.New("server silent")

// New validates the configuration and derives the node identity.
func New(cfg Config) (*Agent, error) {
	cfg.defaults()
	if cfg.Runtime == nil {
		return nil, errors.New("devagent: runtime is required")
	}
	id, err := devauth.Derive(cfg.Secret, cfg.Name)
	if err != nil {
		return nil, fmt.Errorf("devagent: %w", err)
	}
	codec, err := protocol.NewCodec()
	if err != nil {
		return nil, fmt.Errorf("devagent: %w", err)
	}
	a := &Agent{cfg: cfg, id: id, codec: codec, started: time.Now(), models: map[string]bool{}}
	var cached []protocol.ModelRef
	for _, m := range cfg.Runtime.Models() {
		a.models[m] = true
		cached = append(cached, protocol.ModelRef{ID: m, Sha256: devauth.ModelSha256(m)})
	}
	threads := int64(goruntime.NumCPU())
	a.caps = protocol.CapabilitiesPayload{
		// SKELETON(S19): GPU inventory (nvidia-smi / DXGI per ADR 0019) is not read yet.
		GPUs: nil,
		CPU:  protocol.CapabilitiesCPU{Model: protocol.SanitizeDisplayText(goruntime.GOARCH + " cpu"), Cores: threads, Threads: threads},
		// SKELETON(S17): RAM and cache disk sizes are not measured yet (reported as 0).
		RAMMb:           0,
		CacheDiskFreeMb: 0,
		Runtime:         protocol.RuntimeInfo{Name: protocol.RuntimeName(cfg.Runtime.Name()), Version: protocol.SanitizeToken(cfg.Runtime.Version())},
		CachedModels:    cached,
		OSBuild:         protocol.SanitizeToken(goruntime.GOOS + "-" + goruntime.GOARCH),
	}
	if a.digest, err = protocol.CapabilitiesDigest(&a.caps); err != nil {
		return nil, fmt.Errorf("devagent: %w", err)
	}
	return a, nil
}

// NodeID is the derived node id.
func (a *Agent) NodeID() string { return a.id.NodeID }

// Label is the name the server dashboard shows for this node.
func (a *Agent) Label() string { return "PC-" + a.id.NodeID[len(a.id.NodeID)-6:] }

// Run connects and serves until ctx is canceled, reconnecting with backoff. On cancel it reports a
// running job as preempted (reason shutdown) and returns nil.
func (a *Agent) Run(ctx context.Context) error {
	backoff := a.cfg.ReconnectMin
	for {
		authed, err := a.session(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if authed {
			backoff = a.cfg.ReconnectMin
		}
		var af *AuthError
		switch {
		case errors.As(err, &af) && af.Code == "auth_invalid_signature":
			a.cfg.Logf("인증 실패: 에이전트 비밀값이 서버와 다릅니다 (%s)", af.Code)
		case errors.As(err, &af):
			a.cfg.Logf("인증 실패: %s", af.Code)
		default:
			a.cfg.Logf("서버 연결 끊김: %v", err)
		}
		a.cfg.Logf("%s 뒤에 다시 연결합니다", backoff)
		t := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			t.Stop()
			return nil
		case <-t.C:
		}
		backoff = min(backoff*2, a.cfg.ReconnectMax)
	}
}

type inbound struct {
	msg *protocol.Message
	bad *protocol.DecodeError
	err error
}

type jobResult struct {
	attemptID string
	res       runtime.Result
	err       error
}

type runningJob struct {
	attemptID string
	cancel    context.CancelFunc
	started   time.Time
}

type session struct {
	a       *Agent
	conn    *websocket.Conn
	writeMu sync.Mutex
	paused  bool
	job     *runningJob
	results chan jobResult
	ctx     context.Context // session lifetime (not the caller's ctx: shutdown still needs to write)
	// outer is the caller's ctx (Ctrl+C). A running job stops the moment it is canceled, even while
	// the main loop is busy (for example blocked writing to a stalled connection).
	outer context.Context
	// writeTimeout bounds each write; shutdown lowers it to ShutdownGrace.
	writeTimeout time.Duration
}

func (s *session) send(msgType string, corr *string, payload any) error {
	id, err := protocol.NewUUIDv7(time.Now(), rand.Reader)
	if err != nil {
		return fmt.Errorf("message id: %w", err)
	}
	data, err := s.a.codec.EncodeMessage(protocol.NewMessage(msgType, id, protocol.FormatTimestamp(time.Now()), corr, payload), protocol.SideAgent)
	if err != nil {
		return fmt.Errorf("encode %s: %w", msgType, err)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	wctx, cancel := context.WithTimeout(context.Background(), s.writeTimeout)
	defer cancel()
	if err := s.conn.Write(wctx, websocket.MessageText, data); err != nil {
		return fmt.Errorf("send %s: %w", msgType, err)
	}
	return nil
}

func (s *session) read(ctx context.Context) (*protocol.Message, error) {
	_, data, err := s.conn.Read(ctx)
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}
	msg, de := s.a.codec.DecodeMessage(data, protocol.SideAgent, protocol.DecodeOptions{})
	if de != nil {
		return nil, de
	}
	return msg, nil
}

func (s *session) handshake(ctx context.Context) error {
	a := s.a
	if err := s.send("hello", nil, protocol.HelloPayload{
		ProtocolHash:       protocol.ProtocolHash,
		AgentVersion:       a.cfg.AgentVersion,
		NodeID:             a.id.NodeID,
		CapabilitiesDigest: a.digest,
		FpStore:            a.id.FpStore,
		FpGlobal:           a.id.FpGlobal,
	}); err != nil {
		return err
	}
	msg, err := s.read(ctx)
	if err != nil {
		return err
	}
	switch p := msg.Payload.(type) {
	case *protocol.AuthFailPayload:
		return &AuthError{Code: string(p.Code)}
	case *protocol.AuthChallengePayload:
		bytes, err := protocol.AuthSigningBytes(p.Nonce, a.id.NodeID, protocol.ProtocolHash)
		if err != nil {
			return fmt.Errorf("challenge: %w", err)
		}
		sig, err := protocol.SignEd25519(a.id.SeedHex, bytes)
		if err != nil {
			return fmt.Errorf("sign: %w", err)
		}
		corr := msg.ID
		if err := s.send("auth.prove", &corr, protocol.AuthProvePayload{Signature: sig}); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unexpected %s during handshake", msg.Type)
	}
	msg, err = s.read(ctx)
	if err != nil {
		return err
	}
	switch p := msg.Payload.(type) {
	case *protocol.AuthFailPayload:
		return &AuthError{Code: string(p.Code)}
	case *protocol.AuthOkPayload:
		if p.Control.Mode != protocol.AuthOkControlModeActive {
			s.paused = true
		}
		return nil
	default:
		return fmt.Errorf("unexpected %s during handshake", msg.Type)
	}
}

func (s *session) status() error {
	a := s.a
	eligible := a.cfg.AlwaysAvailable && !s.paused
	state := protocol.StatusStateReady
	switch {
	case s.paused:
		state = protocol.StatusStatePaused
	case s.job != nil:
		state = protocol.StatusStateRunning
	case eligible:
		state = protocol.StatusStateEligible
	}
	reasons := []protocol.StatusPresenceReasonCode{}
	if s.paused {
		reasons = append(reasons, protocol.StatusPresenceReasonCodePaused)
	}
	if !a.cfg.AlwaysAvailable {
		// No customer detection yet: presence is unknown, so the node must not work (absolute rule 1).
		reasons = append(reasons, protocol.StatusPresenceReasonCodeHelperMissing)
	}
	idle := min(time.Since(a.started).Milliseconds(), 31_536_000_000)
	running := []string{}
	if s.job != nil {
		running = append(running, s.job.attemptID)
	}
	return s.send("status", nil, protocol.StatusPayload{
		State:             state,
		Eligible:          eligible,
		Presence:          protocol.StatusPresence{IdleForMs: idle, CustomerPresent: false, ReasonCodes: reasons},
		GPUs:              nil,
		RunningAttemptIDs: running,
		MeasuredAt:        protocol.FormatTimestamp(time.Now()),
	})
}

// session runs one connection. It returns whether authentication succeeded and why it ended.
func (a *Agent) session(ctx context.Context) (bool, error) {
	dialCtx, cancelDial := context.WithTimeout(ctx, a.cfg.HandshakeTimeout)
	conn, resp, err := websocket.Dial(dialCtx, a.cfg.ServerURL, nil)
	cancelDial()
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		return false, fmt.Errorf("connect %s: %w", a.cfg.ServerURL, err)
	}
	defer func() { _ = conn.CloseNow() }()
	// A little above the protocol limit so the codec reports message_too_large itself.
	conn.SetReadLimit(protocol.LimitMaxMessageBytes + 1024)

	sessCtx, endSession := context.WithCancel(context.Background())
	defer endSession()
	s := &session{a: a, conn: conn, results: make(chan jobResult, 1), ctx: sessCtx, outer: ctx, writeTimeout: a.cfg.HandshakeTimeout}

	hsCtx, cancelHs := context.WithTimeout(ctx, a.cfg.HandshakeTimeout)
	err = s.handshake(hsCtx)
	cancelHs()
	if err != nil {
		return false, err
	}
	a.cfg.Logf("서버에 연결됨: %s (노드 ID %s)", a.Label(), a.id.NodeID)
	if err := s.send("capabilities", nil, a.caps); err != nil {
		return true, err
	}
	if err := s.status(); err != nil {
		return true, err
	}

	in := make(chan inbound, 16)
	go func() {
		defer close(in)
		for {
			msg, err := s.read(sessCtx)
			var de *protocol.DecodeError
			switch {
			case errors.As(err, &de):
				select {
				case in <- inbound{bad: de}:
				case <-sessCtx.Done():
					return
				}
				if de.Code == protocol.CodeMessageTooLarge {
					return
				}
			case err != nil:
				select {
				case in <- inbound{err: err}:
				case <-sessCtx.Done():
				}
				return
			default:
				select {
				case in <- inbound{msg: msg}:
				case <-sessCtx.Done():
					return
				}
			}
		}
	}()

	heartbeat := time.NewTicker(a.cfg.HeartbeatInterval)
	defer heartbeat.Stop()
	progress := time.NewTicker(a.cfg.ProgressInterval)
	defer progress.Stop()
	silence := time.NewTicker(min(time.Second, a.cfg.ServerSilenceLimit/4))
	defer silence.Stop()
	lastServer := time.Now()

	for {
		select {
		case <-ctx.Done():
			s.shutdown()
			return true, nil
		case r := <-s.results:
			if err := s.finish(r); err != nil {
				s.stopJob("")
				return true, err
			}
		case <-heartbeat.C:
			if err := s.send("heartbeat", nil, protocol.HeartbeatPayload{}); err != nil {
				s.stopJob("")
				return true, err
			}
		case <-progress.C:
			if s.job != nil {
				// SKELETON(S19): the runtime does not report tokens while generating (TokensSoFar 0).
				if err := s.send("job.progress", nil, protocol.JobProgressPayload{AttemptID: s.job.attemptID, TokensSoFar: 0}); err != nil {
					s.stopJob("")
					return true, err
				}
			}
		case <-silence.C:
			if time.Since(lastServer) > a.cfg.ServerSilenceLimit {
				// T13: without the server we cannot receive a kill switch — stop working, free the GPU.
				s.stopJob("")
				s.release()
				return true, ErrServerSilent
			}
		case m, ok := <-in:
			if !ok {
				s.stopJob("")
				return true, errors.New("connection closed")
			}
			if m.err != nil {
				s.stopJob("")
				return true, m.err
			}
			lastServer = time.Now()
			if m.bad != nil {
				if err := s.onInvalid(m.bad); err != nil {
					return true, err
				}
				continue
			}
			if err := s.handle(m.msg); err != nil {
				s.stopJob("")
				return true, err
			}
		}
	}
}

func (s *session) onInvalid(de *protocol.DecodeError) error {
	if de.Pause {
		// PROTOCOL 4절 fail-safe: it may have been a kill — stop as for control.pause.
		s.a.cfg.Logf("서버가 보낸 잘못된 메시지(%s): 안전을 위해 멈춥니다", de.Code)
		s.stopJob(protocol.JobPreemptedReasonPause)
		s.paused = true
		s.release()
		if err := s.status(); err != nil {
			return err
		}
	}
	if de.Code == protocol.CodeMessageTooLarge {
		s.stopJob("")
		return errors.New("message too large")
	}
	return nil
}

func (s *session) ack(corr string, code protocol.ErrorCode) error {
	p := protocol.AckPayload{Result: protocol.AckResultOk}
	if code != "" {
		p = protocol.AckPayload{Result: protocol.AckResultRejected, Code: &code}
	}
	return s.send("ack", &corr, p)
}

func (s *session) handle(msg *protocol.Message) error {
	a := s.a
	switch p := msg.Payload.(type) {
	case *protocol.JobOfferPayload:
		return s.onOffer(msg.ID, p)
	case *protocol.JobCancelPayload:
		if s.job != nil && s.job.attemptID == p.AttemptID {
			a.cfg.Logf("서버가 작업을 취소했습니다 (%s)", p.Reason)
			s.stopJob("")
			if err := s.status(); err != nil {
				return err
			}
		}
		return s.ack(msg.ID, "")
	case *protocol.ControlPausePayload:
		s.stopJob(protocol.JobPreemptedReasonPause)
		s.paused = true
		s.release()
		a.cfg.Logf("일시정지 (%s)", p.Reason)
		if err := s.ack(msg.ID, ""); err != nil {
			return err
		}
		return s.status()
	case *protocol.ControlKillPayload:
		s.stopJob(protocol.JobPreemptedReasonKill)
		s.paused = true
		s.release()
		a.cfg.Logf("킬스위치 (%s)", p.Reason)
		if err := s.ack(msg.ID, ""); err != nil {
			return err
		}
		return s.status()
	case *protocol.ControlResumePayload:
		s.paused = false
		if err := s.ack(msg.ID, ""); err != nil {
			return err
		}
		return s.status()
	case *protocol.ConfigUpdatePayload:
		// SKELETON(S17): store policies are not applied yet.
		return s.ack(msg.ID, protocol.ErrorCodePolicyInvalid)
	case *protocol.ModelEnsurePayload:
		// SKELETON(S20): model downloads arrive with the model cache.
		return s.ack(msg.ID, protocol.ErrorCodeDownloadFailed)
	case *protocol.UpdateAvailablePayload:
		// SKELETON(S21): self-update arrives with the updater.
		return s.ack(msg.ID, protocol.ErrorCodeManifestInvalid)
	case *protocol.ErrorPayload:
		if p.Fatal {
			return fmt.Errorf("server error %s", p.Code)
		}
		return nil
	default:
		return nil // heartbeat.ack and anything else needs no action
	}
}

func (s *session) onOffer(offerID string, p *protocol.JobOfferPayload) error {
	a := s.a
	corr := offerID
	reject := func(r protocol.JobRejectReason) error {
		return s.send("job.reject", &corr, protocol.JobRejectPayload{AttemptID: p.AttemptID, Reason: r})
	}
	switch {
	case s.paused:
		return reject(protocol.JobRejectReasonPolicy)
	case !a.cfg.AlwaysAvailable:
		return reject(protocol.JobRejectReasonNotIdle)
	case s.job != nil:
		return reject(protocol.JobRejectReasonBusy)
	case !a.models[p.Model.ID]:
		return reject(protocol.JobRejectReasonModelMissing)
	case p.Input == nil || len(p.Input.Messages) == 0:
		// SKELETON(S17): inputRef downloads and completion prompts are not supported yet.
		return reject(protocol.JobRejectReasonPolicy)
	}
	if err := s.send("job.accept", &corr, protocol.JobAcceptPayload{AttemptID: p.AttemptID}); err != nil {
		return err
	}
	req := runtime.Request{
		Model:            p.Model.ID,
		MaxTokens:        p.Params.MaxTokens,
		TemperatureMilli: p.Params.TemperatureMilli,
		TopPMilli:        p.Params.TopPMilli,
		Stop:             p.Params.Stop,
		Seed:             p.Params.Seed,
		Greedy:           p.Params.Greedy,
	}
	for _, m := range p.Input.Messages {
		req.Messages = append(req.Messages, runtime.Message{Role: string(m.Role), Content: m.Content})
	}
	limit := time.Duration(p.TimeLimitMs) * time.Millisecond
	jobCtx, cancelJob := context.WithTimeout(s.ctx, limit)
	// Ctrl+C cancels the generation directly, without waiting for the main loop.
	stopOnExit := context.AfterFunc(s.outer, cancelJob)
	cancel := func() {
		stopOnExit()
		cancelJob()
	}
	s.job = &runningJob{attemptID: p.AttemptID, cancel: cancel, started: time.Now()}
	a.cfg.Logf("작업 시작: %s (모델 %s)", short(p.AttemptID), p.Model.ID)
	go func(attemptID string) {
		res, err := a.cfg.Runtime.Generate(jobCtx, req)
		select {
		case s.results <- jobResult{attemptID: attemptID, res: res, err: err}:
		case <-s.ctx.Done():
		}
	}(p.AttemptID)
	return s.status()
}

// finish reports a finished generation unless the job was stopped in the meantime.
func (s *session) finish(r jobResult) error {
	if s.job == nil || s.job.attemptID != r.attemptID {
		return nil // stopped (canceled, preempted): the result is discarded
	}
	took := time.Since(s.job.started)
	s.job.cancel()
	s.job = nil
	if r.err != nil {
		e := runtime.AsError(r.err)
		s.a.cfg.Logf("작업 실패: %s (%s)", short(r.attemptID), e.Code)
		if err := s.send("job.fail", nil, protocol.JobFailPayload{AttemptID: r.attemptID, Code: protocol.ErrorCode(e.Code), Retryable: e.Retryable}); err != nil {
			return err
		}
		return s.status()
	}
	sum := sha256.Sum256([]byte(r.res.Text))
	text := r.res.Text
	finish := protocol.JobCompleteFinishReasonStop
	if r.res.FinishReason == "length" {
		finish = protocol.JobCompleteFinishReasonLength
	}
	if err := s.send("job.complete", nil, protocol.JobCompletePayload{
		AttemptID:         r.attemptID,
		OutputText:        &text,
		FinishReason:      finish,
		ReportedTokensIn:  r.res.TokensIn,
		ReportedTokensOut: r.res.TokensOut,
		Timings:           protocol.JobCompleteTimings{LoadMs: r.res.LoadMs, PromptMs: r.res.PromptMs, GenMs: r.res.GenMs},
		OutputSha256:      hex.EncodeToString(sum[:]),
		Runtime:           protocol.RuntimeInfo{Name: protocol.RuntimeName(s.a.cfg.Runtime.Name()), Version: protocol.SanitizeToken(s.a.cfg.Runtime.Version())},
	}); err != nil {
		return err
	}
	s.a.cfg.Logf("작업 완료: %s (%.1f초, 출력 토큰 %d)", short(r.attemptID), took.Seconds(), r.res.TokensOut)
	return s.status()
}

// stopJob cancels the running job at once and, with a reason, reports it as preempted.
func (s *session) stopJob(reason protocol.JobPreemptedReason) {
	if s.job == nil {
		return
	}
	j := s.job
	s.job = nil
	j.cancel()
	if reason != "" {
		// No chunks are streamed in S04: nothing was delivered (lastSeq -1).
		_ = s.send("job.preempted", nil, protocol.JobPreemptedPayload{AttemptID: j.attemptID, Reason: reason, LastSeq: -1})
	}
}

// release asks the runtime to free GPU memory (bounded by ReleaseTimeout). A failure is logged: the
// job is already stopped, and there is nothing else the agent can do about the runtime.
func (s *session) release() {
	ctx, cancel := context.WithTimeout(context.Background(), s.a.cfg.ReleaseTimeout)
	defer cancel()
	if err := s.a.cfg.Runtime.Release(ctx); err != nil {
		s.a.cfg.Logf("GPU 메모리 해제 실패: %v", err)
	}
}

// shutdown is Ctrl+C: stop the job, free the GPU, tell the server (within ShutdownGrace), close.
func (s *session) shutdown() {
	if s.job != nil {
		s.a.cfg.Logf("종료: 진행 중 작업 %s를 중단하고 서버에 알립니다", short(s.job.attemptID))
	}
	released := make(chan struct{})
	go func() {
		defer close(released)
		s.release()
	}()
	s.writeTimeout = s.a.cfg.ShutdownGrace
	s.stopJob(protocol.JobPreemptedReasonShutdown)
	<-released
	ctx, cancel := context.WithTimeout(context.Background(), s.a.cfg.ShutdownGrace)
	defer cancel()
	done := make(chan struct{})
	go func() {
		_ = s.conn.Close(websocket.StatusNormalClosure, "shutdown")
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

func short(id string) string {
	if len(id) > 8 {
		return id[len(id)-8:]
	}
	return id
}
