# dsh-resume —— 中断后续跑

> 接着把活干完，而不是回来问人：不复述需求、不重新规划、不询问「下一步做什么 / 继续几轮」。

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh.md">中文</a>
</p>

两种中断，同一套断点：

| 入口 | 内核事实 | 本插件做什么 |
|---|---|---|
| 用户点停止（`aborted`） | `agent.cancel({ kind: 'user' }, { keepInbox: true })`（`dsh-api-session-controller/lib/index.js:998`）→ `turn/end{reason:{kind:'aborted'}}` | 算断点、登记待续跑；用户点一次「继续」（主键三角或 `/resume`）才排入 `<resume>`。**停止是人的意思，重启不替人撤销它。** |
| 宿主在轮内退出（`interrupted`） | 进程退出时那一轮没有 `turn/end`；下次装载由 `dsh-session` 的 `openTurnClosers` 补合成结果 + `step/end` + `turn/end{reason:{kind:'interrupted'}}` | 装载时**自己续跑**：直接排入 `<resume>`、把 `active` 但 `disarmed` 的 goal 重新武装，让 `goal-round-driver` 接着排队下一轮。不点、不回答轮数。 |

用户点击停止后，历史最后留下 `interrupted: true` 的 assistant 锚点，以及 `ABORTED_BEFORE_DISPATCH` / `TOOL_OUTCOME_UNKNOWN` 的合成工具结果；`dsh-resume` 在这一步之后接管：把「断点」算出来、登记成一条待续跑记录，排入一条**逐字固定**的 `<resume>` 用户消息，把模型带回断点。

`<resume>` 里带一条**作用域限定**的续跑要求（「接着做完 + 不问下一步/轮数 + 其后人类消息优先」）。三段同时成立，才能既不问人、也不重演 Fix issue 1（一句「你好」点火旧待办）。

- Host 半侧：`index.js`（断点派生 + 待续跑寄存器 + 会话投影 + `/resume` 命令 + 系统提示段）
- Client 半侧：`client.js`（**接管 composer 的主发送键**，不新增按钮）
- 系统提示段：`## 中断与续行`（内容逐字恒定，变了会换系统节点伤缓存）

## 目录

- [使用本包](#use-this-package)
- [行为契约](#behavior)
- [提示词契约](#prompt-contract)
- [源码地图](#source-map)
- [实测记录](#verification)
- [已知限制](#limitations)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装

bundle 形态与 `plugins/dsh-memory` 一致，单包单行：

```sh
# 本地检出
git clone <this-repo> dsh-resume
dsh plugin --profile <profile> add link:/abs/path/to/dsh-resume
# 再把 "dsh-resume" 追加到 profile package.json 的 dsh.profile.bundles
```

```sh
# tarball / git 远端
dsh plugin --profile <profile> add https://codeload.github.com/<owner>/dsh-resume/tar.gz/refs/heads/main
dsh plugin --profile <profile> add https://github.com/<owner>/dsh-resume.git
```

`plugin_manager` 的 `install_bundle` 做的是同一件事（pnpm add + 选入 `dsh.profile.bundles`）。profile 的 `hmr` 条目在线时，选用变化会被重新读取，插件在当前进程内挂载，**不需要重启宿主**；client bundle 由 `dsh-client-modules` 从 Loader 条目扫进 `window.__DSH_BOOT__`，浏览器刷新即加载。

**依赖**：运行时只依赖 `@deepseek-ai/schemastery`（MIT），它被 vendor 进包内 `node_modules/@deepseek-ai/` 并用 `bundledDependencies` 声明——因为 dsh 的安装路径（`link:` / `file:` / tarball）都不安装被链接包的依赖，而 Node 按真实路径解析符号链接，看不到 profile 的 hoisted `node_modules`。实测装 tarball 后，`@deepseek-ai/schemastery` 解析到的是安装包内部那份。逐包版本与许可证见 [`vendor-NOTICE.md`](vendor-NOTICE.md)。

vendor 副本**是有意进版本控制的**：clone 下来就能直接跑验收，不需要先装依赖：

```sh
node verify/checks.mjs        # 72/72
node verify/host-stub.mjs     # 70/70
node verify/client-bundle.mjs # 29/29
```

### 入口：主发送键接管（不新增任何按钮）

主键（composer 工具行最右那枚圆形键）按状态换形，位置、尺寸、圆底都不变：

| 状态 | 主键长什么样 | 点一下 |
|---|---|---|
| 有断点 + agent 空闲 + 草稿为空 + `inbox` 里没有排队的 `<resume>` | **空心右三角 ▶**（原生箭头被藏掉，换成 16px 描边三角） | 续跑：排入 `<resume>` |
| 续跑已入队、还没被 claim | 立刻还原成发送箭头（读官方 `inbox` 投影，不给人第二次可点的错觉） | — |
| 草稿里有内容（有断点也一样） | 原生发送箭头 | 正常发送 |
| agent 运行中（草稿为空） | 原生停止方块 | 正常停止 |
| 没有断点 | 原生发送箭头 | 正常发送（空草稿时仍是 disabled） |

判定来源是 Host 的会话投影 `resumeBreakpoint`（日志派生、随事件更新），客户端不猜：
断点一出现主键变三角，断点一被消费（续跑 turn 开始、或人类消息开新轮）立刻变回发送箭头。

技术上：探针组件挂在 `conversation.input.right`（在 composer 卡片内部，用来 `closest('[data-composer-card]')`），
用 `[data-dsh-resume-play="true"]` + 一段一次性注入的 CSS 换图标，并在捕获阶段接管这次点击
（空草稿时原生是 disabled，接管期间强制可点、释放时还原 `aria-label`）。

### 命令

| 命令 | 作用 |
|---|---|
| `/resume` | 从当前断点续跑（就是按钮点的那一下） |
| `/resume-status` | 只读诊断：当前断点、锚、寄存器表、告警 |

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `draftSentinel` | `⟦dsh-resume⟧` | 备用草稿路径的哨兵文本，Host 在步骤进入前替换 |
| `maxOpenCalls` | `5` | `<resume>` 里未闭合调用的展示上限，其余计数 |
| `systemSection` | `true` | 是否注入 `## 中断与续行` 系统提示段 |
| `autoResumeOnRestart` | `true` | 宿主重启断点（`cause=host-restart`）装载时自动续跑；`aborted` 断点不受此开关影响（仍等用户点） |
| `rearmGoal` | `true` | 续跑时把 `active` + `disarmed` 的 goal 重新武装（`goals.resume`），让轮驱动接着跑；`paused`/`complete`/`blocked` 不碰 |

-----

<a id="behavior"></a>
## 行为契约

### 断点派生（纯函数）

`foldBreakpoint(state, event)` 单事件折叠，`deriveBreakpoint(sessionId, events, queued)` 批处理；两者共用一套状态机，不会漂移。

```
{ sessionId, turn, step, truncated, cause, openCalls[{callId,name,status}], queued }
```

`cause` 只有两个值，由 `turn/end.reason.kind` 直接映射（`causeOf()`）：

| `turn/end.reason.kind` | `cause` | 含义 | 装载时 |
|---|---|---|---|
| `aborted` | `user-interrupted` | 用户点了停止 | 不自动续跑，等用户点 |
| `interrupted` | `host-restart` | 宿主进程在轮内退出，装载时由 `dsh-session` 的 `openTurnClosers` 补闭包 | 安静窗口后自动续跑 |
| 其它（`completed`/`error`/…） | — | 不是中断 | 不产生断点 |

规则（只认内核既有事实，不自创词）：

- **最后一轮以中断结束**（`aborted` 或 `interrupted`）才算断点；新 `turn/start` 清掉活断点，但保留「锚」（`anchor`）供 `agent/pre-step` 复核。
- **崩溃尾巴兜底**：装载时若日志停在轮内（没有 `turn/end` 可折叠，比如 repair 没跑），`openTailSnapshot()` 把那个活轮转成 `host-restart` 断点（`truncated: true`）——有在飞的活就当重启断点，不让用户重述。
- `truncated` ← 该轮存在 `assistant/message{interrupted:true}`。
- `openCalls` ← 该轮 `tool/call` 里没有已提交结果的调用，以及结果为下列内核结果码的调用：
  - 有 `tool/call` 无结果 → `TOOL_OUTCOME_UNKNOWN`
  - `tool/result.error.code = TOOL_OUTCOME_UNKNOWN` → 结果未知
  - `tool/result.error.code = ABORTED_BEFORE_DISPATCH` → 未派发（`dsh-agent-loop` 的 `appendSkippedToolCall`）
  - `tool/result.error.code = TOOL_NOT_STARTED` → 未记录启动（`dsh-session` repair）
  - 其余有结果的调用视为已完成，不进集合。
- `queued` ← 点击时刻 `inbox.nextTurn + inbox.nextStep` 里的人类消息条数（排除本插件自己的 `<resume>`）。

### 待续跑寄存器

键 = `{sessionId}:{turn}:{step}`，相位：

```
reserved ──flush 通过──▶ queued ──agent/inbox/claimed──▶ consumed
     │                      │
     └──失败/撤回──▶ (删除)  └──人类消息先到 / discarded / agent/error / 卸载──▶ revoked
```

- **先预留后准入**：同步置位 `reserved` 再 `await ctx.sessions.flush(agent.session)`；flush 之后再算一次断点，坐标变了就撤回，不入队。同一断点连续触发 10 次只有 1 条入队（后续返回 `续跑已排队`），`consumed` 之后触发恒为 `该断点已续跑过`。
- **先判后断**（Codex `InterruptIfNoPendingInput` 的对应物）：`resumeNow()` 在 `flush` 之后、`followup` 之前检查 `inbox` 里是否已有人类输入；有就直接返回 `续跑已作废（你已发送新消息）`，**不排再撤**。草稿路径同理：哨兵插入时若前面已排人类输入，哨兵被丢弃、不置寄存器。
- **人类消息优先让行**：断点待续跑（`queued`/`reserved`）时来了 `source.kind === 'user'` 的消息，寄存器转 `revoked` 并把已排队的 `<resume>` 从 inbox 撤回，不再入队。
- **已续跑后被超越**：`consumed` 的寄存器再遇到人类消息 → 转 `superseded`（只留痕给 `/resume-status`，不改历史、不影响已进入步骤的 `<resume>`）。
- **步骤前复核**：`agent/pre-step`（waterfall）在步骤进入前校验 `{register.key === 锚键}`、`phase === 'consumed'`、agent 仍存活；不通过则 `{kind:'reject'}` 并把同批被摘下的其他已领取消息放回 `next-step`（照抄 `dsh-goal-round-driver` 的 `restoreOtherClaimed`）。
- **fail-closed teardown**：卸载时 `stopped = true`，未消费的寄存器全部 `revoked`，表清空；`agent/error` 也作废该 agent 的待续跑记录。

### 装载时自动续跑（`cause=host-restart`）

`agent/created` → `seedFromSession()`（用 `session.ownEvents()` 重建最后一轮折叠 + 兜底 + 收集历史里出现过的 `<resume id>`）→ `scheduleAutoResume()`：

1. **安静窗口**（`restartSettleMs`，默认 600ms）：一次性客户端（headless / ACP）是「先建 agent、紧接着提交任务」。窗口内到达的人类消息先落地——有它就整条让行（`agent/inbox/inserted` 已经把它排进队列，`queuedCount > 0`）。
2. 窗口结束时复查：`cause === host-restart`、`agent.status === 'idle'`、`queuedCount === 0`、同键无寄存器、**历史里没有同坐标的 `<resume id>`**（跨进程去重：上一进程排过的那条还在日志里就不再点火）。
3. 通过 → `resumeNow(agent, 'auto-restart')`：`flush` → 复查断点 → 排入 `<resume>` → `rearmGoal()`。

`agent/status{idle}` 也会再排一次（兜底：装载时 agent 还没 idle）。同一断点只排一个定时器（`scheduled` 集合），teardown 清掉。

**人类消息抢占**：续跑轮已经开始、但模型还没有任何产出（`fold.produced === false`）时来了人类消息 → `agent.cancel({kind:'user'}, {keepInbox:true})` 把这轮撤掉，人的消息立刻接管。已经产出（哪怕一个 token）就不撤——撤了会丢工作，让人等到下一步边界。

### goal 重新武装（不询问轮数）

`dsh-goal` 在 `agent/created` 上**无条件 disarm**（会话启动边）。于是重启后即使插件已经续跑，`goal-round-driver` 的准入条件是 `phase==='active' && activation==='armed'`，不满足 → 不再排队下一轮，模型只能回头问「要不要继续 / 继续几轮」。

`rearmGoal(agent, reason)` 补上那次人类授权：`goals.get(agent)` 是 `active` + `disarmed` 时调 `goals.resume(agent, {id, revision})`。

- `paused` / `complete` / `blocked` **不碰**（用户暂停/收尾优先）；
- 已 `armed` 不重复 resume；
- 轮数用尽（`goals.resume` 抛 `exhausted … goal rounds`）→ 只进 `warnings`，不续跑也不改问用户；
- `goals` 服务不存在（headless 模板）→ 整段跳过，自动续跑照旧。

触发点：命令通路续跑成功后、草稿通路 `pre-step` 准入后、自动续跑入队后——都是「人已经授权」的时刻。

### 硬约束遵守情况

- **只追加**：`<resume>` 走普通 `followup` 用户消息，同一 provider/model 路由下只增长历史，不改写 surface、不重排消息。
- 系统提示贡献段是**静态常量**（`interpolate: false`），只随插件启停变化；不在步骤之间改文本，因此不会每轮换系统节点。
- 模板正文只给坐标和状态，不回贴历史、不复述用户原话；单条渲染最长 473 字符（`verify/checks.mjs` 断言上限 1200）。
- 不含二次确认措辞。

-----

<a id="prompt-contract"></a>
## 提示词契约

两种原因共用一套行序；逐字渲染（`renderResume`）：

```text
<resume id="R-{turn}-{step}" reason="{user-interrupted|host-restart}">
{原因句：用户点击停止 / 宿主进程在 turn {T} / step {S} 进行中退出（内核以 interrupted 收尾）}，断点前的活没有做完。
断点位置：turn {T} / step {S}
{若 truncated}模型输出在此处被截断，已交付部分见上一条 assistant 消息。
{若 openCalls}未闭合的工具调用：
- {toolName}({callId})：{状态}（{事实补充}）{若 shell/后台}{；…}
{若 queued}中断期间已排队 {n} 条输入，将在下一步边界交付。
续跑要求：把断点前正在做的那件事接着做完；不要询问「下一步做什么」「要不要继续」「继续几轮」，不要重新规划或复述需求，缺的事实自己查。
结果未知的调用先用只读手段核验外部状态，再决定是否重试；未派发的调用按需重新发起；不可逆动作（提交、推送、删除）先说明再执行。
本条只对紧随其后的这一轮有效：其后出现任何人类消息，以新消息为准，本条作废。
</resume>
```

三段同时成立才是正确姿势，缺一段就会掉进两个已知坑：

| 缺哪段 | 结果 |
|---|---|
| 没有「接着做完 / 不要问下一步、轮数」 | 重启或续跑后模型回来问「下一步做什么」「继续几轮」（0.1.x 的最终版就是这样，被用户投诉「停止后重启影响工作」） |
| 没有「其后人类消息优先」 | Fix issue 1：一句「你好」点火了断点前的提交动作（见 [事故与修正](#incident)） |
| 没有「结果未知先只读核验 / 不可逆先说明」 | 盲目重试 `sleep`、重复提交（实机复现过：重启后模型直接重跑 `sleep 200`，把人的新指令挤到下一轮） |

> 续跑要求是**条件祈使**，不是长期指令：作用域写在第三行，`index.js` 里由 `RESUME_DIRECTIVE_LINES` 单一来源渲染，`checks.mjs` 对三行逐字断言。

状态 → 事实（内核结果码 → 陈述）：

| 结果码 | 状态 | 事实补充 |
|---|---|---|
| `TOOL_OUTCOME_UNKNOWN` / 无结果 | 结果未知 | 已派发、未记录结果 |
| `ABORTED_BEFORE_DISPATCH` | 未派发 | —（无括号） |
| `TOOL_NOT_STARTED` | 未记录启动 | 无 tool/call 记录 |
| `TOOL_ABORTED`（实测补充） | 结果未知 | 已派发后被中止 |

`TOOL_ABORTED` 是 `dsh-tools` 导出、真实停止路径上会出现的第四个码（见 `实测记录`）。

未闭合调用最多列 5 条；超出时追加 `（另有 {n} 条未闭合调用未列出）`。

**shell/后台事实块**（附在该调用那一行的行尾；由 `classifyShellCall(name, arguments)` 判定）：

| 判定 | 追加文本（事实，不带动作） |
|---|---|
| `background`（参数里 `run_in_background`/`background`/… 为 `true`） | `；该调用是后台任务，可能仍在运行（有 job 记录）` |
| `shell`（工具名属 shell 类但未标后台） | `；该命令可能有子进程仍在运行` |
| 其它工具 / 参数不是合法 JSON | 不追加（不猜） |

### 系统提示段

```text
## 中断与续行
`<resume>` 是会话被打断后注入的一条用户消息：内容是该断点的坐标、未闭合工具调用的状态，以及把在飞工作接着做完的续跑要求。
看到它时：
- `<resume>` 只对紧随其后的这一轮有效。其后出现任何人类消息，以新消息为准，旧 `<resume>` 作废，不要按它继续。
- `<resume>` 就是当前这一轮的消息时：接着做断点前没做完的那件事。不要询问「下一步做什么」「要不要继续」「继续几轮」，不要重新规划或复述需求；能被你查到的事实自己查，只有缺用户才能提供的信息时才发问。
- 标注「结果未知」的工具调用：先用只读手段核验外部状态，再决定是否重试。
- 标注「未派发」的调用按需重新发起；不可逆动作（提交、推送、删除）先说明再执行。
```

这一段的职责是**把模型从「停下来问人」拉回「接着干」**：0.1.x 最后一版的系统段写的是「有副作用则先问用户 + 以新消息为准」，两条叠加起来正好让模型在续跑时选择发问——用户投诉的「转而询问用户下一步要做什么」就出在这里。现在把「问不问」收窄成一条可判定规则：**能被你查到的事实自己查，只有缺用户才能提供的信息才发问**。

-----

<a id="source-map"></a>
## 源码地图

| 文件 | 职责 |
|---|---|
| `index.js` | Host 半侧：`foldBreakpoint` / `deriveBreakpoint` / `renderResume` / 寄存器 / `agent/pre-step` / 命令 / 系统提示段 |
| `client.js` | Client 半侧（预构建 `__ModuleLoader__` bundle）：主发送键接管（探针 + CSS 三角 + 捕获点击），判定函数 `shouldShowPlay` |
| `…/resumeBreakpoint（Host 投影）` | `key=resumeBreakpoint`，wire 视图 `{available,turn,step,truncated,cause,openCalls}`，客户端 `faceOf('resumeBreakpoint')` 读同一个键；`pending` 不新增状态，读官方 `inbox` 投影 |
| `cordis.patch.yml` | bundle patch：单行 insert，同一行同时是 Host 行与浏览器 roster 行 |
| `verify/checks.mjs` | 纯函数验收：两种 cause 的派生、崩溃尾巴兜底、`renderResume` 六分支逐字比对、续跑要求三行、投影、系统段 |
| `verify/client-bundle.mjs` | Client bundle 验收：判定表、pending 判定、样式契约、slot 注册与钩子名 |
| `verify/live-background.mjs` | 实机补充：断点落在 shell 类调用上时 `<resume>` 必须带「先核 job/子进程，不要重跑」 |
| `verify/live-hello.mjs` | 事故回归：中断后只发「你好」，模型不得继续旧待办 |
| `verify/host-stub.mjs` | 宿主桩验收：幂等 / 让行 / 草稿替换 / 失败文案 / 提示段 / **装载自动续跑（含安静窗口、去重、抢占、goal 重武装）** |
| `node_modules/@deepseek-ai/*` | 随包分发 `schemastery` + `cosmokit`（`link:` 安装不装依赖；逐包版本与许可证见 [`vendor-NOTICE.md`](vendor-NOTICE.md)） |

`createResumeMessage()` 与 `@deepseek-ai/dsh-llm` 的 `createUserMessage()` 同构（`role:'user'` + 全新 uuid + 逐字 content），因此不额外 vendor `dsh-llm` 及其依赖树。

-----

<a id="verification"></a>
## 实测记录

### 1. 纯函数与宿主桩（不需要 dsh 运行时）

```sh
node verify/checks.mjs        # 72/72 passed（两种 cause / 崩溃尾巴兜底 / 逐字模板 / 投影 / 系统段）
node verify/host-stub.mjs     # 70/70 passed（先判后断、superseded 留痕、装载自动续跑、安静窗口、抢占、goal 重武装）
node verify/client-bundle.mjs # 29/29 passed（三角判定 / pending / 样式 / slot）
```

覆盖：

- `renderResume` 六个分支逐字比对（用户停止 / 宿主重启 / truncated / 结果未知 / 未派发 / 排队输入）+ 组合行序 + 5 条上限与计数 + `TOOL_ABORTED` 映射。
- 派生：aborted 末轮、interrupted 末轮 → `cause=host-restart`、`causeOf` 四态、`queued` 透传、已完成调用被排除、断点键、正常完成无断点、后续轮清除旧断点、空日志、活轮。
- 兜底与去重：`openTailSnapshot` 把「日志停在轮内」转成 `host-restart` 断点；历史里（`user/message` 与 `agent/inbox/spliced` 两种落盘形状）出现过的 `<resume id>` 被记住。
- 装载自动续跑：重启断点 → 入队 1 条 `transport=auto-restart`、正文含原因与续跑要求；用户停止 → 不自动续跑（点一次才续）；排队有人类输入 → 让行；同坐标已续跑过 → 不重复；断点被消费后 → 不再点火。
- 安静窗口：窗口内到达的人类消息 → 不自动续跑、不排寄存器；窗口结束无人插话 → 照常。
- 抢占：续跑轮无产出时人类消息 → `cancel({kind:'user'},{keepInbox:true})` 撤轮且人类消息留在队列；已产出 → 不撤轮。
- goal 重武装：`active+disarmed` → 一次 `resume`；`paused` / 已 `armed` / 无 `goals` 服务 → 不动作；`resume` 抛错 → 只记 warning。
- 幂等：同一 `{turn,step}` 连续 10 次 → 入队 1 条；`claimed` 后 5 次 → 0 条且文案为「该断点已续跑过」。
- 让行：人类消息插入 → 寄存器 `revoked/human-message`，已排队 `<resume>` 被撤回，人类消息保留。
- 草稿路径：哨兵入队即置位、第二个哨兵被丢弃、`pre-step` 把哨兵替换成 `<resume>`（与派生快照渲染逐字一致，哨兵字符不存在于历史消息里）。
- 失败文案：flush 抛错 → `续跑未启动：write path closed`，不入队、不留寄存器。
- 投影：aborted 末轮 → `{available:true, turn, step}`；新 `turn/start` → `available:false`；无关事件原引用返回（不触发发布）。
- 主键判定：`available && !running && draft.trim()==='' && phase==='plain' && pending===false` 才变三角；投影未到达、运行中、草稿有字、提交中、**续跑已在 inbox 排队**都是原生键；
  样式里 `> svg { display:none }`、三角 `fill='none'`（空心）、且不含「继续」二字。
- 先判后断：有排队人类输入时 `/resume` 返回 `续跑已作废（你已发送新消息）`、不入队、不留寄存器；草稿哨兵同样被丢弃。
- 后台判定：`run_in_background:true` → `background`；`bash`/`shell_exec`/`run_command`… 无标记 → `shell`；非 shell 工具或非法 JSON → 不标；
  两种判定各自对应一条行尾提示，普通工具调用不加提示。

### 1b. 0.2.0 本轮实证（真实 dsh 进程，隔离 profile `resume-probe`）

这一轮要证的是「重启后自己接着干，而不是问人」，所以证据分三步：

**① 新系统段确实进了真实进程**（不是只在桩里）：

```sh
dsh --profile resume-probe --json '你的系统提示里有一节标题是「## 中断与续行」。把该节第二行正文逐字复述出来…'
# final: "`<resume>` 是会话被打断后注入的一条用户消息：内容是……以及把在飞工作接着做完的续跑要求。"
```

**② 宿主在轮内被杀 → 内核补 interrupted 闭包**（`session-036b526b…`）：

```sh
dsh --profile resume-probe --json "用 bash 工具执行：sleep 200; echo done" &   # 22s 后 kill -9
# 日志尾：seq 17 tool/call → 归档后重启装载，内核补
#   tool/result {error:{code:TOOL_OUTCOME_UNKNOWN}} → step/end → turn/end {reason:{kind:'interrupted'}}
```

**③ 两个方向都实机对照过**：

- **旧构建（0.1.0 + 无安静窗口）**：重启装载后插件立刻排入 `<resume>`（该会话 seq 22 就是那条消息的全文本），`turn/start` 抢在人类任务之前 → 模型去 `ps`+重跑 `sleep 240`，人的新指令被挤到 `nextTurn` 直到进程被杀。**这就是「重启影响工作」的机理。**
- **新构建（0.2.0）**：同一形状重跑（`session-036b526b…`）——重启时人类任务先落地 → 安静窗口判定让行 → 日志里**没有任何 `<resume id=`**（`grep` 为 false），`final` = 「我在。」，零工具调用；旧的 `sleep` 没有被重跑。

**④ goal 重武装**：宿主里 `ctx.goals` 是活服务（`Service` 目录有 `goal`-related 契约：`get/disarm/create/resume/pause/complete/block/clear`）；装载时 `agent/created` 无条件 `disarm` 是 `dsh-goal/lib/index.js:595` 的事实，插件在续跑时刻按 `phase==='active' && activation==='disarmed'` 补 `resume`——这条在桩里逐条断言（armed 不重复、paused 不碰、轮数用尽抛错只记 warning）。

### 2. 在线 host 实机（127.0.0.1:3080 的活体进程，真实模型）

安装（等价 `install_bundle`：pnpm add `link:` + 选入 `dsh.profile.bundles`；profile 带 `hmr` 行，选用变化被在线重新读取）：

```sh
dsh plugin --profile web add link:/abs/path/to/dsh-resume
# profile package.json → dsh.profile.bundles 追加 "dsh-resume"
dsh --profile web --dump-config | grep -A6 'dsh-resume'   # 组合树里有这一行
```

行已生效的运行时证据（Web GUI 的 auth cookie 走 `/api` 的同一套 RPC）：

```sh
# command catalog（真实 RPC，agentId = 会话 id）
POST /api/commands/list → ["...","resume","resume-status", ...]
# client bundle：boot graph 里已有 dsh-resume，且宿主直接下发
GET /plugins/??dsh-resume/client.js&rev=…  → 200（与本包 client.js 原文一致）
```

端到端（`verify/live-e2e.mjs`，等价于「跑长任务 → 点停止 → 点一次主键」，RPC 面而非 DOM 点击）：

```sh
node verify/live-e2e.mjs <cookie>
# 12/12 passed  (session session-ecc04192-475b-48c7-b0ad-19d1bc14ad82)   ← 旧版（无投影）
# 14/14 passed  (session session-39e2fab2-…)                            ← 新版，见下
```

带投影的新版在**隔离实例**上跑（`DSH_HOME=/tmp/dsh-home-probe`，profile `resume-web`，`--port 3181`，
不碰用户的 3080 状态）：

```sh
projection before resume: {"available":true,"turn":1,"step":2,...}
projection after  resume: {"available":false,"turn":null,"step":null,...}
14/14 passed  (session session-39e2fab2-cb67-4eda-a815-e37c154b9d33)
```

同实例的 client bundle（新代码）：`/plugins/??dsh-resume/client.js&rev=…` → 10237 bytes，含 `data-dsh-resume-play` / `shouldShowPlay`。

A 组三条的实机复核（同一隔离实例，`/tmp/dsh-home-probe` + `--port 3181`）：

```sh
node verify/live-e2e.mjs <cookie>          # 14/14 passed（回归）
node verify/live-background.mjs <cookie>   # 7/7 passed（A#3）
```

`live-background` 的真实 `<resume>`（前台 `sleep 25` 在中断时未闭合 → `shell` 判定命中）：

```text
- bash(call_00_1s6Pwv5rnGKHWRLUDhVR1248)：结果未知 → 先以只读方式核验外部状态；写类操作须先问用户（该命令可能仍有子进程在跑：先核验进程/文件状态，不要直接重跑）
```

`inbox` 投影的真实键名也核对过：`{"next-turn": [], "next-step": []}`（A#1 的 pending 判定读的就是它）。

事实版模板的实机复核（同一隔离实例，新代码）：

```sh
node verify/live-hello.mjs <cookie>        # 5/5  —— 中断后只发「你好」：只打招呼 + 报告状态 + 问要不要继续，标记文件未创建
node verify/live-e2e.mjs <cookie>          # 16/16 —— 点续跑仍然照常接着干（含「取消必成 aborted」的确定性断言）
node verify/live-background.mjs <cookie>   # 7/7   —— shell/后台事实仍在
```

**活体 3080（真实 GUI 宿主）**：在 22:26 那次重启后，宿主已带投影——

```sh
POST /api/session/projections → values.resumeBreakpoint = {"available":false,...}   # 键已在 wire 上
GET  /plugins/??dsh-resume/client.js&rev=…  → 11389 bytes（含 data-dsh-resume-play / selectPendingResume）
node verify/live-e2e.mjs <cookie>            # 14/14 passed（session session-5a5eb7e8-…）
```

注意：该宿主进程装载的是 **22:26 那版 Host 模块**，所以那次 `<resume>` 里的 bash 调用**还没有** shell 提示；A#2（先判后断）与 A#3（后台提示）在 Host 侧要**再重启一次** `dsh web` 才生效（client 侧是请求时读盘，已是最新）。

⚠️ **Host 代码只能靠重启装载**：dsh 的 HMR 会重建行、但 Node 的 ESM 缓存让 `link:` 包的旧模块继续生效
（实测：改完 index.js → 触发 HMR → `session/projections` 里仍无新键，`disable→enable` 也不变）。
每改一次 Host 半侧都要重启一次 `dsh web`；client bundle 是请求时读盘，刷新页面即是最新。
顺带一条实测结论：**重启 `dsh web` 不会丢当前会话**——验证这一轮本身就是宿主重启后从 rollout resume 继续的（同一 session、同一对话）。

该次运行的真实 `<resume>`（`turn 1 / step 1`，4 个 bash 并行调用中 1 个已派发被中止、3 个未派发）：

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

续跑之后模型接着干（没有重新规划、没有重新问需求）：`assistant/message` → `bash(sleep 5; echo step-2)` → 结果 → `bash(... step-3)` …；同一次运行里再点一次 `/resume` 被拒（`该断点已续跑过`/`没有可续跑的断点`），历史前缀逐条一致（只追加）。

附：真实停止路径上还观察到一个已派发后被中止的调用（`TOOL_ABORTED`，内容 `Error: tool call aborted`），它被正确算成「结果未知」而不是已完成。

### 3. 系统提示段进没进模型

隔离的临时 profile（`$DSH_HOME/profiles/resume-probe`，headless 模板 + 本插件）跑真实任务：

```sh
dsh --profile resume-probe --json "你的系统提示里有没有标题为『中断与续行』的一节？只回答 有 或 没有，不要解释。"
# final: "有"
```

-----

### <a id="incident"></a>事故与修正：一句「你好」触发了旧的提交动作

会话 `session-e8ca28a3…`（Fix issue 1）里，用户中断后只打了「你好」，模型却去执行了断点前的待办（一次真实的代码提交，真的产生了提交记录）。证据是那一轮模型自己的推理：

> “The user just says 你好 (hello)… **The resume marker says continue from breakpoint.**… So execute.”

成因（全部是本插件提示词的缺陷，不是用户操作）：

1. `<resume>` 是**祈使句**，且作为 `user/message` 永久留在历史里（该会话堆了 3 条），续跑完成后也不会失效；
2. 系统段当时写的是「不要重新确认需求。直接从断点继续。」——没有有效期，也压掉了“执行有外部副作用的旧动作前先问一句”；
3. 断点内容是高风险旧意图（提交），新消息是零信息量寒暄，权重被措辞倒置。

修正（两轮）：第一轮删掉“从断点继续 / 不重新确认需求”，只留坐标/状态 + 一句“以新消息为准”；第二轮把剩下的窄域动作指令（“先只读核验”“如仍需要则重新发起”“不要重跑”“不要复述”）也改成事实陈述，末行改为“本条只记录断点坐标与工具调用状态”，系统段改成“只描述事实 + 以新消息为准 + 外部副作用先说明再做”。回归用例见 `verify/live-hello.mjs`（中断 → 只发「你好」→ 断言不再执行旧待办、标记文件不存在）。

### 第三轮（0.2.0）：把方向盘还回来，但装上作用域

前两轮修过头了：模板里一句祈使都没有之后，模型在续跑时**没有继续的授权**，只能回来问「下一步做什么 / 继续几轮」——这就是用户这次投诉的「停止后重启会影响工作」。而且 `aborted` 之外的中断（宿主进程退出 → `reason.kind:'interrupted'`）根本不派生断点，只能靠用户重述。

本轮的解法是把「授权」和「有效期」同时写进同一条消息，而不是二选一：

- `<resume>` 恢复**续跑要求**（接着做完、不许问下一步/轮数、缺的事实自己查）；
- 但这条要求自带作用域：**只对紧随其后的这一轮有效；其后出现任何人类消息，以新消息为准，本条作废**——上一轮的事故场景（「你好」）由这一行拦住，而不是靠删掉全部祈使；
- 中断原因分家：`aborted` → 等用户点；`interrupted` → 装载后安静窗口内无人插话就自己续跑；
- 系统段把「要不要问人」收窄成可判定规则（只有缺用户才能提供的信息才发问），而不是原来那句会诱导发问的「有副作用则先问用户」。

两侧回归：`verify/live-hello.mjs`（不许被「你好」点火）与 `verify/host-stub.mjs`（装载自动续跑 / 安静窗口 / 抢占）同时是必过项；实机对照见 [实测记录 1b](#verification)。

-----

<a id="limitations"></a>
## 已知限制

- **入口按钮常显**：客户端只按 `InputState.phase` 决定可用性，不反查服务端断点；没有断点时点一下会收到 `续跑未启动：没有可续跑的断点` 的会话告警。要多精确需要额外的主机侧 remote，本版没做。
- **`queued` 计数只在草稿路径上实际可达**：命令通路现在是「先判后断」（有排队输入就拒绝），所以 `<resume>` 里那句「已排队 n 条输入」只会在草稿路径（哨兵插入后、`pre-step` 渲染前又来了人类输入）出现；契约分支保留并单测覆盖，但命令通路上不会触发。
- **`background` 判定分支未实机复现**：后台任务在中断前通常已经返回 job id（不处于未闭合状态），实机命中的是 `shell` 分支；`background` 分支由单测逐字覆盖。
- **自动续跑只认 `cause=host-restart`**：`aborted`（用户点了停止）重启后**不会**自己跑——停止是人的意思，重新打开宿主不该撤销它。要它继续就点一次主键或 `/resume`，点了之后同样不问下一步/轮数。
- **安静窗口是启发式**：`restartSettleMs`（默认 600ms）用来让「建完 agent 立刻提交任务」的客户端先落地。慢于这个窗口才提交的任务仍可能被续跑轮抢一轮（抢占只覆盖「续跑轮还没产出」的情形）。要更稳就调大它，或把 `autoResumeOnRestart` 关掉只保留手动续跑。
- **抢占只在无产出时撤轮**：模型已经产出（哪怕一句 reasoning）就不撤，人类消息等到下一步边界——这是为了不丢工作，代价是可能多花一轮 token。
- **续跑轮被抢占后留一个 `aborted` 断点**：下一次 `resume` 会看见它（`cause=user-interrupted`），属于事实留痕，不清扫。
- **`produced` 只活在折叠状态里**：抢占判定读的是「本 turn 有没有 `assistant/message`」，与投影的 wire 视图无关（视图仍是 `{available,turn,step,truncated,cause,openCalls}`）。
- **跨进程恢复依赖 `session.ownEvents()`**：插件在 `agent/created` 时用这个（已标记 deprecated 的）读路径重建最后一轮折叠；dsh 若移除它，这里要换成 `session/event` 回放 + 冷读 API。
- **系统提示段是新贡献**：首次启用会给每个会话的有效系统提示加一段；这是本功能存在的代价，文本本身逐字恒定，不会随轮次变化。
- **主键接管没有在真实 DOM 里看过**：判定表、CSS 契约、slot 注册都有自动化（`client-bundle.mjs`），bundle 也确实由宿主下发，
  但「三角是不是正好盖住原生箭头、点下去是否只跑一次」需要人眼看一次浏览器（本机没有浏览器自动化，且重启宿主会杀掉当前会话）。
  接管是 DOM 级动作，依赖两个稳定钩子：`[data-composer-card]`（shell 自带的数据属性）与 class 含 `primary` 的按钮；
  两个都找不到时**静默退化**成原生发送键，不会报错、不会卡住输入。
- **`install_bundle` 工具面没走**：本会话未挂载 `plugin_manager` 工具，改用它的 CLI 等价操作（`dsh plugin … add` + 选入 bundles），并用 `/api` 的真实 RPC 与 boot graph 复核行已生效。
- **没有自动清理测试会话**：实机验收在 GUI 里留下两个普通会话（`session-ce273ee8-3817-4363-b47a-4c0330fcd57a`、`session-ecc04192-475b-48c7-b0ad-19d1bc14ad82`），不影响 profile 状态。
- **草稿备用路径只有桩验证**：真实宿主上 RPC 提交的消息 `source` 恒为 `{kind:'user'}`（`dsh-api-session-controller` 的 `prompt()` 写死），所以「`source.kind='resume-draft'`」只能由 Host 用 transport 分类 + `pre-step` 重写来实现——这条路径在 `host-stub.mjs` 里逐字验证过，没有在浏览器里点过。
