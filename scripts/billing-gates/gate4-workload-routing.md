# Gate 4 — workload routing (analysis, no script)

The cheapest possible answer to the 6/15 split: don't change *how* pinloom drives
Claude at all — change *what runs where*. Max 20x already pays for both buckets
(weekly interactive + the $200/mo SDK credit, use-it-or-lose-it). If normal usage
naturally spreads across both, you stay under each cap with zero new machinery.

## The routing policy to evaluate

| Workload | Bucket / transport | Why |
|---|---|---|
| Long exploration, parallel Teams, robustness-critical | **SDK** ($200 credit) | structured, resumable, no TUI fragility; the $200 is already paid |
| Short iterative coding, everyday chat | **interactive** (OAuth `-p` if gate 2/3 passes, else PTY) | high-volume, low-stakes — soak it into the weekly bucket |

## How to decide (after running `measure-sdk-spend.mjs` for ~a week post-6/15)

1. Run `measure-sdk-spend.mjs --days 7` and read the per-model / per-day split.
2. Estimate: if **everything** ran on SDK, do you blow the $200 credit? (We already
   know from the pre-6/15 run: yes, heavily — so pure-SDK is not viable.)
3. Estimate: if the "short iterative + chat" slice moves to the interactive bucket,
   does the **remaining** SDK slice fit under $200, AND does the moved slice fit under
   the weekly interactive cap?
   - **Both fit** → routing alone solves it. Ship a per-session/per-task bucket
     selector (pinloom already has a per-session agent picker — add a bucket toggle).
     No PTY needed. ✅
   - **SDK slice still > $200** → you must move *more* to interactive, which needs a
     working interactive transport → gate 2/3 (OAuth `-p`) or, failing those, the PTY.

## Output

A one-paragraph verdict in `docs/billing/dual-bucket-plan.md` §1: "routing sufficient?
yes/no, and if no, which transport gate 2/3/PTY is required."
