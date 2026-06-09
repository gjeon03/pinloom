# pinloom — Dual-Bucket (Interactive + SDK) 라우팅 구현 플랜

> **상태**: foundation 작업 진행 중 (feature 브랜치 `feat/billing-dual-bucket-foundation`).
> **트리거**: 2026-06-15 Anthropic Agent SDK 빌링 분리 — `claude -p` / Agent SDK 사용량이
> 구독 주간 한도에서 분리돼 별도 $200/월 SDK 크레딧으로 과금.
> **상위 전략 문서**: `~/gy_jeon/obsidian-vault/03_Projects/pinloom/billing-pty-migration-plan.md`
> (critic·architect·codex 3-에이전트 리뷰 반영본). 이 문서는 그 전략을 **현재 코드 기준으로
> 실측 갱신 + 구현 수준으로 상세화**한 것.

## 0. 한 줄 요약

목표는 **"SDK 제거"가 아니라 두 과금 버킷(주간 인터랙티브 한도 + 이미 낸 $200 SDK 크레딧)을
모두 사용 가능하게 만드는 것**. 인터랙티브 버킷을 쓰려면 `claude`를 인터랙티브 모드로 구동해야
하고, 그 후보가 (A) OAuth `-p` 구조화 모드 또는 (B) PTY로 TUI 구동. **어느 쪽이 필요한지는
6/15 게이트 실증으로 결정**한다.

## 1. 선결 게이트 (PRE-BUILD) — 6/15에 실증, 빌드 범위를 결정

3-에이전트 리뷰의 핵심 교훈: **정교한 PTY 기계를 짓기 전에 더 싼 답이 있는지부터 실증.**
아래는 `scripts/billing-gates/` 에 실행 스크립트로 준비됨 (6/15 전 실행 금지 — 실제 사용량 소모).

| # | 게이트 | 통과 시 결과 | 스크립트 |
|---|---|---|---|
| 1 | 현재 SDK 월 지출 < $200 ? | Stage 0만으로 충분, **PTY 불필요** | `measure-sdk-spend.mjs` (read-only, 지금 실행 가능) |
| 2 | OAuth `-p`가 **인터랙티브 버킷**인가? | PTY 전체 불필요, **인증 한 줄 + 라우팅**으로 끝 | `gate2-oauth-bucket.mjs` |
| 3 | `-p --input-format stream-json` keep-alive가 인터랙티브 버킷인가? | TUI fragility 없이 구조화 I/O 유지 | `gate3-streamjson-keepalive.mjs` |
| 4 | workload 라우팅(장문/병렬→SDK, 짧은 iterative→interactive)만으로 두 버킷 분산되나? | PTY 복잡도 0으로 목표 달성 | `gate4-workload-routing.md` (분석 가이드) |

**의사결정 트리**:

```
게이트1 통과(지출<$200)  → 끝. 모델 다이어트(Stage 0)만 유지.
게이트2 통과(OAuth -p = interactive) → claude-oauth-p 어댑터(codex 패턴 복제) + 라우팅. PTY 안 만듦.
게이트3 통과               → 위와 동일, keep-alive 구조화.
모두 실패 + 지출>$200      → PTY 어댑터 빌드 (Stage 2, 아래 6절). 이때 이번에 만든
                            JSONL 파서 + 완료감지 엔진 + mock 하네스가 이미 준비됨.
```

## 2. 이번 작업(오늘 밤)의 범위 — 게이트와 무관하게 가치 있는 것만

ToS-안전(실제 claude 구동 안 함), 무회귀(라이브 미등록), 게이트 결과와 무관하게 재사용되는 것:

1. **이 플랜 문서** + 멀티에이전트 리뷰 반영
2. **게이트 스크립트 4종** (6/15 실행 준비, 실제 사용량 소모 경고 헤더)
3. **Stage 0**: `measure-sdk-spend.mjs` (기존 `~/.claude/projects/*.jsonl`의 usage 토큰 합산으로
   현재 SDK 지출 추정 — read-only, 게이트1 입력) + OAuth/status 체크리스트
4. **`claude-jsonl` 파서 모듈** + 유닛테스트 — JSONL 한 줄 → `NormalizedEvent`,
   parentUuid 체인 "이번 턴" 추출, 노이즈 필터. **PTY 완료감지에도, 이슈 #21 사용량바에도 재사용.**
5. **mock-claude 하네스 + 완료감지 엔진** + 테스트 — 실제 claude/토큰 없이 결정론적으로
   주입→Stop hook→턴 추출→반환 로직 검증 (가장 위험한 로직을 미리 못 박음)

**명시적 제외(6/15 게이트 뒤)**: 실제 `claude` PTY 구동, 어댑터 라이브 등록(`getAgentAdapter`),
기본값 PTY 전환, UI 버킷 배지, Teams PTY 자동화.

## 3. 현재 코드 실측 (5/28 전략 문서 대비 갱신)

- ✅ **node-pty `^1.1.0` 이미 정식 의존성** (`packages/backend/package.json`). 5/28 "미설치" 해소.
- ✅ **`terminal.ts`에 검증된 PTY 패턴**: `pty.spawn`(108), scrollback 버퍼(123), 다중 attach
  세대관리(attachId), 종료 시 그룹 SIGHUP→SIGKILL(`killAllTerminals` 198-226). PTY 어댑터가
  프로세스 lifecycle을 여기서 그대로 차용 가능.
- ✅ **`AgentAdapter` 계약이 작음** (`agents/types.ts`): `run(args) → {events, pushMessage, close}`.
  `NormalizedEvent` 유니온(session_id/text_delta/thinking_*/tool_use/tool_result/text_block_end/
  turn_complete/final_text_fallback/model). PTY 어댑터는 이 계약만 충족하면 runner 무수정.
- ✅ **codex 어댑터 = PTY 어댑터의 청사진**: 멀티턴 resume 루프(297-499), 라인버퍼
  `parseLines`(281-295), 이미지 temp 파일(264-279), temp config home(118-163), abort→SIGTERM(231-241).
- ✅ **claude SDK 어댑터 = 복제할 이벤트 계약**: turn 회계(turn_complete/text_block_end/
  final_text_fallback), prompt-cache static/dynamic split(`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`).

## 4. JSONL 스키마 (실측, 파서 설계 근거)

`~/.claude/projects/<slug>/<sessionId>.jsonl` — 한 줄당 한 이벤트:

- **top-level `type`**: `assistant` | `user` | `attachment` | `file-history-snapshot` | `system` |
  `pr-link` | `permission-mode` | `ai-title` | `last-prompt` | `agent-name` | `queue-operation` | `mode`
  → 뒤 8종은 CLI/pinloom 메타데이터 **노이즈(파서가 무시)**.
- **공통 체이닝 필드**: `uuid`, `parentUuid`, `sessionId`, `timestamp`, `isSidechain`(subagent),
  `requestId`(assistant only), `cwd`, `gitBranch`, `version`.
- **`assistant`**: `message.content[]` = `text` | `thinking{thinking,signature}` |
  `tool_use{id,name,input,caller}` | `image`; `message.usage{input_tokens, output_tokens,
  cache_creation_input_tokens, cache_read_input_tokens, ...}`; `message.model`; `message.stop_reason`.
- **`user`**: `message.content` = string | `tool_result{tool_use_id, content, is_error}[]`.
- **`<synthetic>` model**: compaction/에러 합성 메시지 → 토큰 회계/턴 추출에서 제외.

**"이번 턴" 추출 알고리즘** (완료감지용):
1. 주입 직전 마지막 줄의 `uuid` = `checkpoint`.
2. Stop hook 발화 후 파일을 tail → `checkpoint` 이후 추가된 줄만 수집.
3. `parentUuid` 체인이 checkpoint로 소급되는 줄만(주입한 프롬프트의 후손) — 동시 주입 방어.
4. `isSidechain:true`(subagent), 노이즈 타입, `<synthetic>` 제외.
5. 남은 assistant/user(tool_result) 줄을 `NormalizedEvent[]`로 매핑.

## 5. 완료감지 (다중 신호, source-of-truth 명시)

| 신호 | 역할 | 비고 |
|---|---|---|
| **Stop hook → localhost** | 주 | `--settings` temp 파일로 격리 — **글로벌 심볼릭 `~/.claude/settings.json` 절대 안 건드림** |
| JSONL 구조(stop_reason + 턴 추출) | 보조/내용 추출 | 파일 tail |
| quiescence (N초 무출력) | fallback | hook 미발화 시 |

- source-of-truth = **Stop hook 수신 시점**; 내용은 JSONL 턴 추출. 둘 불일치 시 hook 우선, 타임아웃 가드.
- 장애: orphan kill(SIGTERM, terminal.ts 패턴), hook 미발화 타임아웃, 중복주입/영구대기 방지.

## 6. PTY 어댑터 (게이트 통과 시에만 — Stage 2 설계)

`claude-pty-adapter.ts` — `AgentAdapter` 구현:
- node-pty로 인터랙티브 `claude` 구동(terminal.ts lifecycle 차용), keep-alive.
- 주입: 프롬프트를 PTY write → checkpoint-uuid 기록 → Stop hook 대기 → JSONL 턴 추출 → `NormalizedEvent` yield.
- 플래그: `--append-system-prompt`/`--model`/`--mcp-config`/`--resume`/`--setting-sources`,
  이미지=temp파일+`@경로`(codex 패턴).
- 세션 lifecycle 정책(codex #3): 컨텍스트 오염 시 폐기/`--resume` 재생성 명문화.
- safety 가드(codex #2): 자동 주입이 민감/승인 작업 무인 실행 안 하도록 차단.
- **shadow mode(codex #7)**: 같은 작업 SDK+PTY 이중 실행/기록 → 성공률·지연·복구율 수집.
  이 데이터 없이 기본값 전환 금지.
- **킬스위치**: 전 세션 즉시 SDK 복귀 글로벌 토글.

## 7. 테스트 전략 (architect F6)

1. **JSONL 파서 = 순수 유닛테스트** (실로그 픽스처 → NormalizedEvent). ← 이번에 구현, 최고 ROI.
2. **mock-claude PTY** — REPL 계약 흉내 스크립트로 주입/완료감지 결정론적 CI 테스트(토큰·auth 안 씀). ← 이번에 구현.
3. **Stop hook 통합테스트** — 가짜 훅 타겟(로컬 HTTP)으로 매 턴 발동 확인. ← 이번에 구현(엔진 레벨).
4. **SDK vs PTY 동등성 하네스** — 같은 프롬프트에 동일 NormalizedEvent 시퀀스 → 폴백 신뢰성. ← Stage 2.

## 8. 단계 / 타임라인

- **Stage 0** (지금): 지출 측정 시작 + 모델 다이어트 + OAuth 토큰/status 확인.
- **이번 밤 (foundation)**: 게이트 스크립트 + JSONL 파서 + mock 하네스 + 완료감지 엔진 (전부 격리/테스트).
- **6/15 Stage 1**: 게이트 4종 실증 → 빌드 여부/범위 결정.
- **Stage 2~4** (게이트 통과 시): 어댑터 라이브 → shadow → 기본값 전환. 킬스위치 + observability.

## 9. 리스크

| 리스크 | 대응 |
|---|---|
| 게이트로 PTY가 불필요/축소될 수 있음 | 이번 밤 산출물은 게이트 무관 재사용분만 (파서=이슈#21, 게이트 스크립트, mock) |
| 실제 claude PTY 구동 = ToS 위반 근접 | 이번 밤 **구동 안 함**. 게이트2 선검증 + 킬스위치는 Stage 2 |
| JSONL 스키마가 claude 업데이트로 변경 | 파서 방어적 파싱 + 버전 필드 모니터 + 픽스처 회귀테스트 |
| 글로벌 settings 오염 | `--settings` temp + `--setting-sources`. `~/.claude/settings.json`=dotfiles 심볼릭, 불가침 |
| 무회귀 | 신규 모듈 격리, `getAgentAdapter` 미수정, UI 무변경, 기존 테스트 그린 유지 |

## 10. 참고 (코드 위치)

- 어댑터 계약: `packages/backend/src/services/agents/types.ts`
- 복제 청사진: `agents/codex-adapter.ts`, `agents/claude-adapter.ts`
- PTY lifecycle: `packages/backend/src/services/terminal.ts`
- 신규: `packages/backend/src/services/claude-jsonl/` (파서), `scripts/billing-gates/` (게이트)
