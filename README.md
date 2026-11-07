# dsh-resume

<p align="center">
  <strong>Resume after interruption for DeepSeek Harness</strong>
</p>

<p align="center">
  <em>Finish the interrupted work instead of asking what to do next — no restating the request, no re-planning, no “should I continue? / how many rounds?”</em>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat" alt="MIT License">
  <img src="https://img.shields.io/badge/dsh-0.2.0--rc.2%20%2B%200.2.1--rc.x-blue?style=flat" alt="DSH 0.2.0-rc.2+">
  <img src="https://img.shields.io/badge/node-%3E%3D22.5-339933?logo=node.js&logoColor=fff" alt="Node.js >= 22.5">
  <img src="https://img.shields.io/badge/language-JavaScript-F7DF1E?logo=javascript&logoColor=000" alt="JavaScript">
</p>

---

## Summary

`dsh-resume` is a plugin for [DeepSeek Harness](https://www.deepseek.com/harness/) (dsh). When a session is interrupted — you pressed stop, or the host process died in the middle of a turn — the plugin derives the **breakpoint** from the session log and puts the model back exactly where it was, with a single fixed `<resume>` message that carries the coordinates, the state of every unfinished tool call, and one scoped instruction: *finish that work, don't ask what to do next*.

| What you get | What it does |
| --- | --- |
| **Breakpoint derivation** | Folds the session event log into one snapshot: `{turn, step, truncated, cause, openCalls, queued}`. Two causes, both derived from kernel facts — never invented vocabulary. |
| **A fixed `<resume>` message** | Byte-identical template, rendered from facts only. Three parts must hold together: *finish it*, *don't ask*, *a later human message wins*. |
| **One-click resume** | Takes over the composer's primary send key — it becomes a hollow ▶ when a breakpoint exists. No new buttons. |
| **Auto-resume after a host restart** | When the host died mid-turn, the plugin picks the work back up on its own after a short quiet window. No click, no round count to answer. |
| **Human message always wins** | If you type something after the interruption, the resume marker is revoked, the queued `<resume>` is pulled back, and a not-yet-producing resume turn is cancelled. |
| **Idempotent by construction** | One breakpoint ⇒ at most one queued resume. Repeated clicks are rejected with a reason, never duplicated. |
| **Append-only** | The `<resume>` goes in as a normal user message. History is never rewritten, never reordered. |

The system-prompt contribution is a **static constant** (`## 中断与续行`). It never changes between turns, so it never invalidates the provider's prompt cache.

---

## Table of Contents

- [How it works](#how-it-works)
- [Install](#install)
- [Usage](#usage)
- [Configuration](#configuration)
- [Behavior contract](#behavior-contract)
- [Prompt contract](#prompt-contract)
- [Verification](#verification)
- [Known limitations](#known-limitations)
- [Privacy and safety](#privacy-and-safety)
- [License](#license)
- [Contributing](#contributing)

---

<a id="how-it-works"></a>
## How it works

Two kinds of interruption, one breakpoint:

| Entry | Kernel fact | What this plugin does |
| --- | --- | --- |
| You pressed stop (`aborted`) | `agent.cancel({ kind: 'user' }, { keepInbox: true })` → `turn/end{reason:{kind:'aborted'}}` | Derives the breakpoint and registers it. The resume is queued only when you click once (the ▶ key or `/resume`). **Stopping is the human's decision — a restart must not undo it.** |
| The host exited inside a turn (`interrupted`) | That turn has no `turn/end`; on the next load `dsh-session`'s `openTurnClosers` synthesizes the result, `step/end` and `turn/end{reason:{kind:'interrupted'}}` | **Resumes by itself**: queues the `<resume>`, re-arms an `active` but `disarmed` goal so `goal-round-driver` keeps queueing rounds. No click, no answer about round counts. |

After a stop, the log ends with an assistant anchor flagged `interrupted: true` plus synthetic tool results such as `ABORTED_BEFORE_DISPATCH` / `TOOL_OUTCOME_UNKNOWN`. `dsh-resume` takes over from exactly there: it computes the breakpoint, registers one pending-resume record, renders one **byte-fixed** `<resume>` user message, and hands the model back the breakpoint.

The `<resume>` carries a **scoped** continuation requirement — "finish it" plus "a later human message wins". All three parts have to be present at the same time, otherwise you fall into one of two known failure modes (see [Prompt contract](#prompt-contract)).

- **Host half** — `index.js`: breakpoint derivation, pending-resume register, session projection, `/resume` command, system-prompt section.
- **Client half** — `client.js`: takes over the composer's primary send key (probe + CSS triangle + captured click), decision function `shouldShowPlay`.
- **System-prompt section** — `## 中断与续行`, byte-constant (changing it would swap the system node and hurt caching).

---

<a id="install"></a>
## Install

### From a local checkout

```sh
git clone <this-repo> dsh-resume
dsh plugin --profile <profile> add link:/abs/path/to/dsh-resume
```

`dsh plugin … add` forwards to pnpm inside the profile directory and then selects the bundle: the plugin is appended to the profile's `dsh.profile.bundles` list in `package.json`. Verify the row exists:

```sh
dsh --profile <profile> --dump-config | grep -A6 'dsh-resume'
```

The plugin is one bundle with two halves in a single patch row:

- `package.json` `main` → `index.js` (host side: breakpoint, register, commands, system prompt)
- `package.json` `exports["./client"]` → `client.js`, declared under `dsh.client` so dsh serves it as a browser bundle under `/plugins` (loaded by `dsh-client-modules` from the loader roster)

### From a published tarball or git remote

```sh
dsh plugin --profile <profile> add https://codeload.github.com/<owner>/dsh-resume/tar.gz/refs/heads/main
# or
dsh plugin --profile <profile> add https://github.com/<owner>/dsh-resume.git
```

Both forms install the bundle and select it. A git-hosted plugin needs its build script allowed — pnpm blocks it until you add the exact key it prints under `allowBuilds` in the profile's `pnpm-workspace.yaml`.

### Requirements

| Item | Value |
| --- | --- |
| dsh runtime | `0.2.0-rc.2` and newer `0.2.x` releases (developed and tested against `0.2.0-rc.2`) |
| Node.js | `>= 22.5` (tested on v24.22.0) |
| Platform | any host dsh runs on; the client half targets the dsh **web** platform |

### Dependencies

The plugin depends on one runtime package, `@deepseek-ai/schemastery` (MIT), for its `Config` schema. It is **vendored into `node_modules/@deepseek-ai/`** and declared in `bundledDependencies`, because dsh's install paths (`link:`, `file:`, tarball) do not install a linked package's dependencies and Node resolves a symlinked package by its real path — the profile's hoisted `node_modules` is invisible to it. With the dependency bundled, `npm pack` produces a self-contained tarball: measured, installing that tarball resolves `@deepseek-ai/schemastery` to the copy inside the installed package, not to the profile's tree. See [`vendor-NOTICE.md`](./vendor-NOTICE.md).

The vendored copy is checked into the repository on purpose — `clone` and run, no install step:

```sh
node verify/checks.mjs        # 72/72
node verify/host-stub.mjs     # 70/70
node verify/client-bundle.mjs # 29/29
```

### Reloading

The **client** bundle is read from disk per request — refresh the browser and you have the latest client code.

The **host** half is loaded by Node's ESM loader: dsh's HMR rebuilds the plugin rows, but the old module of a `link:`-installed package keeps winning from the ESM cache. **Restart `dsh web` after every host-side change.** (Measured: editing `index.js` → HMR fires → the new key still does not appear in `session/projections`; `disable` → `enable` does not help either.)

A restart of `dsh web` does not lose the current session — the harness resumes from its own rollout.

---

<a id="usage"></a>
## Usage

### The primary key (no new buttons)

The primary key — the round button at the far right of the composer toolbar — changes shape by state. Position, size and the round background never change:

| State | The key looks like | Clicking it |
| --- | --- | --- |
| Breakpoint exists + agent idle + empty draft + no `<resume>` waiting in the inbox | **Hollow ▶** (the native arrow is hidden and replaced by a 16px stroked triangle) | Resume: queues the `<resume>` |
| The resume is already queued but not yet claimed | Back to the native send arrow (read from the official `inbox` projection — no second click is offered) | — |
| The draft has content (breakpoint or not) | Native send arrow | Normal send |
| The agent is running (empty draft) | Native stop square | Normal stop |
| No breakpoint | Native send arrow | Normal send (still disabled with an empty draft) |

The decision comes from the host's session projection `resumeBreakpoint` (log-derived, updated with the events). **The client does not guess**: as soon as a breakpoint appears the key turns into a triangle, and the moment the breakpoint is consumed (the resume turn starts, or a human message opens a new turn) it turns back.

Technically: the probe component is mounted at `conversation.input.right` (inside the composer card, so it can `closest('[data-composer-card]')`), swaps the icon with a one-time CSS injection and `data-dsh-resume-play="true"`, and takes over the click in the capture phase (the native key is `disabled` with an empty draft, so it is forced clickable during takeover and the original `aria-label` is restored on release).

### Commands

| Command | Effect |
| --- | --- |
| `/resume` | Resume from the current breakpoint (exactly what the button does) |
| `/resume-status` | Read-only diagnostics: current breakpoint, anchor, register table, warnings |

### Turning it off

- `autoResumeOnRestart: false` — keep the manual path only, the host will never resume by itself after a restart.
- `systemSection: false` — do not inject the `## 中断与续行` system-prompt section.
- Remove `"dsh-resume"` from the profile's `dsh.profile.bundles` list to unload the bundle entirely.

---

<a id="configuration"></a>
## Configuration

Configuration lives in the bundle's `cordis.patch.yml` row (the same row that hosts and browser roster share). Defaults are identical to `index.js`'s `Config` schema.

| Field | Default | Meaning |
| --- | --- | --- |
| `draftSentinel` | `⟦dsh-resume⟧` | Sentinel text for the fallback draft path; the host replaces it before the step is entered |
| `maxOpenCalls` | `5` | How many unfinished tool calls the `<resume>` lists; the rest is only counted |
| `systemSection` | `true` | Inject the `## 中断与续行` system-prompt section |
| `autoResumeOnRestart` | `true` | Resume automatically on load for `cause=host-restart`. An `aborted` breakpoint is never auto-resumed — it still waits for a click |
| `rearmGoal` | `true` | On resume, re-arm an `active` + `disarmed` goal (`goals.resume`) so the round driver keeps going; `paused` / `complete` / `blocked` goals are left alone |
| `restartSettleMs` | `600` | Quiet window after load before an automatic resume. Human messages that arrive inside the window win |

Example override in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-resume
  config:
    autoResumeOnRestart: false
    restartSettleMs: 1500
```

---

<a id="behavior-contract"></a>
## Behavior contract

### Breakpoint derivation (pure function)

`foldBreakpoint(state, event)` folds a single event; `deriveBreakpoint(sessionId, events, queued)` processes a batch. Both share one state machine, so they cannot drift.

```
{ sessionId, turn, step, truncated, cause, openCalls[{callId,name,status}], queued }
```

`cause` has exactly two values, mapped straight from `turn/end.reason.kind`:

| `turn/end.reason.kind` | `cause` | Meaning | On load |
| --- | --- | --- | --- |
| `aborted` | `user-interrupted` | The user pressed stop | No automatic resume — wait for the user |
| `interrupted` | `host-restart` | The host process exited inside the turn; the kernel closed it on the next load | Auto-resume after the quiet window |
| anything else (`completed` / `error` / …) | — | Not an interruption | No breakpoint |

Rules — kernel facts only, no invented vocabulary:

- **Only a turn that ended in an interruption** (`aborted` or `interrupted`) is a breakpoint. A new `turn/start` clears the live breakpoint but keeps the **anchor** for `agent/pre-step` re-verification.
- **Crash-tail fallback**: if the log stops inside a turn (no `turn/end` to fold, e.g. the repair never ran), `openTailSnapshot()` turns that live turn into a `host-restart` breakpoint with `truncated: true` — work in flight is treated as a restart breakpoint, so you never have to restate it.
- `truncated` ← the turn contains `assistant/message{interrupted:true}`.
- `openCalls` ← the turn's `tool/call` entries that have no committed result, plus calls whose result carries one of these kernel result codes:
  - `tool/call` with no result → `TOOL_OUTCOME_UNKNOWN`
  - `tool/result.error.code = TOOL_OUTCOME_UNKNOWN` → outcome unknown
  - `tool/result.error.code = ABORTED_BEFORE_DISPATCH` → never dispatched (`dsh-agent-loop`'s `appendSkippedToolCall`)
  - `tool/result.error.code = TOOL_NOT_STARTED` → never recorded as started (`dsh-session` repair)
  - any other committed result counts as completed and is excluded.
- `queued` ← the number of human messages in `inbox.nextTurn + inbox.nextStep` at the moment of the click (the plugin's own `<resume>` excluded).

### Pending-resume register

Key = `{sessionId}:{turn}:{step}`, phases:

```
reserved ──flush ok──▶ queued ──agent/inbox/claimed──▶ consumed
     │                      │
     └──failed/withdrawn──▶ (deleted)  └──human message first / discarded / agent error / unload──▶ revoked
```

- **Reserve before admitting**: the phase is set to `reserved` synchronously, then `await ctx.sessions.flush(agent.session)`. After the flush the breakpoint is recomputed; if the coordinates moved, the reservation is withdrawn and nothing is queued. Ten consecutive triggers on the same breakpoint queue exactly one message (further calls return `续跑已排队` / "already queued"); after `consumed` any further trigger returns `该断点已续跑过` / "already resumed".
- **Decide before cutting** (the counterpart of Codex's `InterruptIfNoPendingInput`): `resumeNow()` checks the inbox *after* the flush and *before* the followup. If human input is already queued it returns `续跑已作废（你已发送新消息）` / "superseded — you already sent a new message" and queues nothing. The draft path behaves the same: if human input was queued before the sentinel, the sentinel is dropped and no register is set.
- **Human message yields**: when a breakpoint is `queued`/`reserved` and a message with `source.kind === 'user'` arrives, the register becomes `revoked` and the queued `<resume>` is withdrawn from the inbox.
- **Superseded after consumption**: a `consumed` register that later meets a human message becomes `superseded` — a trace only, visible in `/resume-status`; history is untouched and the already-running `<resume>` is not cancelled.
- **Pre-step re-verification**: `agent/pre-step` (waterfall) validates before the step is entered — `{register.key === anchor key}`, `phase === 'consumed'`, the agent is still alive. On failure it returns `{kind:'reject'}` and puts the other messages claimed in the same batch back into `next-step` (mirroring `dsh-goal-round-driver`'s `restoreOtherClaimed`).
- **Fail-closed teardown**: on unload `stopped = true`, every unconsumed register becomes `revoked` and the table is cleared; `agent/error` also revokes that agent's pending records.

### Automatic resume on load (`cause=host-restart`)

`agent/created` → `seedFromSession()` (rebuild the last turn's fold with `session.ownEvents()`, apply the crash-tail fallback, collect every `<resume id>` that ever appeared in the history) → `scheduleAutoResume()`:

1. **Quiet window** (`restartSettleMs`, default 600 ms): one-shot clients (headless / ACP) create the agent and immediately submit a task. Human messages that arrive inside the window land first — if one exists, the whole resume yields.
2. At the end of the window it re-checks: `cause === host-restart`, `agent.status === 'idle'`, `queuedCount === 0`, no register for the same key, and **no `<resume id>` for the same coordinates in the history** (cross-process de-duplication — if the previous process already queued it, it does not fire again).
3. Pass → `resumeNow(agent, 'auto-restart')`: flush → re-check the breakpoint → queue the `<resume>` → `rearmGoal()`.

`agent/status{idle}` schedules one more attempt (fallback for the case where the agent was not idle yet at load time). One timer per breakpoint (a `scheduled` set), cleared on teardown.

**Human message preemption**: if the resume turn has started but the model has not produced anything yet (`fold.produced === false`) and a human message arrives, the turn is cancelled with `agent.cancel({kind:'user'}, {keepInbox:true})` so the human message takes over immediately. Once anything was produced (even one token) the turn is *not* cancelled — cancelling would throw away the work, and the human message waits for the next step boundary.

### Re-arming the goal (so nobody is asked for a round count)

`dsh-goal` disarms unconditionally on `agent/created` (the session start edge). So after a restart, even when the plugin has already resumed, `goal-round-driver`'s admission condition (`phase==='active' && activation==='armed'`) is not met — it stops queueing rounds and the model comes back with "should I continue? / how many rounds?".

`rearmGoal(agent, reason)` restores that human authorization: when `goals.get(agent)` is `active` **and** `disarmed`, it calls `goals.resume(agent, {id, revision})`.

- `paused` / `complete` / `blocked` are never touched (an explicit pause or wrap-up wins).
- An already `armed` goal is not resumed twice.
- Exhausted round budget (`goals.resume` throws `exhausted … goal rounds`) → recorded as a warning only: no resume, and no question to the user.
- No `goals` service (headless template) → the whole block is skipped; automatic resume still works.

Trigger points: after a successful command-path resume, after the draft path passes the `pre-step` admission, and after an automatic resume is queued — all of them are moments where the human has already authorized the continuation.

### Hard constraints honoured

- **Append-only**: the `<resume>` goes in as an ordinary `followup` user message. Under the same provider/model route history only grows — no surface rewrite, no message reordering.
- **Static system-prompt contribution** (`interpolate: false`): it only changes when the plugin is enabled or disabled, never between steps, so it never swaps the system node.
- **Facts only**: the template carries coordinates and state. It does not paste history back and does not restate the user's original words. The acceptance suite caps a render at 1500 characters; the largest case in the suite measures 499, and the worst case you can construct by hand (five unfinished background shell calls, a truncated turn, queued input) stays under 800.
- No second-confirmation wording.

---

<a id="prompt-contract"></a>
## Prompt contract

Both causes share one line order; `renderResume` renders it byte-for-byte:

```text
<resume id="R-{turn}-{step}" reason="{user-interrupted|host-restart}">
{reason line: the user pressed stop / the host process exited during turn {T} / step {S} (the kernel closed it as interrupted)}, the work before the breakpoint is not finished.
断点位置：turn {T} / step {S}
{if truncated}模型输出在此处被截断，已交付部分见上一条 assistant 消息。
{if openCalls}未闭合的工具调用：
- {toolName}({callId})：{status}（{fact}）{if shell/background}{; …}
{if queued}中断期间已排队 {n} 条输入，将在下一步边界交付。
续跑要求：把断点前正在做的那件事接着做完；不要询问「下一步做什么」「要不要继续」「继续几轮」，不要重新规划或复述需求，缺的事实自己查。
结果未知的调用先用只读手段核验外部状态，再决定是否重试；未派发的调用按需重新发起；不可逆动作（提交、推送、删除）先说明再执行。
本条只对紧随其后的这一轮有效：其后出现任何人类消息，以新消息为准，本条作废。
</resume>
```

> The message body is intentionally written in Chinese and is **byte-constant**. It is a fixed contract, not prose to be improved: the acceptance suite asserts the three directive lines literally. `RESUME_DIRECTIVE_LINES` in `index.js` is the single source.

All three parts have to hold at the same time. Drop one and you land in a known failure mode:

| Missing part | What happens |
| --- | --- |
| "finish it / don't ask what to do next, don't ask for a round count" | After a restart or a resume the model comes back with "what should I do next?" / "how many rounds?" (this is exactly what the 0.1.x final build did — reported as "stopping and restarting ruins the work") |
| "a later human message wins" | **Incident:** a single "hello" fired the pending commit from before the breakpoint (see [Incident and fix](#incident-and-fix)) |
| "verify unknown results read-only first / explain irreversible actions first" | Blind retries: the model re-ran `sleep 200` after a restart and pushed the human's new instruction to the next turn (reproduced on a live host) |

The continuation requirement is a **conditional imperative**, not a standing instruction: its scope is stated in the third line.

Result code → status (kernel result codes → statements):

| Result code | Status | Fact |
| --- | --- | --- |
| `TOOL_OUTCOME_UNKNOWN` / no result | 结果未知 (outcome unknown) | dispatched, no result recorded |
| `ABORTED_BEFORE_DISPATCH` | 未派发 (not dispatched) | — (no parenthetical) |
| `TOOL_NOT_STARTED` | 未记录启动 (start not recorded) | no `tool/call` record |
| `TOOL_ABORTED` (observed live) | 结果未知 (outcome unknown) | dispatched, then aborted |

`TOOL_ABORTED` is exported by `dsh-tools` and shows up on the real stop path.

At most 5 unfinished calls are listed; beyond that the template appends `（另有 {n} 条未闭合调用未列出）`.

**Shell / background fact block** (appended to that call's line; decided by `classifyShellCall(name, arguments)`):

| Decision | Appended text (a fact, not an action) |
| --- | --- |
| `background` (an argument like `run_in_background` / `background` / … is `true`) | `；该调用是后台任务，可能仍在运行（有 job 记录）` |
| `shell` (a shell-class tool name without the background marker) | `；该命令可能有子进程仍在运行` |
| any other tool / arguments that are not valid JSON | nothing appended (no guessing) |

### System-prompt section

```text
## 中断与续行
`<resume>` 是会话被打断后注入的一条用户消息：内容是该断点的坐标、未闭合工具调用的状态，以及把在飞工作接着做完的续跑要求。
看到它时：
- `<resume>` 只对紧随其后的这一轮有效。其后出现任何人类消息，以新消息为准，旧 `<resume>` 作废，不要按它继续。
- `<resume>` 就是当前这一轮的消息时：接着做断点前没做完的那件事。不要询问「下一步做什么」「要不要继续」「继续几轮」，不要重新规划或复述需求；能被你查到的事实自己查，只有缺用户才能提供的信息时才发问。
- 标注「结果未知」的工具调用：先用只读手段核验外部状态，再决定是否重试。
- 标注「未派发」的调用按需重新发起；不可逆动作（提交、推送、删除）先说明再执行。
```

The job of this section is to pull the model from "stop and ask the human" back to "keep working". The 0.1.x final build wrote "ask the user first if there are side effects", which combined with the message body made the model choose to ask — that is where the reported "it asks me what to do next" came from. Now "should I ask" is narrowed to one decidable rule: **look it up yourself; only ask for facts only the human can provide**.

<a id="incident-and-fix"></a>
### Incident and fix: one "hello" fired an old commit

In one session, the user stopped the agent and then typed only "hello" — and the model went ahead and executed the pending work from before the breakpoint (a real commit was produced). The model's own reasoning in that turn:

> "The user just says 你好 (hello)… **The resume marker says continue from breakpoint.** … So execute."

All three causes were defects in this plugin's prompt, not in the user's behaviour:

1. The `<resume>` was an **imperative** and, as a `user/message`, stayed in the history permanently (that session stacked up three of them) — it never expired.
2. The system section then read "don't re-confirm the request, continue straight from the breakpoint" — no validity window, and it suppressed "ask before an old action with external side effects".
3. The breakpoint content was a high-risk old intention (a commit) while the new message was a zero-information greeting — the weights were inverted by the wording.

The fix came in two rounds. The first removed "continue from the breakpoint / do not re-confirm" and kept only coordinates, state and "a later message wins". The second turned the remaining narrow action instructions ("verify read-only first", "re-dispatch if still needed", "do not re-run", "do not restate") into **statements of fact**, and the last line became "this record only carries the breakpoint coordinates and the tool-call state". The regression case is `verify/live-hello.mjs`: interrupt → send only "hello" → assert the old to-do is not executed and the marker file is never created.

### Third round (0.2.0): give the wheel back, but with a scope

The first two rounds over-corrected: with no imperative left in the template, the model had **no authorization to continue** when a resume happened, so it came back asking "what next? / how many rounds?" — the exact report "stopping and restarting ruins the work". And interruptions other than `aborted` (host process exit → `reason.kind:'interrupted'`) did not produce a breakpoint at all, so the only way forward was to restate the request.

This round puts the **authorization** and the **validity window** into the same message instead of choosing one:

- The `<resume>` regains its continuation requirement (finish it, do not ask what to do next or for a round count, look up missing facts yourself);
- but that requirement carries its own scope: **it is valid only for the turn immediately after it; any later human message supersedes it** — the "hello" scenario is caught by that one line instead of by deleting every imperative;
- the two interruption causes split: `aborted` waits for a click, `interrupted` resumes by itself when nobody speaks inside the quiet window;
- the system section narrows "should I ask" into a decidable rule (only ask for facts only the human can provide) instead of the old "ask first if there are side effects", which invited questions.

Both regressions are mandatory: `verify/live-hello.mjs` (a "hello" must not fire anything) and `verify/host-stub.mjs` (auto-resume on load / quiet window / preemption).

---

<a id="verification"></a>
## Verification

### Offline suites (no dsh runtime needed)

```sh
node verify/checks.mjs        # 72/72 passed — two causes, crash-tail fallback, byte-exact template, projection, system section
node verify/host-stub.mjs     # 70/70 passed — decide-before-cut, superseded trace, auto-resume on load, quiet window, preemption, goal re-arm
node verify/client-bundle.mjs # 29/29 passed — triangle decision, pending, styles, slot
```

Every suite exits non-zero on the first failure and prints the actual/expected pair.

What they cover:

- `renderResume` compared byte-for-byte across six branches (user stop / host restart / truncated / outcome unknown / not dispatched / queued input), plus line order, the 5-call cap with its counter, and the `TOOL_ABORTED` mapping. Template size is asserted (max ≤ 1500 characters; the largest case in the suite measures 499).
- Derivation: aborted last turn, interrupted last turn → `cause=host-restart`, `causeOf` over four states, `queued` pass-through, completed calls excluded, breakpoint key, a normally finished turn produces no breakpoint, a later turn clears the old breakpoint, empty log, live turn.
- Fallback and de-duplication: `openTailSnapshot` turns "the log stops inside a turn" into a `host-restart` breakpoint; `<resume id>` occurrences in the history (both persisted shapes — `user/message` and `agent/inbox/spliced`) are remembered.
- Auto-resume on load: a restart breakpoint queues exactly one `transport=auto-restart` message whose body carries the reason and the continuation requirement; a user stop does **not** auto-resume; queued human input yields; an already-resumed coordinate does not fire again; a consumed breakpoint does not fire again.
- Quiet window: a human message inside the window → no auto-resume and no register; nobody speaks → the resume still happens.
- Preemption: a human message while the resume turn has produced nothing → the turn is cancelled with `cancel({kind:'user'},{keepInbox:true})` and the human message stays queued; once something was produced the turn is not cancelled.
- Goal re-arm: `active` + `disarmed` → exactly one `resume`; `paused` / already `armed` / no `goals` service → no action; a throwing `resume` → warning only.
- Idempotency: ten consecutive triggers on the same `{turn,step}` → one queued message; five after `claimed` → zero, with the message "already resumed".
- Yielding: a human message → register `revoked/human-message`, the queued `<resume>` withdrawn, the human message preserved.
- Draft path: the sentinel sets the register on insert, a second sentinel is dropped, `pre-step` replaces the sentinel with the `<resume>` (byte-identical to the derived snapshot; the sentinel characters never reach the history).
- Failure text: a throwing flush → `续跑未启动：write path closed`, nothing queued, no register left behind.
- Projection: an aborted last turn → `{available:true, turn, step}`; a new `turn/start` → `available:false`; unrelated events return the same reference (no downstream work).
- Primary-key decision: the triangle requires `available && !running && draft.trim()==='' && phase==='plain' && pending===false`; a missing projection, a running agent, a non-empty draft, a submit in flight and **an already queued resume** all keep the native key. The style hides `> svg`, the triangle is hollow (`fill='none'`) and contains no "continue" wording.
- Background classification: `run_in_background:true` → `background`; `bash`/`shell_exec`/`run_command`… without the marker → `shell`; non-shell tools or invalid JSON → unmarked. Each decision has its own trailing hint; ordinary tool calls get none.

### Live suites (real dsh process, real model)

```sh
# the cookie comes from a browser session (dsh-auth-…=v1.…)
node verify/live-e2e.mjs <cookie>        # 16/16 — create session → long task → cancel → /resume → read the events back
node verify/live-hello.mjs <cookie>      # 5/5   — the incident regression: interrupt → send only "hello" → no old to-do runs
node verify/live-background.mjs <cookie>  # 7/7   — a breakpoint on a shell call must carry the "check the job / child process, do not re-run" hint
node verify/probe-abort.mjs <cookie>     # observational: does a foreground tool stop, does a background job survive
```

`DSH_WEB_URL` points the scripts at the host under test (default `http://127.0.0.1:3080`).

What the live path asserts:

- The projection `resumeBreakpoint` is live on the wire and reports `available=true` after the stop, with coordinates matching the aborted turn.
- `/resume` is accepted by the host, and a `<resume id="R-{turn}-{step}" reason="user-interrupted">` user message appears in the history with `source.kind === 'resume'`; the raw sentinel never appears.
- **History is append-only**: every event before the resume is identical, seq by seq.
- After the resume the model keeps producing — it does not re-plan and it does not ask the request again.
- The projection falls back to `available=false` once the breakpoint is consumed, and the inbox no longer holds a `<resume>`.
- A second `/resume` on the same breakpoint is rejected (idempotent).

A real `<resume>` from a live run (four parallel `bash` calls, one dispatched-then-aborted and three never dispatched):

```text
<resume id="R-1-1" reason="user-interrupted">
上一轮被用户中止。历史中「未完成的助手输出」和「结果未知的工具调用」是断点，不是已完成的工作。
断点位置：turn 1 / step 1
未闭合的工具调用：
- bash(call_01_ET_SFNAHb1yfThYBndPohAq0596)：结果未知 → 先以只读方式核验外部状态；写类操作须先问用户
- bash(call_02_ET_g3P2e58JGI2DjrBeFf3C5760)：未派发 → 如仍需要则重新发起
- bash(call_03_ET_6zeOssrfxePxFK1QuXL42084)：未派发 → 如仍需要则重新发起
- bash(call_04_ET_ABTGTGz1VufrwHVTgGeX8672)：未派发 → 如仍需要则重新发起
要求：不复述任务、不重新确认需求、不重做已有结果的步骤。直接从中断点继续——第一条产出要么是工具调用，要么是对未完成部分的补充结论。
</resume>
```

After the resume the model simply kept working: `assistant/message` → `bash(sleep 5; echo step-2)` → result → `bash(... step-3)` …

A real `<resume>` carrying the shell fact block (an interrupted foreground `sleep 25`):

```text
- bash(call_00_1s6Pwv5rnGKHWRLUDhVR1248)：结果未知 → 先以只读方式核验外部状态；写类操作须先问用户（该命令可能仍有子进程在跑：先核验进程/文件状态，不要直接重跑）
```

---

<a id="known-limitations"></a>
## Known limitations

- **The entry key is always visible**: the client decides availability from `InputState.phase` only and does not query the server-side breakpoint. With no breakpoint, a click produces the session warning `续跑未启动：没有可续跑的断点`. Making it exact needs an extra host-side remote; this version does not have one.
- **`queued` is only reachable on the draft path**: the command path is now "decide before cutting" (it refuses when input is already queued), so the `<resume>` line "n inputs were queued" only appears on the draft path (sentinel inserted, a human message arrives before `pre-step` renders). The branch is kept and unit-tested, but the command path never triggers it.
- **The `background` branch was not reproduced live**: a background job normally returns its job id before the interruption, so it is not in the "unfinished" set. The live hit is the `shell` branch; the `background` branch is covered literally by the unit tests.
- **Automatic resume only applies to `cause=host-restart`**: after a restart, an `aborted` breakpoint (you pressed stop) does **not** run by itself — stopping is the human's decision, and reopening the host must not undo it. Click the key once or run `/resume`; either way you are not asked what to do next or for a round count.
- **The quiet window is a heuristic**: `restartSettleMs` (default 600 ms) gives clients that "create the agent and immediately submit a task" a chance to land first. A task submitted slower than the window can still lose one turn to the resume turn (preemption only covers "the resume turn has not produced anything"). Raise the window, or turn `autoResumeOnRestart` off and keep only the manual path.
- **Preemption only cancels while nothing was produced**: once the model produced anything (even a sentence of reasoning) the turn stays, and the human message waits for the next step boundary — that avoids throwing away work, at the cost of possibly one extra turn of tokens.
- **A preempted resume turn leaves an `aborted` breakpoint behind**: the next `/resume` sees it (`cause=user-interrupted`). It is a factual trace and is deliberately not cleaned up.
- **`produced` only lives in the fold state**: preemption reads "did this turn produce an `assistant/message`", which is unrelated to the wire view (the view is `{available,turn,step,truncated,cause,openCalls}`).
- **Cross-process recovery depends on `session.ownEvents()`**: the plugin uses this (already deprecated) read path on `agent/created` to rebuild the last turn's fold. If dsh removes it, this has to become a `session/event` replay plus a cold-read API.
- **The system-prompt section is a new contribution**: enabling the plugin adds one section to every session's effective system prompt. The text is byte-constant and never changes between turns.
- **The primary-key takeover has not been watched in a real DOM**: the decision table, the CSS contract and the slot registration are all automated (`client-bundle.mjs`), and the bundle really is served by the host — but whether the triangle covers the native arrow exactly, and whether a click fires exactly once, needs a human eye in a browser. The takeover depends on two stable hooks: `[data-composer-card]` (a data attribute the shell ships) and a button whose class contains `primary`. When either is missing it **silently degrades** to the native send key — no error, no stuck input.
- **The `install_bundle` tool surface was not used**: installation was done with the equivalent CLI (`dsh plugin … add` plus selecting the bundle), then verified through the real `/api` RPC and the boot graph.
- **No automatic cleanup of test sessions**: live verification leaves ordinary sessions behind in the GUI; they do not affect profile state.
- **The draft fallback path is only stub-verified**: on a real host the RPC-submitted message always has `source === {kind:'user'}` (the `prompt()` in `dsh-api-session-controller` hard-codes it), so `source.kind='resume-draft'` can only be realized by the host classifying by transport and rewriting in `pre-step`. That path is verified literally in `host-stub.mjs`; it has not been clicked through in a browser.

---

<a id="privacy-and-safety"></a>
## Privacy and safety

- The plugin **makes no network calls**. It reads the session event log, renders one message and hands it to the agent.
- It **never rewrites history**: the `<resume>` is an appended user message; the event prefix before it stays byte-identical (asserted live).
- It **never re-runs a tool call by itself**. It tells the model what the state of each unfinished call is, and the model decides. The prompt explicitly asks for a read-only check before retrying an unknown-outcome call and for an explanation before an irreversible action.
- It **does not undo a stop**: an `aborted` breakpoint waits for a human click, always.
- It **does not invent facts**: the message carries only coordinates, kernel result codes and counts. It never pastes history back and never restates the user's request.
- Uninstalling the bundle removes the commands, the system section and the projection. Nothing is written to disk by this plugin.

---

<a id="license"></a>
## License

[MIT](./LICENSE).

This package vendors two small MIT-licensed dependencies (`@deepseek-ai/schemastery`, `@deepseek-ai/cosmokit`) — see [`vendor-NOTICE.md`](./vendor-NOTICE.md) for versions, sources and licenses.

dsh itself is a separate project by DeepSeek (MIT). This plugin is an independent extension; it is not affiliated with or endorsed by DeepSeek.

---

## Further reading

- The long-form Chinese README ([README.zh.md](README.zh.md)) carries the full evidence log: kernel line references, the real `<resume>` transcripts, and the restart-vs-stop comparison.
- The plugin uses the documented dsh service surface only: `ctx.on` / `ctx.effect` / `ctx.inject`, `ctx.systemPrompt.section`, `ctx.sessions.flush`, `ctx.agents`, `ctx.commands.register`, `ctx.sessionProjections.register`, `ctx.goals`; on the client side `ctx.slots.inject` / `ctx.slots.register` and the `conversation.input.right` slot.

<a id="contributing"></a>
## Contributing
Issues and pull requests are welcome. Before opening one, please run the offline suites:

```sh
npm run verify
```

They need no dsh runtime and no model access — the pure functions, the host stub and the client bundle are all covered. A change to the `<resume>` template or to the system-prompt section is a **contract change**: update `RESUME_DIRECTIVE_LINES` / `SYSTEM_SECTION` in `index.js` and the literal assertions in `verify/checks.mjs` in the same commit, because both are byte-constant by design.
