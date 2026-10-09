# 0단계 데모: 친구 PC가 질문에 답하고 장부에 남는다

> S04(걷는 뼈대)에서 만들었다. 로드맵 0단계([BUSINESS_CONTEXT](BUSINESS_CONTEXT.md) 11절)를 내 눈으로 확인하는 절차다.
> 개발용 데모다. 실제 돈은 움직이지 않는다(장부의 크레딧은 테스트 충전으로 기록한 값이다). 손님 감지는 아직 없으므로(S18) **사람이 쓰고 있지 않은 PC에서만** 돌린다.

## 1. 무엇을 보게 되나
1. 내 PC에서 서버를 켠다.
2. 친구 PC 2~3대가 서버에 접속한다(에이전트 프로그램 + Ollama).
3. 내가 질문을 보내면 친구 PC 중 한 대가 답한다.
4. 대시보드(`/dev`)에서 그 PC가 '작업 중' → '대기'로 바뀌고, 장부에 크레딧 이동이 기록된다: 구매자 지갑 −0.01 CR, 매장 미성숙 수익 +0.007 CR(70%), 플랫폼 매출 +0.003 CR(30%). 통화별 합은 항상 0이다.

## 2. 준비물
| 무엇 | 어디에 | 비고 |
|---|---|---|
| 이 저장소, Node.js 22 이상, pnpm(`corepack enable`) | 내 PC(서버) | `pnpm install`을 한 번 해 둔다 |
| Go(최신 안정 버전) | 내 PC | 친구 PC용 `binjari-agent.exe`를 만드는 데만 쓴다 |
| Ollama | 친구 PC마다 | <https://ollama.com> 에서 설치 |
| 가벼운 채팅 모델 아무거나 하나 | 친구 PC마다 | 예: `qwen2.5:0.5b`. 이름은 예시일 뿐이다. 모든 PC가 같은 모델을 받으면 비교하기 쉽다 |

PC 사양 메모: GPU가 없어도 된다. Ollama가 GPU를 가속하지 못하면 CPU로 돈다(5.3절).

## 3. 먼저 혼자 해 보기 (자동 데모, 1분)
친구 PC 없이 내 PC 하나에서 전체 흐름을 확인한다. 임시 DB와 가짜 에이전트 2대를 띄워 질문 10개를 보낸다.
```
pnpm demo
```
마지막 줄이 `10/10 완료, 원장 합 0`이면 성공이다. Go가 설치돼 있으면 진짜 Go 에이전트(가짜 런타임)를, 없으면 TypeScript 가짜 에이전트를 쓴다(`pnpm demo --ts`로 강제).

## 4. 서버 켜기 (내 PC)

### 4.1 키 정하기 (선택)
서버는 개발용 키 두 개를 쓴다. 정하지 않으면 켤 때마다 새로 만들어 화면에 보여 준다.
- `DEV_API_KEY`: 질문을 보낼 때 쓰는 구매자 API 키
- `DEV_AGENT_SECRET`: 친구 PC의 에이전트가 서버에 붙을 때 쓰는 비밀값

고정하고 싶으면(24자 이상, 공백 없이) PowerShell에서:
```powershell
$env:DEV_API_KEY = "dev-key-내가-정한-충분히-긴-문자열"
$env:DEV_AGENT_SECRET = "dev-agent-내가-정한-다른-긴-문자열"
```
이 값은 개발용이다. 운영 설정(`NODE_ENV=production`)에서는 서버가 이 값들을 거부하고 켜지지 않는다.

### 4.2 켜기
연결 방법에 따라 고른다.
- **같은 와이파이(①)**: `pnpm dev:server --lan`
  - `--lan`일 때만 다른 PC가 접속할 수 있다(기본은 이 PC에서만 접속 가능).
  - 화면에 `ws://192.168.x.x:8080/agent/v1/ws` 같은 주소가 나온다. 친구 PC에 이 주소를 알려 준다.
  - Windows가 "Windows 보안 경고"를 띄우면 **개인 네트워크만** 허용한다.
- **다른 장소(②)**: `pnpm dev:server`(이 PC에서만) + 터널(4.3절).

켜지면 화면에 대시보드 주소(`http://127.0.0.1:8080/dev`), API 키, 에이전트 비밀값이 나온다. 기본 DB는 임시 Postgres라서 **서버를 끄면 장부도 지워진다**(로컬 Postgres를 계속 쓰려면 `DATABASE_URL`을 지정).

### 4.3 다른 장소의 친구 PC: 터널(개발용·임시)
> **경고**: 터널은 내 PC의 서버를 인터넷에 잠깐 여는 것이다. 데모 동안에만 켜고 끝나면 반드시 끈다. 주소를 아는 사람은 누구나 `/dev` 대시보드(노드 목록·잔액, 질문 내용은 없음)를 볼 수 있다. 질문 API와 에이전트 접속은 키·비밀값이 있어야 한다.

Cloudflare Tunnel의 임시 터널을 예로 든다. **아래 명령은 확인 필요**(설치 방법·옵션은 Cloudflare 문서에서 확인).
```
cloudflared tunnel --url http://localhost:8080
```
나오는 `https://<임의 이름>.trycloudflare.com` 주소를 쓰고, 에이전트에는 `wss://<임의 이름>.trycloudflare.com/agent/v1/ws`(앞이 `wss://`)를 알려 준다. 데모가 끝나면 Ctrl+C로 터널을 끈다.

## 5. 친구 PC에서

### 5.1 에이전트 실행 파일 만들기 (내 PC에서 한 번)
저장소 폴더에서:
```powershell
cd apps/agent
$env:GOOS = "windows"; $env:GOARCH = "amd64"
go build -o binjari-agent.exe ./cmd/binjari-agent
```
macOS·Linux 셸이면 `GOOS=windows GOARCH=amd64 go build -o binjari-agent.exe ./cmd/binjari-agent`.
만든 `binjari-agent.exe`를 USB·메신저로 친구 PC에 옮긴다. 서명하지 않은 파일이라 Windows SmartScreen이 경고할 수 있다(코드 서명은 S21). "추가 정보 → 실행"으로 실행한다.

### 5.2 Ollama와 모델
친구 PC의 PowerShell에서:
```powershell
ollama pull qwen2.5:0.5b        # 예시. 가벼운 채팅 모델 아무거나
ollama run qwen2.5:0.5b "안녕"   # 답이 나오면 준비 완료 (Ctrl+D로 나오기)
```

### 5.3 GPU를 쓰는지 확인 (`ollama ps`)
모델이 메모리에 올라가 있는 동안(위 `ollama run` 직후나 질문을 받는 중) 다른 창에서:
```powershell
ollama ps
```
`PROCESSOR` 열이 `100% GPU`면 GPU로, `100% CPU`면 CPU로 돌고 있다(`48%/52% CPU/GPU`처럼 나뉘기도 한다).
- Ollama가 그 GPU를 가속하지 못하면 CPU로 돈다. 창업자의 실기 PC(AMD Radeon RX 5700 XT, RDNA1)가 이 경우일 수 있다(Ollama의 AMD 지원 목록에 RDNA1이 없는 것으로 알고 있다 — 확인 필요, `ollama ps`로 직접 본다). **CPU로 돌아도 데모 흐름은 같다**: 답이 늦게 올 뿐 대시보드와 장부는 똑같이 움직인다. 에이전트는 생성하는 동안 5초마다 진행을 알리므로 느린 PC도 작업을 빼앗기지 않는다(작업 마감 10분).
- 어떤 PC가 GPU로 돌았는지 기록해 두면 좋다([KNOWN_UNKNOWNS](KNOWN_UNKNOWNS.md) K17). AMD GPU 가속은 데모가 아니라 S19의 Vulkan `llama-server`로 확인한다([ADR 0019](adr/0019-amd-vulkan-test-node-support.md)).
- 속도(초당 토큰)는 아직 측정 전이다. 숫자를 적었다면 '이 PC에서 잰 값'으로 알려 준다.

### 5.4 에이전트 켜기
```powershell
$env:BINJARI_DEV_AGENT_SECRET = "서버 화면에 나온 에이전트 비밀값"
.\binjari-agent.exe run --server ws://192.168.0.10:8080/agent/v1/ws --name friend-1 --runtime ollama --model qwen2.5:0.5b --always-available
```
- `--server`: 4.2절에서 받은 주소(터널이면 `wss://...`).
- `--name`: PC마다 다른 이름(영문·숫자·`.`·`_`·`-`, 64자 이하).
- `--model`: Ollama 모델 이름. 서버와 질문에서 쓰는 **모델 ID는 `:`가 `-`로 바뀐 이름**이다(`qwen2.5:0.5b` → `qwen2.5-0.5b`). 에이전트가 켜질 때 화면에 ID를 보여 준다.
- `--always-available`: "지금 이 PC에는 사람이 없다"는 뜻이다. 손님(사용자) 감지 기능이 아직 없어서(S18) 이 표시가 없으면 에이전트는 작업을 받지 않는다. **친구가 PC를 쓰기 시작하면 Ctrl+C로 끈다.** 끄면 하던 작업을 서버에 '중단'으로 알리고, 서버는 그 질문을 다른 PC에 다시 맡긴다.
- 화면 첫 줄의 `대시보드 표시 PC-xxxxxx`가 대시보드에 보이는 이름이다.

## 6. 성공 확인
1. 내 PC 브라우저에서 `http://127.0.0.1:8080/dev`를 연다(2초마다 새로 고침).
2. '노드' 표에 친구 PC가 `PC-xxxxxx`, 연결 '연결됨', 상태 '대기', 작업 가능 '예', 모델 `qwen2.5-0.5b`로 보인다.
3. 질문을 보낸다(내 PC, PowerShell):
   ```powershell
   $body = @{ model = "qwen2.5-0.5b"; messages = @(@{ role = "user"; content = "한 문장으로 자기소개 해 줘" }) } | ConvertTo-Json -Depth 5
   Invoke-RestMethod -Uri http://127.0.0.1:8080/v1/chat/completions -Method Post `
     -Headers @{ Authorization = "Bearer 서버_화면의_API_키" } `
     -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
   ```
   macOS·Linux:
   ```
   curl -s http://127.0.0.1:8080/v1/chat/completions -H "Authorization: Bearer 서버_화면의_API_키" -H "Content-Type: application/json" -d '{"model":"qwen2.5-0.5b","messages":[{"role":"user","content":"한 문장으로 자기소개 해 줘"}]}'
   ```
4. 대시보드에서 그 PC가 '작업 중'이 되고, 답이 오면 '대기'로 돌아온다. '최근 작업'에 '완료'와 과금 `0.010000 CR`, '잔액'에 매장 미성숙 수익(70%)과 플랫폼 매출(30%)이 늘어난 것이 보인다. '원장 합'은 '정상: 모든 통화의 합이 0입니다.'
5. 질문을 여러 개 동시에 보내면 여러 PC가 나눠 받는다. 한 PC의 에이전트를 도중에 꺼도 그 질문은 다른 PC가 마저 처리하고, 실패한 질문은 과금되지 않는다.

대시보드에는 질문과 답의 내용이 나오지 않는다(데이터 최소 보관). 질문은 서버 DB에 암호화되어 24시간 뒤 지워지고, 답은 저장하지 않는다.

## 7. 문제 해결
| 증상 | 원인과 해결 |
|---|---|
| 에이전트가 "서버 연결 끊김: connect ... " 를 반복 | ① 서버를 `--lan` 없이 켰다 → `pnpm dev:server --lan` ② 방화벽이 8080 포트를 막는다 → 서버 PC의 Windows Defender 방화벽에서 Node.js의 '개인 네트워크' 허용, 또는 인바운드 규칙으로 TCP 8080 허용 ③ 주소 오타(`ws://IP:8080/agent/v1/ws`), 두 PC가 다른 네트워크(게스트 와이파이 등) ④ 터널이면 `wss://`인지 |
| 서버가 `EADDRINUSE`(포트 사용 중)로 안 켜짐 | 8080을 다른 프로그램이 쓰는 중 → `pnpm dev:server --lan --port 8081`, 에이전트 주소도 8081로 |
| 에이전트가 "인증 실패: 에이전트 비밀값이 서버와 다릅니다" | `BINJARI_DEV_AGENT_SECRET`이 서버 화면의 값과 다르다. 서버를 다시 켜면(키를 고정하지 않았으면) 값이 바뀐다 → 4.1절처럼 고정 |
| 대시보드에서 작업 가능 '아니오' | 에이전트를 `--always-available` 없이 켰다 |
| 질문이 `503 no_capacity` | 30초 안에 그 모델을 가진 대기 PC가 없었다 → 모델 ID(`qwen2.5-0.5b`)가 에이전트 화면의 ID와 같은지, PC가 '대기'인지 확인 |
| 질문이 `404 model_not_found` | 아직 어떤 에이전트도 그 모델을 알리지 않았다 → 모델 이름 불일치(`:` 대신 `-`) |
| 에이전트 화면에 "작업 실패: runtime_start_failed", 질문은 `502 node_failed` 또는 `503` | 친구 PC에서 Ollama가 꺼져 있다 → Ollama 앱을 켜거나 `ollama serve`. 실패한 질문은 같은 PC에 다시 맡기지 않고 다른 PC로 넘긴다. 세 PC에서 실패하면 `502`, 넘길 PC가 30초 안에 없으면 `503`으로 끝나고, 어느 쪽이든 과금되지 않는다 |
| 에이전트에 "작업 실패: model_load_failed" | 그 PC에 모델이 없다 → `ollama pull <모델 이름>` |
| 답이 아주 느림 | CPU로 돌고 있다(5.3절 `ollama ps`). 더 작은 모델을 쓰거나 `max_tokens`를 줄인다 |
| `401 invalid_api_key` | `Authorization: Bearer <API 키>`가 서버 화면의 API 키와 다르다 |
| 서버를 다시 켰더니 장부가 비었다 | 기본 DB가 임시 Postgres다. 계속 쓰려면 로컬 Postgres를 `DATABASE_URL`로 지정 |

## 8. 끝내기
1. 친구 PC: 에이전트 창에서 Ctrl+C.
2. 내 PC: 서버 창에서 Ctrl+C(임시 DB도 지워진다). 터널을 썼다면 터널도 Ctrl+C.
3. 방화벽 규칙을 추가했다면 지운다.

## 9. 결과 알려 주기
`HUMAN_TODO.md`의 'S04 친구 PC 데모' 항목을 체크하고, 다음을 Claude에게 알려 주면 `docs/stages/S04/REPORT.md`와 [KNOWN_UNKNOWNS](KNOWN_UNKNOWNS.md) K17에 반영한다.
- PC 몇 대가 붙었는지, 질문 몇 개를 보냈고 몇 개가 완료됐는지
- PC마다 GPU 모델과 `ollama ps`의 `PROCESSOR` 값(GPU/CPU)
- 막힌 곳과 그때의 에이전트·서버 화면 메시지(질문 내용은 빼고)
