# S17 · 에이전트 코어 (Go)·노드 시뮬레이터

| 항목 | 값 |
|---|---|
| 의존 | S02, S11 |
| 권장 모델 | Opus 5.5 |
| 규모 | XL |
| 사람 필요 | 없음 |

이 차수는 `prompts/_PROTOCOL.md`를 따른다.

## 목표
PC방 PC에서 몇 달 동안 꺼지지 않고 돌아갈 에이전트의 뼈대를 만든다: 상태 기계, 기기 신원과 등록, 서버 연결과 재연결, 프로토콜 검증, 작업 실행기, 설정, 로그, 지표. Windows 전용 부분(손님 감지, 서비스, 런타임, 설치)은 다음 차수들이 붙일 수 있게 **인터페이스와 가짜 구현**으로 남기고, 리눅스에서도 전부 테스트되게 한다. 동시에 같은 코드로 수백 대 PC를 흉내 내는 **노드 시뮬레이터**를 만든다 — 이후 서버 시험(S12·S13·S27)의 핵심 도구다.

## 먼저 읽을 것
- `docs/PROTOCOL.md`, `docs/ENROLLMENT.md`, `docs/GATEWAY.md`, ADR 0008·0011·0016, `docs/ARCHITECTURE.md`(에이전트 모듈, 노드 상태 기계), S04의 Go 에이전트 코드와 교체 목록

## 산출물
```
apps/agent/
  cmd/spareon-agent/   서비스·콘솔 겸용 실행 파일
  cmd/nodesim/         가상 노드 N개 실행기
  internal/
    config/ logging/ state/ identity/ enroll/ conn/ protocol/
    executor/ runtime/ (interface + fake + ollama — llama.cpp는 S19)
    presence/ (interface + fake — Windows 구현은 S18)
    gpu/ (interface + fake — nvidia-smi 구현은 S19)
    metrics/ platform/ (OS별 경로·권한 추상화)
```
- `docs/AGENT.md` — 구조, 상태 기계, 설정 항목, 명령, 로그 위치

## 상세 요구사항

### 1. 상태 기계
- 상태: Unenrolled → Enrolling → Connecting → Authenticating → Ready(대기) ⇄ Eligible(작업 가능) → Running → Preempting → Ready, 그리고 Paused, Quarantined, Updating, ShuttingDown.
- 전이는 한 곳(state 패키지)에서만 일어나고, 모든 전이를 로그·지표로 남긴다. 허용되지 않는 전이는 에러.
- **기본값은 안전**: 정보가 없거나 불확실하면 Eligible이 아니다(ADR 0016).

### 2. 설정
- 우선순위: 명령줄 플래그 > 환경변수 > 설정 파일(`<persistentDir>/config.json`) > 기본값. 서버 URL, 영구 데이터 폴더, 로그 수준, 런타임 종류, 캐시 폴더 등.
- 서버가 보낸 정책(`config.update`)은 검증 후 원자적으로 교체하고 버전을 기록.

### 3. 신원과 등록
- ed25519 키쌍 생성·저장(`KeyStore` 인터페이스: 파일 구현 — 개발용, Windows DPAPI 구현은 S22). 하드웨어 지문 원본 수집 인터페이스(가짜 + Windows 구현 자리).
- S10 등록 흐름(`enroll.start` → `enroll.complete`) 구현, 등록 코드는 플래그·설정·설치 프로그램(S21)으로 받는다.

### 4. 연결
- WebSocket(`github.com/coder/websocket`), S11 인증 순서, `resumeToken`으로 재개.
- 재연결: 지수 백오프 + 지터, 최대 간격 설정. 서버가 `protocol_unsupported`를 보내면 업데이트 대기 상태로.
- 프록시 지원은 S20에서 확장하므로 HTTP 클라이언트 생성을 한 곳으로 모은다.
- 모든 수신 메시지는 내장 스키마로 검증(S02).

### 5. 실행기
- `Runtime` 인터페이스: `Ensure(model)`, `Start(ctx)`, `Generate(ctx, req) (stream)`, `Stop(force)`, `Health()`. 가짜 런타임은 처리 속도·지연·실패율·모델 신원·비결정성·이어쓰기를 설정할 수 있다(S12·S13 시뮬레이션과 같은 의미).
- 작업 하나 = 시도 하나: offer → (정책·상태 확인) → accept/reject → 실행 → chunk 전송 → complete/fail.
- **선점 경로**: `Preempt(reason)` 호출 시 진행 중 생성을 즉시 중단, `job.preempted` 전송, 런타임 `Stop(force)`. 이 경로는 다른 모든 일보다 우선한다(전용 고우선 채널, 블로킹 없음). 실제 손님 감지 연결은 S18.
- 작업 데이터는 메모리에만 둔다. 디스크에 쓰는 코드가 실행기 경로에 없어야 한다(S22에서 감사).

### 6. 로그·지표
- 구조화 로그(JSON), 크기 회전, 보존 개수 제한. **프롬프트·출력 내용은 절대 로그에 남기지 않는다**(길이·해시만).
- 지표: 상태별 체류 시간, 작업 수, 실패 사유, 재연결 수, 선점 지연(손님 입력 → 프로세스 종료 → VRAM 해제 — 측정 지점 정의는 여기서, 실제 측정은 S18). `status` 메시지로 서버에 보고.

### 7. 명령
- `spareon-agent run`(콘솔), `enroll --code`, `status`(로컬 상태 요약), `version`, `service install|uninstall|start|stop`(Windows가 아니면 '지원 안 함' 메시지 — 실제 구현 S21).

### 8. 노드 시뮬레이터 (`cmd/nodesim`)
- 한 프로세스에서 가상 노드 N개(목표 500개 이상)를 실제 에이전트 코드 경로로 실행(가짜 런타임·가짜 손님 감지).
- 손님 패턴 스크립트: 시간 압축(예: 하루를 10분으로), 매장별 붐비는 시간대 프로필.
- 사기 모드: S13의 노드 유형(게으름, 쓰레기, 재사용, 잘라 먹기, 간헐적, 공모) 비율 지정.
- 결과 요약: 노드별 작업 수, 선점 수, 수익(서버 조회).

## 하지 말 것
- Windows 서비스 등록, 손님 감지, llama.cpp, 업데이트(S18~S21)
- 작업 데이터 디스크 기록

## 수용 기준
1. `pnpm verify` 통과(`go test -race ./...` 포함, `GOOS=windows` 빌드 성공)
2. 통합 테스트: 테스트 스크립트가 서버를 띄우고 가상 노드 20개로 작업 200개 완료, 원장 대사 차이 0
3. 재연결 테스트: 서버 재시작·연결 강제 종료 후 자동 복귀, 재개 창 안이면 진행 중 작업 유지
4. 선점 경로 단위 테스트: Preempt 호출 → 100ms 안에 `job.preempted` 송신·런타임 정지(가짜 기준)
5. nodesim 500노드 실행 시 메모리·CPU 측정값 REPORT 기록
6. 로그에 프롬프트 문자열이 0회 등장(테스트로 확인)

## 적대적 검토 포인트
- 고루틴 누수, 채널 막힘으로 선점 경로가 지연되는 경우
- 불확실 상태에서 Eligible로 넘어가는 경로
- 재연결 폭주(서버 장애 시 모든 노드가 동시에 재접속 — 지터 확인)

## 선택 확장
- 로컬 상태 페이지(127.0.0.1 전용, 읽기 전용) — 사장님이 PC 한 대의 상태를 직접 확인
- 시뮬레이터 결과를 CSV로 저장
