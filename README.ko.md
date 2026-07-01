# pinloom

[English](README.md) · [한국어](README.ko.md) · [中文](README.zh.md)

로컬 Claude Code 워크스페이스. 영속 히스토리, 고정 답변, 프로젝트 Wiki, Teams 오케스트레이션, GitHub 기반 백업.

![pinloom 워크스페이스](docs/screenshots/05-project-workspace.png)

## 다운로드

소스에서 빌드하지 않고 앱만 받고 싶으신가요?

**[⬇ macOS용 pinloom 다운로드 (Apple Silicon)](https://github.com/gjeon03/pinloom/releases/latest)**

서명되지 않은 빌드입니다 — 처음 실행할 때 앱을 우클릭 → **열기** (또는 **시스템
설정 → 개인정보 보호 및 보안 → 그래도 열기**). 여전히 Claude Code CLI가 설치되어
있고 로그인되어 있어야 합니다. 직접 빌드하고 싶으신가요? [빠른 시작](#quick-start)과
[`packages/desktop`](packages/desktop/README.md)을 참고하세요.

## 왜 필요한가

Claude Code의 CLI는 훌륭하지만 `~/.claude/` 초기화, SDK 업그레이드, 기기 이동 시 세션 컨텍스트를 잃어버립니다. pinloom은 대화, 프로젝트별 노트, 팀 구성을 자체 로컬 SQLite + 파일시스템에 보관하여 이 모든 상황에서도 살아남게 합니다.

## 무엇을 얻는가

- **영속 대화 히스토리.** 모든 메시지와 도구 호출이 pinloom 자체의
  SQLite에 미러링되므로, `~/.claude/` 초기화, SDK 버전 업그레이드,
  기기 이동에도 히스토리를 절대 잃지 않습니다.
- **고정 답변.** 어시스턴트 메시지를 우클릭 → "Pin". 사이드 패널에
  도킹되어 계속 대화하는 동안에도 보이는 상태로 유지되므로, 정작
  필요한 한 줄짜리 답변이 200개의 메시지 너머로 스크롤되어 사라지지
  않습니다.
- **에이전트가 매 턴 읽는 영속 Wiki.** `~/.pinloom/wiki/`에 있는
  프로젝트별 + 프로젝트 교차 마크다운 노트. 채팅 세션에서 동기화하거나,
  코드베이스를 분석해 컨벤션을 추출하거나, 라이브 프리뷰로 페이지를
  그 자리에서 편집할 수 있습니다.
  → [docs/features/wiki.md](docs/features/wiki.md)
- **한 번만 등록하는 환경 변수.** 설정 → 환경 변수. 모든 Claude/Codex
  에이전트 실행이 이를 상속합니다. 통합마다 `~/.bashrc`를 수정할
  필요가 없습니다.
  → [docs/features/env-vars.md](docs/features/env-vars.md)
- **Teams — MCP를 통한 오케스트레이터 + 워커.** 하나의 오케스트레이터
  세션을 N개의 워커와 묶습니다. 오케스트레이터는 alias(`@be`, `@fe`)나
  태그(브로드캐스트)로 작업을 분배합니다. 동기식 `team_ask`는 SDK의
  Task 도구를 미러링하여 왕복 동안 오케스트레이터의 턴이 살아 있게
  유지합니다.
- **GitHub 기반 백업.** 클릭 한 번으로 위키 트리를 비공개 저장소에
  푸시하고 다른 기기에서 복원하세요. 데이터베이스는 git 측과 분리되어
  이식 가능한 JSON export/import로 관리되므로, 바이너리 diff로 저장소를
  부풀리지 않으면서 노트북 간에 살아남습니다.
- **로컬 전용.** 인증 없음, 클라우드 없음, 멀티유저 없음. 당신의
  기기에서 `localhost:4747`로 실행됩니다.

| | |
|---|---|
| ![환경 변수](docs/screenshots/03-env-var-add-form.png) | ![위키](docs/screenshots/06-wiki-populated.png) |
| **환경 변수** — 한 번만 등록하면 모든 에이전트 실행이 상속 | **Wiki** — 에이전트가 매 턴 읽는 영속 프로젝트 메모리 |

## 스택

- **런타임**: Node.js (`@anthropic-ai/claude-agent-sdk`가 요구)
- **백엔드**: Fastify + `@fastify/websocket` + `better-sqlite3`
- **프론트엔드**: React 19 + Vite + Tailwind CSS v4
- **모노레포**: pnpm workspaces

## 요구 사항

- **Node.js ≥ 22** (Node 24 LTS 권장). 버전 핀이 `nvm`(`.nvmrc`)과
  `asdf`(`.tool-versions`) 모두에 체크인되어 있습니다. 선호하는 버전
  매니저를 사용하시거나 — 시스템 Node가 이미 요구 사항을 충족한다면
  건너뛰어도 됩니다.
- **pnpm** (없다면 `corepack enable`로 활성화)
- **로컬에 설치되고 인증된 에이전트 CLI 최소 하나**:
  - **Claude Code CLI** — `claude --version`이 동작해야 함
  - **Codex CLI** (선택적 대안) — `codex --version`이 동작해야 함

  세션은 두 에이전트 중 하나를 사용할 수 있으며, UI에서 세션별로
  선택합니다. 접근 권한이 있는 것을 설치하세요.

## 빠른 시작

```bash
pnpm install
pnpm start           # build + run, http://localhost:4747
```

### pinloom 자체 개발하기

```bash
pnpm dev             # tsx watch + Vite HMR — for editing pinloom's source
```

`pnpm dev`는 소스 파일 워처를 추가하여 더 무겁습니다. 일상적인 사용에는
`pnpm start`를 쓰세요.

## 설계 원칙

1. **세션은 Claude Code가 아니라 pinloom이 소유한다.** 모든 메시지와 tool_use 블록이 로컬 SQLite DB에 미러링되므로, `~/.claude/` 초기화로 대화 히스토리를 잃지 않습니다.
2. **에이전트의 메모리는 당신이 통제하는 디스크에 산다.** Wiki는 `~/.pinloom/wiki/` 아래, 세션은 `data/pinloom.sqlite` 아래에 있습니다. 둘 다 GitHub에 백업하거나 파일로 export할 수 있습니다.
3. **명시적 삭제만 허용.** 세션, 페이지, 플랜은 자동으로 비워지지 않습니다 — 웹 UI 동작만이 데이터를 제거합니다.
4. **로컬 전용 MVP.** 인증 없음, 클라우드 없음, 멀티유저 없음. 당신의 기기에서 실행됩니다.

## 구조

```
packages/
  shared/      # types, constants, zod schemas
  backend/     # Fastify app, SQLite, WS hub, claude-agent-sdk runner
  frontend/    # React UI: chat / wiki / teams / settings
  mcp-server/  # pinloom MCP tools for the Teams orchestrator
docs/
  features/    # deep-dives on individual features
  screenshots/ # committed UI screenshots for the README + features docs
e2e/
  smoke.spec.ts        # CI smoke test
  walkthrough.spec.ts  # regenerates docs/screenshots/ + a .webm walkthrough
```

## 스크린샷 + 데모 영상 재생성

`docs/screenshots/`의 스크린샷과 `docs/walkthrough.webm`의 워크스루
영상은 Playwright 스펙으로 생성됩니다:

```bash
pnpm exec playwright test --config e2e/walkthrough.config.ts
cp e2e/artifacts/screenshots/*.png docs/screenshots/
cp e2e/artifacts/walkthrough.webm docs/walkthrough.webm
```

워크스루 동작:

- `$TMPDIR` 아래의 일회용 SQLite와 오버라이드된 `$HOME`을 사용해
  `localhost:4747`에 새로운 백엔드 + 프론트엔드를 띄웁니다 —
  `data/pinloom.sqlite`나 실제 `~/.pinloom/`을 절대 건드리지 않습니다.
- 테스트가 시작되기 전에 로컬 `claude` CLI를 통해 실제 Claude 답변을
  미리 가져오고(녹화가 SDK를 기다리는 빈 탭이 되지 않도록), 직접 SQLite로
  Q+A를 삽입한 뒤, 공개 `PATCH /api/messages/:id` 경로로 어시스턴트
  메시지를 고정합니다.
- Wiki 대시보드가 빈 상태 대신 실제 콘텐츠를 캡처하도록 디스크에
  위키 페이지 세 개를 시드합니다.

호스트의 `claude` CLI가 인증되어 있어야 합니다 — SDK에 번들된 네이티브
바이너리 선택기가 glibc Linux에서 실행되지 않는 musl 빌드를 선호하기
때문에, 시스템 CLI로 셸 아웃합니다.

## 라이선스

MIT
