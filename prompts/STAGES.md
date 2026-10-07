# 차수 목록과 의존성

- 상태는 `PROGRESS.md`에서 관리한다. 이 파일은 바꾸지 않는다.
- 의존 차수가 `DONE` 또는 `DONE_NEEDS_HUMAN`이면 다음 차수를 시작할 수 있다.
- 러너는 시작 가능한 차수 중 **번호가 가장 작은 것**을 고른다. 번호 순서는 그대로 유효한 실행 순서다(모든 의존은 앞 번호).
- 권장 모델: Opus = 설계 판단·돈·보안·동시성이 핵심인 차수. Sonnet = 구조가 정해진 구현·화면·문서 위주 차수. 한도가 넉넉하면 전부 Opus여도 된다.
- 사람 필요: `없음` · `시작 시 권장`(도구 설치·권한 확인) · `끝에 선택` · `끝에 실기 확인`(Windows PC + NVIDIA GPU로 직접 확인, 코드는 자동으로 끝남) · `끝에 필수`(계정·결제·섭외 등 사람만 할 수 있는 일)

| ID | 파일 | 이름 | 의존 | 권장 모델 | 규모 | 사람 필요 |
|---|---|---|---|---|---|---|
| S00 | S00_bootstrap.md | 환경·저장소·CI 부트스트랩 | — | Sonnet | M | 시작 시 권장 |
| S01 | S01_architecture.md | 아키텍처·위협 모델·결정 기록 | S00 | Opus | XL | 없음 |
| S02 | S02_protocol.md | 프로토콜 계약 (JSON Schema → TS·Go) | S01 | Opus | L | 없음 |
| S03 | S03_database.md | DB 스키마·마이그레이션·테스트 키트 | S01 | Opus | L | 없음 |
| S04 | S04_walking_skeleton.md | 걷는 뼈대 = 0단계 장난감 | S02, S03 | Opus | XL | 끝에 선택 (친구 PC 데모) |
| S05 | S05_server_foundation.md | 서버 기반: 설정·인증·권한·API 키·감사 | S04 | Sonnet | L | 없음 |
| S06 | S06_ledger.md | 크레딧 원장 (이중기입·홀드·성숙·회수) | S03, S05 | Opus | XL | 없음 |
| S07 | S07_econ_sim.md | 경제 시뮬레이터·기본값 추천 | S01, S06 | Opus | XL | 없음 |
| S08 | S08_pricing_reserve.md | 가격·환율·페그·준비금 가드 | S06, S07 | Opus | L | 없음 |
| S09 | S09_model_registry.md | 모델 레지스트리·서명·토크나이저·라이선스 | S05 | Sonnet | L | 끝에 선택 (모델 후보 확인) |
| S10 | S10_fleet_enrollment.md | 매장·노드 등록·정책·킬스위치 | S02, S05 | Opus | L | 없음 |
| S11 | S11_agent_gateway.md | 에이전트 게이트웨이 (WebSocket) | S10 | Opus | L | 없음 |
| S12 | S12_scheduler.md | 스케줄러·작업 수명주기·과금 | S06, S08, S09, S11 | Opus | XL | 없음 |
| S13 | S13_verification.md | 검증·평판·회수 | S12 | Opus | XL | 없음 |
| S14 | S14_buyer_api.md | 구매자 API (OpenAI 호환·스트리밍) | S12 | Sonnet | L | 없음 |
| S15 | S15_batch_api.md | 배치 API | S14 | Sonnet | M | 없음 |
| S16 | S16_external_models.md | 외부 모델 환전 (Claude API 어댑터) | S08, S14 | Opus | L | 끝에 선택 (실제 키 테스트) |
| S17 | S17_agent_core.md | 에이전트 코어 (Go)·노드 시뮬레이터 | S02, S11 | Opus | XL | 없음 |
| S18 | S18_presence_preemption.md | 손님 감지·즉시 선점 (Windows) | S17 | Opus | XL | 끝에 실기 확인 |
| S19 | S19_runtime_cache.md | 런타임 관리자 (llama.cpp)·모델 캐시 | S09, S17, S18 | Opus | L | 끝에 실기 확인 |
| S20 | S20_pcbang_environment.md | PC방 환경: 복원·이미지 복제·LAN 캐시 | S10, S18, S19 | Opus | XL | 끝에 실기 확인 |
| S21 | S21_update_installer.md | 자동 업데이트·설치 프로그램·Windows CI | S19, S20 | Opus | XL | 끝에 실기 확인 |
| S22 | S22_agent_security.md | 에이전트 보안 강화 | S21 | Opus | L | 끝에 실기 확인 |
| S23 | S23_web_foundation.md | 웹 기반 (Next.js·i18n·인증·E2E) | S05 | Sonnet | L | 없음 |
| S24 | S24_owner_dashboard.md | 사장님 대시보드 | S06, S07, S10, S23 | Sonnet | L | 없음 |
| S25 | S25_buyer_portal.md | 구매자 포털 | S14, S15, S16, S23 | Sonnet | L | 없음 |
| S26 | S26_operator_console.md | 운영자 콘솔 | S08, S09, S13, S21, S23 | Sonnet | L | 없음 |
| S27 | S27_system_e2e.md | 전체 시스템 테스트·카오스 | S13, S16, S17, S24, S25, S26 | Opus | XL | 없음 |
| S28 | S28_security_audit.md | 보안 감사 | S22, S27 | Opus | XL | 없음 |
| S29 | S29_observability_ops.md | 관측·운영 런북·백업 | S27, S28 | Sonnet | M | 없음 |
| S30 | S30_deploy_release.md | 배포·릴리스 파이프라인 | S29 | Sonnet | L | 끝에 필수 (실제 배포) |
| S31 | S31_pilot_kit.md | PC방 파일럿 키트 | S30 | Opus | L | 끝에 필수 (매장 섭외) |
| S32 | S32_release_v010.md | 최종 정리·v0.1.0 | S28, S31 | Sonnet | M | 없음 |

## 묶음별 의미
- **기반 (S00~S04)**: 저장소·설계·계약·DB, 그리고 S04에서 처음으로 "남의 PC가 답하고 장부에 남는" 0단계 장난감이 돌아간다.
- **서버 핵심 (S05~S13)**: 돈(원장·가격·준비금), 노드 관리, 작업 배정, 검증. 이 사업의 심장.
- **구매자·외부 모델 (S14~S16)**: OpenAI 호환 API, 배치, Claude 환전.
- **Windows 에이전트 (S17~S22)**: PC방 PC에서 실제로 도는 프로그램. 코드와 자동 테스트는 스스로 끝나지만, 실제 PC·GPU 확인은 사람이 한다.
- **웹 (S23~S26)**: 사장님·구매자·운영자 화면.
- **통합·출시 (S27~S32)**: 전체 시스템 시험, 보안 감사, 운영, 배포, 파일럿 준비, v0.1.0.

## Windows 실기 확인 묶음
S18~S22는 코드가 자동으로 끝나도 실제 Windows + NVIDIA GPU에서 확인해야 한다. 각 차수가 `docs/manual-tests/SNN.md`에 체크리스트를 남긴다. 사람이 PC 앞에 있을 때 한 번에 몰아서 확인하면 효율적이다. 결과는 Claude에게 "S18 실기 결과: ..."처럼 알려 주면 반영한다.
