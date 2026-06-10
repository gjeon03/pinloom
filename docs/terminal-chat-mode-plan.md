# pinloom — Terminal-Chat Mode 구현 플랜 (체크리스트)

> **상태**: planned (구현 미시작). 작성 2026-06-10.
> **목표**: AI 세션을 **실제 터미널(xterm.js)에 claude/codex TUI를 띄우는** 방식으로도 쓸 수 있게 한다.
> 터미널 에뮬레이터가 pty 스트림을 실시간 렌더하므로 **스트리밍이 공짜**, transcript 파싱·완료감지·키스트로크 주입 같은 fragile한 부분이 **디스플레이에선 불필요**. 인터랙티브(주간) 버킷도 그대로.
> **기존 SDK / PTY-어댑터 모드는 버리지 않는다.** 환경변수로 3-way 선택.

## 0. 왜 이 방향인가 (배경)

- transcript 기반 PTY-어댑터(현 PR #97)는 **구조적으로 비스트리밍** — claude가 생성 완료 후 transcript에 한 번에 쓰기 때문(실측: 생성 ~10s 동안 파일 정지 → 끝에 기록). 그래서 "다 끝나야 우르르" → 체감 느림.
- `-p`/SDK는 스트리밍되지만 **$200 프로그래매틱 버킷**(6/15 분리 대상). 인터랙티브 버킷을 쓰려면 진짜 TUI여야 함.
- **유일하게 "인터랙티브 버킷 + 스트리밍"을 동시에** 얻는 길 = TUI를 터미널 에뮬레이터로 그대로 렌더. 이게 이 플랜.

## 1. 실행 모드 (3-way, env 스위치, 기본 SDK)

`PINLOOM_CLAUDE_TRANSPORT` 를 확장 (현재 `pty` 만 분기):

| 모드 | 값 | 디스플레이 | 버킷(6/15후) | 스트리밍 | 용도 |
|---|---|---|---|---|---|
| **SDK** (기본) | unset / `sdk` | 구조화 ChatView | $200 프로그래매틱 | ✅ | 현행 유지, 무회귀 |
| **PTY 어댑터** | `pty` | 구조화 ChatView | 인터랙티브 | ❌(비스트리밍) | auto-owned 워커/teams 구동에 활용 |
| **Terminal** (신규) | `terminal` | **xterm.js 터미널** | 인터랙티브 | ✅(터미널 렌더) | 사람 세션 기본 후보 |

- [ ] `PINLOOM_CLAUDE_TRANSPORT` 값 파싱을 `sdk|pty|terminal` 로 확장 (`agents/index.ts`)
- [ ] 모드를 **프론트에서 알 수 있게** 노출: `GET /api/config` 에 `{ claudeTransport }` 추가 (신규 경량 라우트 or 기존 settings 응답에 포함)
- [ ] 미래 메모: 세션별 override(UI 토글)는 범위 밖 — 지금은 글로벌 env

## 1.5 스파이크 결과 + 선행조건 (critic 리뷰 반영)

### 스파이크 결과 (실측)
- **Stop hook 페이로드**: `{ session_id, transcript_path, cwd, permission_mode, effort:{level}, hook_event_name, stop_hook_active, last_assistant_message, background_tasks, session_crons }`. → **`last_assistant_message` 로 디스패치 답을 페이로드에서 직접** 얻음. `session_id` 로 transcript 파일을 dir-diff 없이 특정(M2 해결).
- **DB 격리**: `PINLOOM_DB_PATH` env 이미 지원 + `PINLOOM_TEST_MODE=1` 가드(기본경로면 거부). dev/test 는 `PINLOOM_DB_PATH=data/pinloom.dev.sqlite` 로. 운영 DB 무영향.
- `--resume <id> "prompt"` 자동 실행, settled TUI 주입 OK, fresh TUI 주입 불가 — #97 검증분.

### Phase 0.5 — 선행 리팩터 (BLOCKER 해소, 구현 전 필수, 테스트 포함)
- [ ] **공유 persist 모듈 추출** (M1): `runner.ts` 의 `persistMessage`/`closeStream`/스트림 브로드캐스트를 `services/message-persist.ts` 로 추출. **messages 행에 `transcript_uuid` 컬럼 추가**(마이그레이션) → runner 와 캡처가 **공유 dedupe 키**. 세션당 **단일 writer 불변식** assert.
- [ ] **공유 launch-spec 추출** (M3): `node-session.ts` 의 플래그/temp settings/forwarder/mcp/system-prompt 빌드를 `claude-pty/launch-spec.ts` 로 추출 → SDK·PTY어댑터·터미널·캡처가 동일 소스.
- [ ] **캡처 전용 커서**(B4): `last_synced_message_id`(wiki-sync 소유, 건드리면 wiki 깨짐) **재사용 금지**. 신규 컬럼 `sessions.last_captured_transcript_uuid` 또는 `transcript_capture(session_id,uuid)` seen 테이블 + 마이그레이션.
- [ ] **Stop-hook 서버 확장**: 현재 void 해제 → **페이로드 전체(`last_assistant_message` 등) 를 waiter 에 전달**. 키는 `session_id` 유지하되 **단일-운전자 락으로 동시 턴 1개 보장**(B1).
- [ ] **세션별 transport 저장**(m2): 글로벌 env 가 아니라 세션 생성 시점의 transport 를 `sessions.transport` 컬럼에 고정 → env 중간 변경에도 세션 연속성. pane 결정도 이 값 기준.
- [ ] **pty 통합 예산**(m3): 프로젝트 셸 + agent-terminal 을 단일 cap 으로.
- [ ] 스파이크: `/model`·`/effort` 슬래시 커맨드 실재 확인(m1)

## 2. 핵심 아키텍처 — 디스플레이와 데이터 캡처 분리

```
디스플레이 (사람이 봄)     →  세션 전용 터미널(xterm.js)에 claude/codex TUI   ← 스트리밍 공짜
데이터 캡처 (백그라운드)   →  세션 transcript(JSONL) → pinloom SQLite messages  ← 핀/히스토리/알림/teams
                            (비스트리밍·턴 끝에 일괄 = 영속화엔 전혀 문제 없음)
완료 신호                 →  Stop hook(localhost) → chat-done 알림 + 캡처 확정
auto-owned 워커(teams)    →  claude-pty 어댑터(주입+완료감지) 유지              ← #97 자산 재활용
```

**원칙**: 사람은 터미널에 **직접 타이핑**(키스트로크 주입 안 함 = fragile 제거). 구조화 기능은 백그라운드 캡처가 받친다.

## 3. 결정 필요 (구현 전 확정할 것)

- [ ] **D1 입력 UX**: 터미널 모드에서 사용자는 (a) **xterm에 직접 타이핑**(터미널 그대로, pinloom 입력창 숨김) vs (b) pinloom 입력창 유지 + 터미널로 주입. → **권장 (a)** (사용자 의도 "터미널환경 그대로", 주입 fragility 회피). 이미지/멘션 등 입력창 기능은 (a)에선 빠짐 → 별도 보조 입력으로 후속.
- [ ] **D2 히스토리 표시**: 터미널 모드 디스플레이는 **터미널 scrollback**(세션별 생존). 캡처된 DB 메시지는 핀/검색/알림/teams용 — 화면엔 안 겹쳐 띄움(터미널이 곧 뷰). 확인 필요.
- [ ] **D3 트러스트 다이얼로그**: 새 프로젝트 cwd에서 claude 첫 실행 시 "trust this folder"가 터미널에 뜸. (a) 사람이 직접 Enter (터미널이니 자연스러움) vs (b) 세션 시작 시 `~/.claude.json` 에 프로젝트 trust 선반영. → **권장 (a)** + 선택적 (b) 헬퍼.
- ~~D4 모델/effort 변경~~ **해소됨**: 터미널 모드에선 TUI의 **슬래시 커맨드(`/model`, `/effort`)로 사용자가 실행 중 직접 변경** → 재시작 불필요. pinloom은 **시작 시 초기값만** `--model`/`--effort` 로 넘기고, 이후는 터미널이 소스 오브 트루스. (pinloom DB의 model/effort 값은 "초기값"일 뿐 `/model` 변경과 drift 가능 — 터미널 모드에선 pinloom 피커 미표시, 무방.) "터미널환경 그대로" 철학과 일치: TUI의 모든 네이티브 컨트롤(`/clear`, `/model`, `/effort`, `/resume` 등)을 그대로 사용.

## 4. Phase 0 — 설정 배관

- [ ] `agents/index.ts`: `claudeTransport(): 'sdk'|'pty'|'terminal'` 헬퍼 (env 파싱), 기존 `claudeTransportIsPty()` 는 `=== 'pty'` 로 유지
- [ ] `getAgentAdapter`: `pty` → claudePtyAdapter, 그 외(`sdk`/`terminal`) → claudeAdapter. (terminal 모드의 "사람 세션"은 어댑터를 안 쓰고 터미널로 가지만, auto-owned 워커/폴백은 SDK 사용 → 아래 Phase 5)
- [ ] `GET /api/config` 라우트 + 프론트 `useConfig()` 훅 (SWR, 1회 fetch)
- [ ] 테스트: `getAgentAdapter`/`claudeTransport` 3값 단위테스트 (기존 index.test.ts 확장)

## 5. Phase 1 — 세션 전용 Agent 터미널 (백엔드)

기존 `terminal.ts` 는 **프로젝트 단위 셸**. 신규는 **세션 단위 + 에이전트 CLI 자동 실행**. 별도 서비스로.

- [ ] `services/agent-terminal.ts` 신규 (terminal.ts 패턴 차용):
  - [ ] 키: `session:${sessionId}` (프로젝트 셸과 분리)
  - [ ] `attachAgentTerminal(sessionId, cols, rows, onData, onExit)`:
    - 세션 컨텍스트 로드(cwd, agent, agent_session_id, model, effort, systemPrompt, mcpServers) — runner 의 `toSessionContext` 재사용/추출
    - 첫 attach 시 `pty.spawn` 로 **claude/codex 자동 실행** with 플래그:
      - claude: `--append-system-prompt <pinloom 시스템프롬프트>`, `--model`, `--effort`, `--mcp-config <temp>`, `--dangerously-skip-permissions`, `--settings <temp Stop-hook>` , `--resume <agent_session_id>` (있으면), positional 없음(사람이 타이핑)
      - codex: codex 인터랙티브 실행 플래그(후속 Phase 6)
    - scrollback 버퍼(terminal.ts 의 SCROLLBACK_BYTES 재사용), attachId 세대관리
    - WS 끊겨도 pty 생존(현 terminal.ts 정책과 동일 — 백그라운드 대화 중 리셋 방지)
  - [ ] `writeAgentTerminal(sessionId, data)` / `resizeAgentTerminal` / `killAgentTerminal`
  - [ ] `killAllAgentTerminals()` (셧다운; app.ts onClose 에 추가)
  - [ ] MAX 동시 세션 터미널 cap
- [ ] WS 라우트: `/ws/agent-terminal?session=<id>` (app.ts 의 `/ws/terminal` 핸들러 패턴 복제, 프로토콜 동일 `{t:'i'/'r'}`/`{t:'o'/'x'}`)
- [ ] 시스템프롬프트/mcp 생성 로직을 runner 와 공유(중복 제거): `buildAgentLaunchSpec(sessionCtx)` 추출 → SDK 어댑터·PTY 어댑터·터미널이 같은 소스 사용
- [ ] 트러스트(D3): 선택적 pre-accept 헬퍼

## 6. Phase 2 — 프론트 AgentTerminal pane (모드 인지)

- [ ] `components/AgentTerminal.tsx` 신규 (Terminal.tsx 복제 + 세션 소켓):
  - [ ] `/ws/agent-terminal?session=<id>` 연결, xterm.js + FitAddon
  - [ ] pinloom 테마(색/폰트) 적용
  - [ ] 입력 = xterm.onData → `{t:'i',d}` (D1-a: 직접 타이핑)
  - [ ] 재연결/exited 오버레이(Terminal.tsx UI 재사용)
- [ ] `ProjectPage.tsx` pane 분기 확장: `activeSession && claudeTransport==='terminal'` → `<AgentTerminal sessionId>` 렌더 (아니면 기존 `<ChatView>`)
- [ ] 세션 전환 시 터미널 생존(프로젝트 셸처럼) — scrollback replay 로 연속성
- [ ] (선택) 상단에 "터미널 모드" 배지 + SDK/구조화로 보기 토글은 후속

## 7. Phase 3 — 백그라운드 transcript → SQLite 캡처

목표: 핀/히스토리/알림/teams 가 계속 동작하도록 **서버에서** 세션 transcript 를 따라가며 메시지를 DB에 영속화. (#97 의 claude-jsonl 파서 재활용)

- [ ] `services/transcript-capture.ts` 신규:
  - [ ] **session_id 는 Stop-hook 페이로드에서** 취득(M2) — dir-diff `discoverNewSessionFile` 안 씀(멀티-claude 프로젝트에서 모호성 throw). 첫 턴 후 `sessions.agent_session_id` 갱신
  - [ ] Stop hook 수신 시 페이로드의 `transcript_path` 로 파일 열고, **마지막 캡처 uuid 이후 새 라인**을 `selectTurnLines`(uuid-diff)로 추출 → `NormalizedEvent` → **공유 persist 모듈(Phase 0.5)** 로 messages persist
  - [ ] **멱등성**: 각 행에 `transcript_uuid` 저장 + `sessions.last_captured_transcript_uuid` 커서 전진. runner 와 **동일 dedupe 키** 공유 → 이중 writer 충돌 방지(M1)
  - [ ] **단일 writer 불변식**: 세션은 transport(`sessions.transport`)에 따라 runner-구동 **또는** 터미널-캡처 중 하나만. 둘이 같은 세션에 동시 기록 금지
  - [ ] 턴 완료 시 `run_status finished` 브로드캐스트 → **chat-done 알림**(기존 파이프)
  - [ ] tool_use/tool_result/thinking 캡처(매핑 기존)
  - [ ] `created_at` 순서: 캡처는 턴 종료 시점 기록이라 transcript `timestamp` 를 행에 반영(insert-time 아님)해 순서 보존(M1)
- [ ] 이미지 입력: 사람이 터미널에 `@경로` or 붙여넣기 → claude 가 처리, 캡처는 transcript 기반이라 자동 반영
- [ ] 단위테스트: 픽스처 transcript → 캡처된 messages 행 검증(파서는 이미 테스트됨, 영속화 경로 추가)

## 8. Phase 4 — Lifecycle / resume / 생존

- [ ] 백엔드 재시작: onClose 에서 `killAllAgentTerminals()` + `shutdownClaudePty()`; 재시작 후 세션 열면 `--resume <agent_session_id>` 로 재개
- [ ] 탭 닫기 → `killAgentTerminal`; 다시 열기 → resume 재개
- [ ] 세션 idle 시 정책(프로젝트 셸은 reaper 제거됨 — 동일 정책: 명시적 종료까지 생존). 메모리 누적 모니터
- [ ] orphan 방지: 그룹 SIGHUP→SIGKILL(terminal.ts killGroup 패턴)
- [ ] **재시작 복구 계약**(m5): 재시작 중 in-flight 디스패치는 Stop 대기 reject → 오케스트레이터 타임아웃(idle=false 관측). 재시작 후 워커는 `--resume` 로 재개하되 **그 in-flight 턴의 답은 캡처가 이미 썼으면 보존, 아니면 유실** 명문화

## 9. Phase 5 — Teams / 워커 (워커 터미널에 주입)

**핵심**: 워커도 **first-class 터미널 세션 그대로** 두고, 오케스트레이터 디스패치는 **워커의 이미 떠 있는(settled) 터미널에 프롬프트 주입**으로 처리. (안정된 TUI 주입은 #97에서 검증됨; 갓 뜬 TUI만 불안정했음.) → 설계의도(가시성·직접대화·디스패치) 전부 보존, subagent 금지 원칙 준수.

```
오케스트레이터 터미널(사람+claude, pinloom MCP)
   │ team_ask(@be, "...")  ← MCP 툴, 터미널에서 그대로 호출
   ▼
워커 @be 터미널 (settled)
   → busy 락 획득 → 프롬프트 주입 → Stop hook 완료감지 → transcript에서 답 추출 → 반환
   → 사람은 워커 터미널에서 실시간 관전
```

- [ ] **단일-운전자 write 락**(B1+B3): agent-terminal write 레이어에 세션별 락. **사람 WS 입력과 디스패치 주입 둘 다 이 락을 통과**. 동시 턴 1개 보장:
  - [ ] 사람 제출(`\r` 감지) → 락 획득 → 그 턴 Stop 시 해제
  - [ ] 디스패치 → 락 획득(점유 중이면 대기/큐). 획득 못 하면 사람 턴 끝날 때까지 블록
  - [ ] **디스패치 점유 중 사람 WS write 차단** + 프론트에 "오케스트레이터 구동 중, 입력 잠금" 표시(silent 입력 먹힘 금지)
- [ ] **터미널-인지 디스패치 경로**(B2): `team-dispatch.ts` 의 `/ask`·`/ask-tag`·`/status`·`/wait`·`/list` 에 **transport 분기**. 터미널 워커는 `enqueueMessage`/`tryDrainQueue`/`waitForIdle` **안 씀**:
  - [ ] 주입(`submitToTui`, settled) → Stop hook 대기 → **페이로드 `last_assistant_message` 가 곧 답** → tool_result 반환 (transcript 추가 읽기 불요)
  - [ ] `team_status`/`team_wait` 는 락 상태(busy/idle) 기준으로 재정의
- [ ] **ensure-worker-started 뮤텍스**(M4): 워커 터미널 미기동 시 디스패치가 **idempotent·직렬화된** "기동" 프리미티브 호출 → agent-terminal(사람가시) pty 1개만 spawn + 그 프롬프트를 **그 pty 에 seed**(별도 node-session pty 아님). 동시 디스패치 2개는 이 뮤텍스에서 직렬화(이중 spawn 금지)
- [ ] **오케스트레이터-터미널 MCP 배선**(M5): 오케스트레이터가 터미널일 때 **팀 토큰 발급 + `TEAM_ID`/토큰/base-URL 을 MCP child 에 주입**(현재는 runner 가 함). agent-terminal spawn 시 처리. MCP child 가 백엔드 `/dispatch` 도달 확인
  - [ ] 1차로 **혼합 transport 허용 검증**(SDK 오케스트레이터 + 터미널 워커 등) — 단순한 조합부터
- [ ] 워커가 codex 면 codex 터미널 주입(Phase 6 의존)
- [ ] (후속) 사람용 `/team` 슬래시 래퍼 / 완전 헤드리스 auto-owned 옵션

## 10. Phase 6 — Codex 터미널 (⚠️ 리서치 스파이크, 구현 아님)

codex 는 claude 와 설계가 다름(현 어댑터 = `codex exec --json` 헤드리스). **인터랙티브 TUI·Stop-hook 등가물·transcript 포맷이 전부 미지수** — claude 의 설계가 그대로 안 옮겨감.
- [ ] 스파이크: codex 가 드라이브 가능한 인터랙티브 TUI 를 갖는가? 완료신호는? transcript 위치/포맷은?
- [ ] 결과로 codex 캡처/디스패치 설계 결정. claude 안정화 후 별도 트랙. 추정치에 claude 가정 누설 금지

## 11. Phase 7 — 테마 / (선택) 응답 포매팅

- [ ] xterm 테마를 pinloom 룩에 맞춤(색/폰트/커서)
- [ ] **응답만 재포매팅(채팅 버블화)** 은 보류: TUI 렌더 영역 파싱이 필요 → fragile. 필요 시 별도 평가
- [ ] 스크롤백/검색 UX 점검

## 12. 테스트 전략

- [ ] 단위: 설정 3값 분기, transcript→messages 캡처, buildAgentLaunchSpec
- [ ] 통합(gated): mock-claude 로 세션 터미널 spawn → WS in/out → 캡처 검증 (PR #97 의 mock 하네스 확장)
- [ ] 실제-claude 통합 스크립트(이미 있음, 어댑터용) + 신규 "터미널 모드" 수동 QA 체크리스트
- [ ] 무회귀: `PINLOOM_CLAUDE_TRANSPORT` unset(SDK) 시 모든 기존 동작·테스트 그대로

## 13. 리스크

| 리스크 | 대응 |
|---|---|
| 입력 UX 변화(터미널 직접 타이핑) → pinloom 입력창 기능 상실 | D1 명문화, 보조 입력 후속 |
| 캡처 누락/중복(영속화 정확도) | uuid-diff 멱등 + Stop hook 기준, 픽스처 테스트 |
| 트러스트/모델변경 등 TUI 상태 머신 | D3/D4 명문화, 사람이 직접 처리 가능(터미널이라 자연스러움) |
| transcript 스키마 claude 업데이트로 변경 | 파서 방어적(이미) + 버전 모니터 |
| 글로벌 `~/.claude/settings.json` 오염 | Stop hook 은 temp `--settings` 격리(이미) |
| 제품 정체성 변화(구조화 채팅 → 터미널) | 모드 선택제(env)로 공존, 기본 SDK 유지 |

## 14. 범위 밖

- 응답 채팅-버블 재포매팅(파싱 필요)
- 세션별 모드 UI 토글(지금은 글로벌 env)
- codex 터미널(Phase 6 별도)
- 6/15 빌링 버킷 확정(게이트2 — 이 플랜과 독립)

## 15. 참고 (코드 위치)

- 터미널 백엔드: `packages/backend/src/services/terminal.ts`, WS 라우트 `packages/backend/src/app.ts:128-186`
- 터미널 프론트: `packages/frontend/src/components/Terminal.tsx`
- 채팅/페인: `packages/frontend/src/components/ChatView.tsx`, `pages/ProjectPage.tsx:593-645`
- 영속화/스트림: `packages/backend/src/services/runner.ts`(persistMessage, closeStream, run_status)
- 설정/어댑터: `packages/backend/src/services/agents/index.ts`
- 캡처 재활용: `packages/backend/src/services/claude-jsonl/`, `claude-pty/stop-hook-server.ts`
- 세션 스키마: `packages/backend/src/db/migrations.ts`(sessions.agent / agent_session_id)
