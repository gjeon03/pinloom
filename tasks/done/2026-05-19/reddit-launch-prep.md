# Reddit launch prep — pinloom

- **상태**: 완료
- **생성**: 2026-05-19
- **완료**: 2026-05-19

## 내용
- 공개 자료(Reddit 포스트 + 데모 영상/스크린샷) + 문서 보강 (README/CONTRIBUTING/Wiki 기능 소개)을 한 번에 정리한다.
- 사용자가 특히 좋아한 두 기능: Settings의 **환경변수 등록**, **Wiki**(sync/analyze + 영구 메모리).

## 단계
1. `/tmp/pinloom-demo` 데모 타깃 레포 생성 (작은 Node 프로젝트)
2. 격리된 SQLite로 pinloom 부팅 (backend 4748 / frontend 4747)
3. Playwright walkthrough 스크립트 작성 — env var → project → plan → chat → wiki → teams
4. 헤드드+비디오 모드로 실행, `e2e/artifacts/` 에 스크린샷 + .webm 저장
5. `docs/reddit-launch.md` Reddit 포스트 초안 + `docs/features/` 기능별 페이지
6. README/CONTRIBUTING 보강 (Features 섹션, Wiki/env vars 소개 + 링크)

## 산출물
- `e2e/walkthrough.spec.ts` (재실행 가능한 데모)
- `e2e/artifacts/*.png`, `e2e/artifacts/*.webm`
- `docs/reddit-launch.md`
- `docs/features/env-vars.md`, `docs/features/wiki.md`
- README.md / CONTRIBUTING.md 패치
