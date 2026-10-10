# S19 · 런타임 관리자 (llama.cpp)·모델 캐시

| 항목 | 값 |
|---|---|
| 의존 | S09, S17, S18 |
| 권장 모델 | Opus 5.5 |
| 규모 | L |
| 사람 필요 | 끝에 실기 확인 — NVIDIA GPU에서 실제 모델 실행과 처리량 측정 |

이 차수는 `prompts/_PROTOCOL.md`를 따른다.

## 목표
PC에서 실제 추론을 돌린다: 서명된 llama.cpp 런타임과 모델을 내려받아 검증하고, 안전하게 띄우고, 손님이 오면 즉시 죽이고, 디스크를 넘치게 하지 않는다. 그리고 실제 GPU에서 **처리량·VRAM·전력을 측정하는 도구**를 만들어, 경제 시뮬레이터(S07)의 가장 큰 미지수를 실측으로 바꿀 길을 연다.

## 먼저 읽을 것
- ADR 0004·0009·0015, `docs/SIGNING.md`, `docs/MODEL_CANDIDATES.md`, `docs/AGENT.md`, `docs/PRESENCE.md`(다운로드 일시정지 신호)

## 산출물
- `apps/agent/internal/runtime/llamacpp/` — 설치·실행·감시·추론·종료
- `apps/agent/internal/gpu/nvidia/` — nvidia-smi 기반 GPU 정보·사용량·온도·전력·프로세스별 메모리
- `apps/agent/internal/cache/` — 모델·런타임 캐시, 내려받기 관리자
- `apps/agent/cmd/spareon-agent bench` 하위 명령 — 실측 도구
- 가짜 llama-server(`internal/runtime/llamacpp/fakeserver`) — CI용
- `docs/RUNTIME.md`, `docs/manual-tests/S19.md`

## 상세 요구사항

### 1. 런타임 설치
- 서버의 런타임 릴리스(S09)에서 플랫폼에 맞는 llama.cpp 빌드(Windows CUDA 빌드)를 받아 SHA-256·서명 검증 → 버전별 폴더에 원자적으로 설치(임시 폴더 → 검증 → 이름 바꾸기). 이전 버전 1개 보관.
- **GitHub 등 외부에서 직접 받지 않는다** — 우리 아티팩트 경로만(서명 검증이 신뢰의 근거).

### 2. 실행
- `llama-server`를 다음 원칙으로 띄운다(플래그 이름은 고정한 버전의 `--help`로 확인해 문서화): 127.0.0.1에만 바인딩, 무작위 포트, 무작위 API 키, 디스크 캐시·슬롯 저장 끔, 프롬프트 로그 끔, GPU 레이어 최대, 동시 슬롯 1, 컨텍스트는 모델·VRAM에 맞게.
- 프로세스는 Windows Job Object(종료 시 함께 종료, 메모리 상한 옵션)에 넣는다. 리눅스는 프로세스 그룹. S18의 `TerminateJobObject` 경로가 이걸 죽인다.
- 상태 확인(`/health`) 통과 전에는 작업을 받지 않는다. 비정상 종료 시 백오프 재시작, 10분 안 3회 이상이면 '런타임 불안정'으로 보고하고 작업 중단.
- 모델 로딩 중 손님이 오면 로딩도 즉시 중단(프로세스 종료).

### 3. 추론
- 채팅: OpenAI 호환 엔드포인트(스트리밍)로 생성, 청크를 `job.chunk`로 전달.
- 이어쓰기: 대화 템플릿을 적용한 원문 + 지금까지 출력을 접두사로 하는 완성 요청(엔드포인트·템플릿 처리는 버전에 맞게 확인).
- 검증 모드: temperature 0, seed 고정, top-k 1.
- 토큰 수·시간 정보는 런타임 응답에서 읽어 보고(과금은 서버가 다시 센다).

### 4. GPU 정보 (nvidia-smi)
- 질의 형식(`--query-gpu=...`, `--format=csv,noheader,nounits`)으로 이름, UUID, VRAM 총량·사용량, 온도, 사용률, 전력, 드라이버 버전. 프로세스별 메모리(`--query-compute-apps`).
- **실제 출력 샘플을 fixture로 저장해 파서를 테스트**(여러 드라이버 버전 형식, 빈 값, `[N/A]`, 다중 GPU).
- nvidia-smi가 없거나 실패하면 'GPU 정보 없음' → 작업 불가(fail-safe).

### 5. 캐시와 내려받기
- 캐시 폴더(설정, 기본 `%ProgramData%\Spareon\cache` — S20에서 영구 드라이브로 바꿀 수 있게), 모델별 하위 폴더, 원자적 저장(.part → 검증 → 이름 바꾸기).
- 이어받기(HTTP Range), SHA-256 검증, 실패 시 지수 백오프.
- 대역폭 상한(토큰 버킷), **다운로드 허용 시간대 + 손님 없음일 때만**(S18 신호로 즉시 일시정지).
- 디스크 보호: 여유 공간이 설정값(기본 20GB 또는 15%) 밑이면 받지 않고, LRU로 오래 안 쓴 모델부터 지움(매장 기본 모델은 고정).
- 주기적 무결성 재검사(해시), 손상 시 삭제·재다운로드.
- 받는 순서: 로컬 캐시 → LAN 캐시(S20, 이 차수에서는 인터페이스) → 서버/CDN.

### 6. 개발용 Ollama 어댑터
- S04 어댑터를 같은 `Runtime` 인터페이스에 맞게 정리(개발·친구 PC 데모용). 운영 매장에서는 llama.cpp만.

### 7. 실측 도구 (`spareon-agent bench`)
- 지정 모델로 고정 프롬프트 세트를 돌려: 로딩 시간, 프롬프트 처리 속도, 생성 tokens/s, 최대 VRAM, 평균·최대 전력(nvidia-smi 샘플링), GPU 온도 추이를 측정해 JSON + 사람이 읽는 표로 출력.
- 결과 JSON 형식은 `tools/econ-sim/params/assumptions.json`의 처리량·전력 항목을 갱신할 수 있게 맞춘다(갱신 스크립트 포함).

### 8. CI용 가짜 llama-server
- llama-server의 엔드포인트(health, 채팅 스트리밍, 완성)를 흉내 내는 작은 Go HTTP 서버. 지연·실패·중간 끊김을 설정 가능. 에이전트 통합 테스트는 이걸로 돈다.

## 하지 말 것
- 운영 경로에서 Ollama 사용
- 서명 검증 없이 실행 파일·모델 사용
- GPU 전력 제한 변경(nvidia-smi -pl 등 관리자 조작) — v0.1 범위 밖

## 수용 기준
1. `pnpm verify` 통과(`GOOS=windows` 빌드 포함)
2. 내려받기 테스트: 이어받기, 해시 불일치 거부, 서명 불일치 거부, 디스크 부족 시 거부, LRU 삭제
3. 가짜 llama-server로 에이전트 → 서버 작업 완료 통합 테스트, 이어쓰기 테스트
4. 프로세스 트리 종료 테스트(자식 프로세스까지 종료 확인)
5. nvidia-smi 파서 fixture 테스트
6. `docs/manual-tests/S19.md`: 실제 GPU에서 bench 실행·결과 기록 절차, HUMAN_TODO 추가, 상태 `DONE_NEEDS_HUMAN`

## 적대적 검토 포인트
- 경로 조작(아티팩트 이름에 `..`), 부분 파일이 검증 없이 쓰이는 경로
- 런타임이 외부 인터페이스에 바인딩되거나 API 키 없이 열리는 경우
- 디스크를 가득 채워 손님 PC를 망가뜨리는 경로

## 선택 확장
- 모델 사전 로딩(Eligible 직전 예열) — 단, 손님 오면 즉시 해제
- 처리량 실측값을 서버에 보고해 스케줄러가 노드별 속도를 학습
