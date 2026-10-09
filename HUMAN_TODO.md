# 사람이 할 일

> Claude가 할 수 없거나 해서는 안 되는 일이다. 각 차수가 여기에 항목을 추가한다.
> 끝난 항목은 `[x]`로 바꾸고, 결과(측정값 등)는 해당 차수 REPORT나 BUSINESS_CONTEXT에 적거나 Claude에게 알려 준다.

## 지금 (첫 실행 전)
- [ ] 새 폴더(저장소)를 만들고 이 묶음의 파일을 그대로 넣는다. → START_HERE.md 1~3절
- [ ] Claude Code를 설치하고 로그인한다. 긴 차수용으로 모델을 Opus로, effort를 높게 설정한다(방법은 `/help`, `/model`에서 확인).
- [ ] `.claude/settings.json`의 허용 명령을 훑어보고, 내 환경에서 괜찮은지 확인한다(`/permissions`).
- [x] (권장) GitHub에 비공개 저장소를 만들고 원격(origin)으로 연결한다. Windows CI가 자동으로 돌아서 에이전트 검증이 훨씬 좋아진다.
- [ ] S00은 자리에 있을 때 `/stage S00`으로 실행한다(도구 설치·권한 확인창이 뜰 수 있다).

## S00에서 추가
- [x] (S00) GitHub 원격(origin)을 연결하고 push한다. 아직 원격이 없어서 CI가 한 번도 돌지 않았다. 절차: GitHub에 비공개 저장소 생성 → `git remote add origin <주소>` → `git push -u origin master`. 결과: Actions 탭에서 `ci` 워크플로의 `linux`(pnpm verify, Go 필수)와 `windows`(Go 테스트) 잡이 초록인지 확인한다. 실패하면 로그를 `docs/stages/S00/REPORT.md`의 '막힌 것'에 붙이거나 Claude에게 알린다. — 완료(2026-10-08): origin = songhojin0525/BINjari(비공개). 첫 CI에서 리눅스 전용 버그(verify.mjs 경로 처리)가 드러나 f73b468로 고쳤고, 재실행에서 전체 초록 확인.
- [x] (S00) 저장소 루트의 `board-web.cmd`를 확인한다. S00 밖에서 만들어진 `scripts/board-web.cmd`의 복사본이고, 루트에서 실행하면 상위 폴더로 이동해서 동작하지 않는다. git 추적에서는 뺐다. 필요 없으면 지운다. 보드는 `scripts\board-web.cmd`로 연다. — 완료(2026-10-08): 루트 복사본은 동작하지 않아 사람의 요청으로 지웠다. 보드는 `scripts\board-web.cmd`로 연다.
- [ ] (S00) `.claude/settings.json` 허용 목록에 추가할 명령을 검토한다(REPORT의 '추가 권장 허용 명령').

## S01에서 추가
- [ ] (S01, 파일럿 전까지) `docs/THREAT_MODEL.md` 7절의 '수용한 위험' 8건(AGT-12, PC-06, PC-07, EXT-04, DATA-05, DATA-07, ECO-01, ECO-03)을 읽고 받아들일지 정한다. 왜: 막지 않기로 한 위험이고, 구매자·사장님 안내문에도 그대로 적힌다. 절차: 각 행의 '완화책'과 사유를 읽는다 → 받아들일 수 없는 행은 Claude에게 "S01 수용 위험 재검토: <ID>"로 알린다. 결과: S28 보고서(`docs/SECURITY_REVIEW.md`)에 동의 날짜를 남긴다.
- [ ] (S01, 파일럿 섭외 때) 매장에 미리 물어볼 것(`docs/KNOWN_UNKNOWNS.md` K3·K13·K14): 손님 없는 밤에 PC를 끄는지, 쓰는 PC방 관리(요금) 프로그램과 복원 솔루션 이름, 복원되지 않는 드라이브가 있는지, GPU 모델. 왜: PC를 끄거나 전부 복원되는 매장은 설계 대안(Wake-on-LAN, 영구 드라이브 요구)이 먼저 필요하다. 결과: 답을 Claude에게 알려 주면 KNOWN_UNKNOWNS에 반영한다.

## S03에서 추가
- [ ] (S03) 다음 push 뒤 GitHub Actions `ci`에 새로 생긴 `postgres` 잡(Postgres 16 서비스 컨테이너, `DATABASE_URL` 경로로 서버 DB 테스트)이 초록인지 확인한다. 왜: 로컬에서는 embedded-postgres를 별도 서버로 띄워 `DATABASE_URL` 경로를 확인했지만, 실제 `postgres:16` 이미지 서비스로는 CI에서만 돈다. 절차: Actions 탭 → 최신 `ci` 실행 → `linux (server tests on a Postgres service)` 잡. 결과: 실패하면 로그를 Claude에게 알리거나 `docs/stages/S03/REPORT.md` '막힌 것'에 붙인다.
- [ ] (S03, 운영 DB를 고를 때 · S30 전) 쓰려는 관리형 Postgres(예: Supabase)의 관리 계정이 역할을 만들 수 있는지(`CREATEROLE`) 확인한다. 왜: 마이그레이션 `0002_app_role`이 최소 권한 역할 `binjari_app`을 만들고, 서버는 그 역할의 멤버로만 접속해야 원장 보호 트리거를 끌 수 없다(docs/DB.md 5절). 권한이 없으면 마이그레이션이 실패한다. 절차: 관리 계정으로 접속해 `SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user;` → `t`인지 확인. `f`면 제공사 콘솔에서 `CREATE ROLE binjari_app NOLOGIN;`을 먼저 실행할 수 있는지 확인. 결과: S30 진행 전에 Claude에게 알려 준다(런북에 반영).

## 나중에 (차수가 진행되면 각 차수가 구체적인 절차를 추가한다)
- [ ] Windows PC + NVIDIA GPU에서 실기 확인 (S18~S22, `docs/manual-tests/`)
- [ ] 친구 PC 2~3대로 0단계 데모 (S04, `docs/DEMO_0.md`)
- [ ] 오픈소스 모델 후보 확정과 라이선스 확인 (S09, `docs/MODEL_CANDIDATES.md`)
- [ ] 실제 GPU에서 모델별 처리량(tokens/s)·전력 측정 → 경제 시뮬레이터 갱신 (S19 → S07)
- [ ] (선택) Anthropic API 키로 실제 환전 연동 1회 확인 — 비용이 들 수 있음 (S16)
- [ ] 코드 서명 인증서 준비 (백신 오탐·SmartScreen 경고 감소, 파일럿 전 권장) (S21)
- [ ] 서버·DB·저장소 계정 만들기와 실제 배포 (S30)
- [ ] 법률 검토: 선불 크레딧의 법적 성격, 디지털자산기본법 진행 상황, 외부 모델 재판매 약관 (S06, S16, S31)
- [ ] 사업자 등록, PC방 파일럿 매장 섭외 (S31)
