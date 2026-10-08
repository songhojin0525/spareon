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
- [x] (S00) 저장소 루트의 `board-web.cmd`를 확인한다. S00 밖에서 만들어진 `scripts/board-web.cmd`의 복사본이고, 루트에서 실행하면 상위 폴더로 이동해서 동작하지 않는다. git 추적에서는 뺐다. 필요 없으면 지운다. 보드는 `scripts\board-web.cmd`로 연다. — 완료(2026-10-08): 사람이 확인하고 남겨 두기로 함. 작업 트리가 깨끗하게 보이도록 .gitignore에 추가.
- [ ] (S00) `.claude/settings.json` 허용 목록에 추가할 명령을 검토한다(REPORT의 '추가 권장 허용 명령').

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
