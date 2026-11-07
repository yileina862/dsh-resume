// dsh-resume 验收：断点派生（两种原因）+ renderResume 逐字契约 + 投影 + 系统段。
//
// 用法：node plugins/dsh-resume/verify/checks.mjs
// 退出码：0 = 全通过；1 = 有失败（打印失败项）。
//
// 本轮（0.2.0）新增的必过项：
//   - turn/end reason.kind='interrupted'（宿主在轮内退出）也派生断点，cause=host-restart；
//   - 日志停在轮内（无 turn/end）→ openTailSnapshot 兜底成 host-restart 断点；
//   - <resume> 带**作用域限定**的续跑要求：接着做完、不问下一步/轮数，且其后人类消息作废它；
//   - 历史里出现过的 <resume id> 被记住，跨进程不重复自动续跑。

import {
  PROJECTION_KEY,
  BACKGROUND_HINT,
  CAUSE_RESTART,
  CAUSE_USER,
  RESUME_DIRECTIVE_LINES,
  TOOL_ABORTED,
  TOOL_ABORTED_BEFORE_DISPATCH,
  TOOL_NOT_STARTED,
  TOOL_OUTCOME_UNKNOWN,
  SYSTEM_SECTION,
  breakpointKey,
  causeOf,
  classifyShellCall,
  deriveBreakpoint,
  initialFold,
  isAutoResumable,
  openTailSnapshot,
  projectionApply,
  projectionView,
  renderResume,
  resumeBreakpointProjection,
  resumeIdOf,
  foldBreakpoint,
} from "../index.js";

const results = [];
let failures = 0;
function ok(name, condition, detail) {
  if (condition) {
    results.push({ name, ok: true });
    return;
  }
  failures += 1;
  results.push({ name, ok: false, detail });
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

// ── 事件构造帮手 ───────────────────────────────────────────────────────────

const ev = (type, data) => ({ type, data });

function prompt(turn, text = "把插件装好并跑验收") {
  return ev("user/message", { id: `u-${turn}`, role: "user", content: [{ type: "text", text }], source: { kind: "user" } });
}
const turnStart = (turn) => ev("turn/start", { turn });
const stepStart = (turn, step) => ev("step/start", { turn, step });
const stepEnd = (turn, step) => ev("step/end", { turn, step });
const turnEndAborted = (turn) => ev("turn/end", { turn, reason: { kind: "aborted", reason: { kind: "user" } } });
const turnEndCompleted = (turn) => ev("turn/end", { turn, reason: { kind: "completed" } });
/** 宿主在轮内退出后，内核装载时补的闭包（dsh-session openTurnClosers）。 */
const turnEndInterrupted = (turn) => ev("turn/end", { turn, reason: { kind: "interrupted" } });
const assistant = (turn, step, extra = {}) =>
  ev("assistant/message", { turn, step, message: { id: `a-${turn}-${step}` }, stream: [], ...extra });
const toolCall = (turn, step, callId, name) => ev("tool/call", { turn, step, callId, name, arguments: "{}" });
const toolResult = (turn, step, callId, code) =>
  ev("tool/result", {
    turn,
    step,
    message: { id: `r-${callId}`, role: "tool", toolCallId: callId, content: [{ type: "text", text: code === undefined ? "ok" : "Error" }], isError: code !== undefined },
    ...(code === undefined ? {} : { error: { name: "AbortError", code } }),
  });

// ── 1) renderResume：逐字比对（两种原因 × 事实分支） ───────────────────────

const HEAD = (turn, step, cause = CAUSE_USER) => `<resume id="R-${turn}-${step}" reason="${cause}">`;
const TAIL = "</resume>";
const FACT_USER = (turn, step) => `上一轮在 turn ${turn} / step ${step} 被用户点击停止，断点前的活没有做完。`;
const FACT_RESTART = (turn, step) => `宿主进程在 turn ${turn} / step ${step} 进行中退出（内核以 interrupted 收尾），断点前的活没有做完。`;
const POS = (turn, step) => `断点位置：turn ${turn} / step ${step}`;
/** 续跑要求三行（逐字来自 RESUME_DIRECTIVE_LINES，这里是断言面）。 */
const DIRECTIVE = [
  "续跑要求：把断点前正在做的那件事接着做完；不要询问「下一步做什么」「要不要继续」「继续几轮」，不要重新规划或复述需求，缺的事实自己查。",
  "结果未知的调用先用只读手段核验外部状态，再决定是否重试；未派发的调用按需重新发起；不可逆动作（提交、推送、删除）先说明再执行。",
  "本条只对紧随其后的这一轮有效：其后出现任何人类消息，以新消息为准，本条作废。",
];

eq("续跑要求常量与断言面一致", [...RESUME_DIRECTIVE_LINES], DIRECTIVE);

const cases = [
  {
    name: "分支 1/6：用户停止 · 无调用无截断无排队",
    snapshot: { sessionId: "s", turn: 7, step: 3, truncated: false, cause: CAUSE_USER, openCalls: [], queued: 0 },
    expected: [HEAD(7, 3), FACT_USER(7, 3), POS(7, 3), ...DIRECTIVE, TAIL].join("\n"),
  },
  {
    name: "分支 2/6：宿主重启 · 无调用无截断无排队",
    snapshot: { sessionId: "s", turn: 7, step: 3, truncated: false, cause: CAUSE_RESTART, openCalls: [], queued: 0 },
    expected: [HEAD(7, 3, CAUSE_RESTART), FACT_RESTART(7, 3), POS(7, 3), ...DIRECTIVE, TAIL].join("\n"),
  },
  {
    name: "分支 3/6：截断（用户停止）",
    snapshot: { sessionId: "s", turn: 4, step: 2, truncated: true, cause: CAUSE_USER, openCalls: [], queued: 0 },
    expected: [
      HEAD(4, 2),
      FACT_USER(4, 2),
      POS(4, 2),
      "模型输出在此处被截断，已交付部分见上一条 assistant 消息。",
      ...DIRECTIVE,
      TAIL,
    ].join("\n"),
  },
  {
    name: "分支 4/6：结果未知调用",
    snapshot: {
      sessionId: "s",
      turn: 9,
      step: 5,
      truncated: false,
      cause: CAUSE_RESTART,
      openCalls: [{ callId: "call_abc", name: "shell_exec", status: TOOL_OUTCOME_UNKNOWN }],
      queued: 0,
    },
    expected: [
      HEAD(9, 5, CAUSE_RESTART),
      FACT_RESTART(9, 5),
      POS(9, 5),
      "未闭合的工具调用：",
      "- shell_exec(call_abc)：结果未知（已派发、未记录结果）",
      ...DIRECTIVE,
      TAIL,
    ].join("\n"),
  },
  {
    name: "分支 5/6：未派发调用",
    snapshot: {
      sessionId: "s",
      turn: 12,
      step: 1,
      truncated: false,
      cause: CAUSE_USER,
      openCalls: [{ callId: "call_def", name: "edit_file", status: TOOL_ABORTED_BEFORE_DISPATCH }],
      queued: 0,
    },
    expected: [
      HEAD(12, 1),
      FACT_USER(12, 1),
      POS(12, 1),
      "未闭合的工具调用：",
      "- edit_file(call_def)：未派发",
      ...DIRECTIVE,
      TAIL,
    ].join("\n"),
  },
  {
    name: "分支 6/6：排队输入",
    snapshot: { sessionId: "s", turn: 15, step: 4, truncated: false, cause: CAUSE_USER, openCalls: [], queued: 2 },
    expected: [
      HEAD(15, 4),
      FACT_USER(15, 4),
      POS(15, 4),
      "中断期间已排队 2 条输入，将在下一步边界交付。",
      ...DIRECTIVE,
      TAIL,
    ].join("\n"),
  },
];

for (const item of cases) {
  eq(item.name, renderResume(item.snapshot), item.expected);
}

// 组合：截断 + 未记录启动 + 排队，顺序 = 截断 → 调用 → 排队 → 续跑要求
eq(
  "组合分支：截断 + TOOL_NOT_STARTED + 排队（行序固定）",
  renderResume({
    sessionId: "s",
    turn: 3,
    step: 8,
    truncated: true,
    cause: CAUSE_RESTART,
    openCalls: [{ callId: "call_x", name: "write", status: TOOL_NOT_STARTED }],
    queued: 1,
  }),
  [
    HEAD(3, 8, CAUSE_RESTART),
    FACT_RESTART(3, 8),
    POS(3, 8),
    "模型输出在此处被截断，已交付部分见上一条 assistant 消息。",
    "未闭合的工具调用：",
    "- write(call_x)：未记录启动（无 tool/call 记录）",
    "中断期间已排队 1 条输入，将在下一步边界交付。",
    ...DIRECTIVE,
    TAIL,
  ].join("\n"),
);

// 真实停止路径的第四个码：TOOL_ABORTED（已派发后被中止）→ 结果未知
eq(
  "分支补充：TOOL_ABORTED 映射为结果未知",
  renderResume({
    sessionId: "s",
    turn: 5,
    step: 2,
    truncated: false,
    cause: CAUSE_USER,
    openCalls: [{ callId: "call_live", name: "bash", status: TOOL_ABORTED }],
    queued: 0,
  }),
  [
    HEAD(5, 2),
    FACT_USER(5, 2),
    POS(5, 2),
    "未闭合的工具调用：",
    "- bash(call_live)：结果未知（已派发后被中止）",
    ...DIRECTIVE,
    TAIL,
  ].join("\n"),
);

// 后台/命令类调用的判定与提示
eq("classify：明确后台任务", classifyShellCall("bash", '{"command":"sleep 9","run_in_background":true}'), "background");
eq("classify：shell 类未标后台", classifyShellCall("bash", '{"command":"sleep 9"}'), "shell");
eq("classify：大写工具名也认", classifyShellCall("Bash", '{"command":"ls"}'), "shell");
eq("classify：非 shell 工具不标", classifyShellCall("read_file", '{"path":"a.txt"}'), undefined);
eq("classify：参数不是 JSON 时不标（不猜）", classifyShellCall("read_file", "not-json"), undefined);
eq("classify：shellexec 变体命中后台键", classifyShellCall("run_command", '{"background":true}'), "background");

eq(
  "renderResume：后台任务的未闭合调用补 job 提示",
  renderResume({
    sessionId: "s",
    turn: 6,
    step: 1,
    truncated: false,
    cause: CAUSE_RESTART,
    openCalls: [{ callId: "call_bg", name: "bash", status: TOOL_OUTCOME_UNKNOWN, background: "background" }],
    queued: 0,
  }),
  [
    HEAD(6, 1, CAUSE_RESTART),
    FACT_RESTART(6, 1),
    POS(6, 1),
    "未闭合的工具调用：",
    `- bash(call_bg)：结果未知（已派发、未记录结果）${BACKGROUND_HINT.background}`,
    ...DIRECTIVE,
    TAIL,
  ].join("\n"),
);

ok(
  "renderResume：普通工具调用不加后台提示",
  !renderResume({
    sessionId: "s",
    turn: 6,
    step: 3,
    truncated: false,
    cause: CAUSE_USER,
    openCalls: [{ callId: "call_r", name: "read_file", status: TOOL_OUTCOME_UNKNOWN }],
    queued: 0,
  }).includes("job_output"),
  {},
);

// 回归：模板里不得出现「无作用域」的祈使，也不得回到坏掉的两种极端
const allRenders = cases.map((item) => renderResume(item.snapshot)).concat([
  renderResume({
    sessionId: "s",
    turn: 1,
    step: 1,
    truncated: true,
    cause: CAUSE_RESTART,
    openCalls: [{ callId: "c1", name: "bash", status: TOOL_OUTCOME_UNKNOWN, background: "shell" }],
    queued: 2,
  }),
]);
for (const forbidden of [
  // Fix issue 1 之前那版：无有效期、无副作用口径的绝对祈使
  "不复述、不重问",
  "不重新确认需求",
  "第一条产出要么是工具调用",
  "直接从断点继续",
  // codex 式的窄域祈使也进不了模板（改成事实陈述）
  "先以只读方式核验",
  "如仍需要则重新发起",
  "不要重跑",
  "先 job_list",
]) {
  ok(
    `模板不含无作用域祈使：${forbidden}`,
    allRenders.every((text) => !text.includes(forbidden)),
    { hit: allRenders.filter((text) => text.includes(forbidden)).length },
  );
}
ok(
  "每条 <resume> 都带「以新消息为准」的作用域声明",
  allRenders.every((text) => text.includes("其后出现任何人类消息，以新消息为准，本条作废。")),
  { missing: allRenders.filter((text) => !text.includes("本条作废")).length },
);
ok(
  "每条 <resume> 都禁止询问下一步/轮数",
  allRenders.every((text) => text.includes("不要询问「下一步做什么」「要不要继续」「继续几轮」")),
  { missing: allRenders.filter((text) => !text.includes("不要询问「下一步做什么」")).length },
);
ok(
  "每条 <resume> 都要求把在飞的工作接着做完",
  allRenders.every((text) => text.includes("把断点前正在做的那件事接着做完")),
  { missing: allRenders.filter((text) => !text.includes("接着做完")).length },
);

// 上限：7 条只列 5 条，其余计数
const many = Array.from({ length: 7 }, (_, index) => ({
  callId: `call_${index}`,
  name: "shell_exec",
  status: TOOL_OUTCOME_UNKNOWN,
}));
const manyText = renderResume({
  sessionId: "s",
  turn: 2,
  step: 2,
  truncated: false,
  cause: CAUSE_USER,
  openCalls: many,
  queued: 0,
});
eq("未闭合调用上限：列 5 条", manyText.split("\n").filter((line) => line.startsWith("- ")).length, 5);
ok("未闭合调用上限：其余计数", manyText.includes("（另有 2 条未闭合调用未列出）"), { manyText });

// 模板体积：<= 1500 字符（CJK 按 1 字 ≈ 1 token 记，留 4 倍余量）
const sizes = cases.map((item) => renderResume(item.snapshot).length).concat([manyText.length, SYSTEM_SECTION.length]);
ok(`模板体积受控（最大 ${Math.max(...sizes)} 字符）`, Math.max(...sizes) <= 1500, { sizes });

// ── 2) 断点派生：事件 → 快照 ───────────────────────────────────────────────

// 原因映射：只有 aborted / interrupted 是中断
eq("cause：aborted → 用户停止", causeOf({ kind: "aborted" }), CAUSE_USER);
eq("cause：interrupted → 宿主重启", causeOf({ kind: "interrupted" }), CAUSE_RESTART);
eq("cause：completed 不是中断", causeOf({ kind: "completed" }), null);
eq("cause：error 不是中断（错误路径不自动续跑）", causeOf({ kind: "error" }), null);
eq("cause：缺字段不猜", causeOf(undefined), null);
eq("自动续跑只认 host-restart", [isAutoResumable({ cause: CAUSE_USER }), isAutoResumable({ cause: CAUSE_RESTART }), isAutoResumable(null)], [
  false,
  true,
  false,
]);

// 场景 A：用户中止，assistant 锚点 interrupted，一个调用已提交结果、一个未提交、一个未派发
const scenarioAbort = [
  prompt(1),
  turnStart(1),
  stepStart(1, 1),
  ev("system/message", { turn: 1, step: 1, message: { id: "sys" } }),
  toolCall(1, 1, "call_done", "read_file"),
  toolResult(1, 1, "call_done"),
  assistant(1, 1),
  stepEnd(1, 1),
  stepStart(1, 2),
  toolCall(1, 2, "call_unknown", "shell_exec"),
  toolCall(1, 2, "call_skipped", "edit_file"),
  toolResult(1, 2, "call_skipped", TOOL_ABORTED_BEFORE_DISPATCH),
  assistant(1, 2, { interrupted: true }),
  stepEnd(1, 2),
  turnEndAborted(1),
];

eq(
  "派生：aborted 末轮 → 断点坐标 / 原因 / 未闭合集合",
  deriveBreakpoint("s1", scenarioAbort, 0),
  {
    sessionId: "s1",
    turn: 1,
    step: 2,
    truncated: true,
    cause: CAUSE_USER,
    openCalls: [
      { callId: "call_unknown", name: "shell_exec", status: TOOL_OUTCOME_UNKNOWN, background: "shell" },
      { callId: "call_skipped", name: "edit_file", status: TOOL_ABORTED_BEFORE_DISPATCH },
    ],
    queued: 0,
  },
);

eq("派生：queued 透传", deriveBreakpoint("s1", scenarioAbort, 3).queued, 3);
eq(
  "派生：completes 的调用不进未闭合集合",
  deriveBreakpoint("s1", scenarioAbort, 0).openCalls.some((call) => call.callId === "call_done"),
  false,
);
eq("派生：断点键", breakpointKey(deriveBreakpoint("s1", scenarioAbort, 0)), "s1:1:2");
eq("派生：末轮正常完成 → 无断点", deriveBreakpoint("s2", [...scenarioAbort.slice(0, -1), turnEndCompleted(1)], 0), null);
eq("派生：后续轮开始 → 旧断点消失", deriveBreakpoint("s2", [...scenarioAbort, turnStart(2)], 0), null);
eq("派生：空日志 → 无断点", deriveBreakpoint("s3", [], 0), null);
eq(
  "派生：只有 turn/start 的活轮 → 无断点（活轮不当断点，装载时另走 openTail）",
  deriveBreakpoint("s4", [prompt(1), turnStart(1), stepStart(1, 1)], 0),
  null,
);

// 场景 B：宿主在轮内退出 —— 真实事故形状（session-fbcb5c6b：ask_user_question 已派发、
// 结果未落盘，内核装载时补 TOOL_OUTCOME_UNKNOWN + step/end + turn/end interrupted）
const scenarioRestart = [
  prompt(1),
  turnStart(1),
  stepStart(1, 10),
  toolCall(1, 10, "call_ask", "ask_user_question"),
  toolResult(1, 10, "call_ask", TOOL_OUTCOME_UNKNOWN),
  stepEnd(1, 10),
  turnEndInterrupted(1),
];
eq(
  "派生：interrupted 末轮 → cause=host-restart，未闭合调用按结果未知",
  deriveBreakpoint("s7", scenarioRestart, 0),
  {
    sessionId: "s7",
    turn: 1,
    step: 10,
    truncated: false,
    cause: CAUSE_RESTART,
    openCalls: [{ callId: "call_ask", name: "ask_user_question", status: TOOL_OUTCOME_UNKNOWN }],
    queued: 0,
  },
);
eq("派生：interrupted 断点键与 aborted 同构", breakpointKey(deriveBreakpoint("s7", scenarioRestart, 0)), "s7:1:10");
ok(
  "派生 → renderResume：interrupted 走 restart 文案（不是「用户点击停止」）",
  renderResume(deriveBreakpoint("s7", scenarioRestart, 0)).includes("宿主进程在 turn 1 / step 10 进行中退出"),
  { text: renderResume(deriveBreakpoint("s7", scenarioRestart, 0)) },
);

// 场景 C：日志停在轮内，没有闭包可折叠 → openTailSnapshot 兜底
const openTailEvents = [
  prompt(1),
  turnStart(1),
  stepStart(1, 4),
  toolCall(1, 4, "call_half", "bash"),
  assistant(1, 4),
];
const openState = (() => {
  const state = initialFold("s8");
  for (const event of openTailEvents) foldBreakpoint(state, event);
  return state;
})();
eq("兜底：活轮本身不产生断点", openState.breakpoint, null);
eq(
  "兜底：openTailSnapshot 把活轮转成 host-restart 断点",
  openTailSnapshot(openState),
  {
    turn: 1,
    step: 4,
    truncated: true,
    cause: CAUSE_RESTART,
    calls: [{ callId: "call_half", name: "bash", status: TOOL_OUTCOME_UNKNOWN, background: "shell" }],
  },
);
eq("兜底：已闭合的轮不再兜底", openTailSnapshot(initialFold("s9")), null);

// 场景 D：跨进程去重 —— 历史里出现过的 <resume id> 被记住
const seenState = (() => {
  const state = initialFold("s10");
  const text = renderResume({ sessionId: "s10", turn: 1, step: 10, truncated: false, cause: CAUSE_RESTART, openCalls: [], queued: 0 });
  const events = [
    ...scenarioRestart,
    turnStart(2),
    ev("user/message", { id: "u-r", role: "user", content: [{ type: "text", text }], source: { kind: "resume" } }),
    // 排队插入的落盘形状（agent/inbox/spliced 的 inserted 数组）
    ev("agent/inbox/spliced", {
      target: "next-turn",
      start: 0,
      inserted: [{ id: "u-q", role: "user", content: [{ type: "text", text: renderResume({ sessionId: "s10", turn: 2, step: 1, cause: CAUSE_USER }) }] }],
    }),
  ];
  for (const event of events) foldBreakpoint(state, event);
  return state;
})();
eq("去重：记住人类消息里的 <resume id>", seenState.resumeIds.has(resumeIdOf(1, 10)), true);
eq("去重：也记住排队插入里的 <resume id>", seenState.resumeIds.has(resumeIdOf(2, 1)), true);
eq("去重：没出现过的坐标不在集合里", seenState.resumeIds.has(resumeIdOf(9, 9)), false);
eq("断点 id 形状", resumeIdOf(3, 7), "R-3-7");

// 只截断、无调用、无排队
const truncatedOnly = deriveBreakpoint(
  "s5",
  [prompt(1), turnStart(1), stepStart(1, 1), assistant(1, 1, { interrupted: true }), turnEndAborted(1)],
  0,
);
eq("派生：仅截断快照", truncatedOnly, {
  sessionId: "s5",
  turn: 1,
  step: 1,
  truncated: true,
  cause: CAUSE_USER,
  openCalls: [],
  queued: 0,
});
ok(
  "派生 → renderResume：仅截断也带截断行",
  renderResume(truncatedOnly).includes("模型输出在此处被截断，已交付部分见上一条 assistant 消息。"),
  { text: renderResume(truncatedOnly) },
);

// ── 2b) 会话投影：客户端据此决定是否把发送键变成续跑键 ────────────────────

eq("投影键", PROJECTION_KEY, "resumeBreakpoint");
eq("投影声明 wire（客户端可见）", resumeBreakpointProjection.wire !== undefined, true);
eq("投影 stateVersion", resumeBreakpointProjection.stateVersion, 1);

const projected = scenarioAbort.reduce(
  (state, event) => projectionApply(state, event),
  resumeBreakpointProjection.init(),
);
eq(
  "投影视图：aborted 末轮 → available 带坐标与原因",
  projectionView(projected),
  { available: true, turn: 1, step: 2, truncated: true, cause: CAUSE_USER, openCalls: 2 },
);
eq(
  "投影视图 schema 自校验通过",
  resumeBreakpointProjection.wire.viewSchema.parse(projectionView(projected)),
  projectionView(projected),
);

const projectedRestart = scenarioRestart.reduce(
  (state, event) => projectionApply(state, event),
  resumeBreakpointProjection.init(),
);
eq(
  "投影视图：interrupted 末轮 → available，cause=host-restart",
  projectionView(projectedRestart),
  { available: true, turn: 1, step: 10, truncated: false, cause: CAUSE_RESTART, openCalls: 1 },
);
eq(
  "投影状态不带 Set（JSON-safe）",
  JSON.parse(JSON.stringify(projectedRestart)).resumeIds,
  undefined,
);

const turnStartEvent = ev("turn/start", { turn: 2 });
const afterTurnStart = projectionApply(projected, turnStartEvent);
eq(
  "投影视图：新一轮开始 → available=false（断点被消费的那一刻）",
  projectionView(afterTurnStart),
  { available: false, turn: null, step: null, truncated: false, cause: null, openCalls: 0 },
);

// 引用稳定：无关事件必须原引用返回（零下游工作）
let stable = resumeBreakpointProjection.init();
for (const event of scenarioAbort) stable = projectionApply(stable, event);
const unrelated = ev("session/title", { title: "x" });
eq("无关事件原引用返回", projectionApply(stable, unrelated) === stable, true);
eq(
  "重复的相同状态事件也保持引用",
  projectionApply(stable, ev("tool/result", { turn: 1, step: 2, message: { toolCallId: "missing" } })) === stable,
  true,
);
eq("断点变化时换引用", projectionApply(stable, turnStartEvent) === stable, false);

// 空日志 → 没有断点
eq("投影视图：空日志 → available=false", projectionView(resumeBreakpointProjection.init()).available, false);

// ── 3) 系统提示词段：逐字恒定 ──────────────────────────────────────────────

eq(
  "系统提示段逐字恒定",
  SYSTEM_SECTION,
  [
    "## 中断与续行",
    "`<resume>` 是会话被打断后注入的一条用户消息：内容是该断点的坐标、未闭合工具调用的状态，以及把在飞工作接着做完的续跑要求。",
    "看到它时：",
    "- `<resume>` 只对紧随其后的这一轮有效。其后出现任何人类消息，以新消息为准，旧 `<resume>` 作废，不要按它继续。",
    "- `<resume>` 就是当前这一轮的消息时：接着做断点前没做完的那件事。不要询问「下一步做什么」「要不要继续」「继续几轮」，不要重新规划或复述需求；能被你查到的事实自己查，只有缺用户才能提供的信息时才发问。",
    "- 标注「结果未知」的工具调用：先用只读手段核验外部状态，再决定是否重试。",
    "- 标注「未派发」的调用按需重新发起；不可逆动作（提交、推送、删除）先说明再执行。",
  ].join("\n"),
);
ok(
  "系统段不再要求「有副作用则先问用户」（那正是回头问人的来源）",
  !SYSTEM_SECTION.includes("先问用户"),
  { section: SYSTEM_SECTION },
);
ok(
  "系统段写明不询问下一步/轮数",
  SYSTEM_SECTION.includes("不要询问「下一步做什么」「要不要继续」「继续几轮」"),
  { section: SYSTEM_SECTION },
);

// ── 汇总 ───────────────────────────────────────────────────────────────────

for (const result of results) {
  if (result.ok) {
    console.log(`ok   ${result.name}`);
  } else {
    console.log(`FAIL ${result.name}`);
    console.log(`     actual:   ${JSON.stringify(result.detail?.actual ?? result.detail)}`);
    console.log(`     expected: ${JSON.stringify(result.detail?.expected ?? "")}`);
  }
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures === 0 ? 0 : 1);
