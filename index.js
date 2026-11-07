// dsh-resume —— 中断后续跑（Host 侧）。
//
// 目标：会话被打断之后，把在飞的那件事接着做完，而不是回来问用户「下一步做什么」。
// 两个入口，同一套断点：
//   - 用户点停止（内核 agent.cancel({kind:'user'}, {keepInbox:true})）→ turn/end aborted；
//     用户点一次「继续」（主键三角或 /resume）排入 <resume>；
//   - 宿主进程在轮内退出（重启/崩溃）→ 内核在下次装载时补 turn/end interrupted
//     （dsh-session 的 openTurnClosers），本插件把它当成「宿主重启断点」，装载时
//     自动续跑：不需要点、不需要回答轮数。
// 续跑消息带一条**作用域限定**的续跑要求：只在它是最后一条人类消息时有效，
// 其后任何人类消息优先——既不再问用户，也不会像 Fix issue 1 那样被一句「你好」点火。
//
// 结构（四段，纯函数在前）：
//   1) 断点派生：foldBreakpoint(state, event) 单事件折叠 + deriveBreakpoint(events) 批处理，
//      产出 {sessionId, turn, step, truncated, cause, openCalls[], queued}；
//       cause ∈ {user-interrupted, host-restart}，决定文案与「要不要自动续跑」；
//   2) renderResume(snapshot)：提示词契约，逐字固定（事实 + 作用域限定的续跑要求）；
//   3) 待续跑寄存器：{sessionId}:{turn}:{step} 为键，入队即置位 → claimed 转 consumed
//      → 人类消息先到则 revoked；agent/pre-step 在步骤进入前复核，fail-closed teardown；
//   4) 重启自然续跑：装载时若断点 cause=host-restart，直接排入 <resume> 并把处于
//      「active 但 disarmed」（会话启动边）的 goal 重新武装，由 goal-round-driver
//      接着跑轮——不询问用户轮数。
//
// 幂等/竞态范式照抄 dsh-goal-round-driver：先预留后准入、入队前 await ctx.sessions.flush()、
// agent/pre-step 校验、人类消息优先让行、fail-closed teardown。

import { randomUUID } from "node:crypto";

import z from "@deepseek-ai/schemastery";

export const name = "dsh-resume";
export const inject = ["agents", "sessions", "systemPrompt"];

// ─────────────────────────────────────────────────────────────────────────────
// 常量：内核结果码不自创词
// ─────────────────────────────────────────────────────────────────────────────

/** tool/result.error.code：已有 tool/call 记录但无已提交结果（dsh-session repair）。 */
export const TOOL_OUTCOME_UNKNOWN = "TOOL_OUTCOME_UNKNOWN";
/** tool/result.error.code：取消后未分发的模型调用（dsh-agent-loop appendSkippedToolCall）。 */
export const TOOL_ABORTED_BEFORE_DISPATCH = "ABORTED_BEFORE_DISPATCH";
/** tool/result.error.code：没有启动记录的调用（dsh-session repair）。 */
export const TOOL_NOT_STARTED = "TOOL_NOT_STARTED";
/** tool/result.error.code：已派发但被中止的调用（dsh-tools TOOL_ABORTED，实测于真实停止路径）。 */
export const TOOL_ABORTED = "TOOL_ABORTED";

/** 已提交结果的内部标记（不是内核码，仅用于派生时排除）。 */
const STATUS_COMPLETED = "completed";

/** shell 类工具名（小写比较）：这类调用被中止后，子进程可能仍在跑。 */
const SHELL_TOOL_NAMES = new Set(["bash", "shell", "shell_exec", "exec", "run_command", "terminal", "cmd", "powershell"]);
/** 模型参数里表示「后台运行」的键。 */
const BACKGROUND_ARG_KEYS = ["run_in_background", "runInBackground", "background", "is_background", "detach"];

/**
 * 判定一次工具调用是不是「可能仍在后台跑」的 shell 调用。
 * 判定只读模型原始参数（`tool/call.arguments` 是未解析的 JSON 字符串）。
 * @param name - 工具名。
 * @param argumentsText - 模型产出的原始参数 JSON 串。
 * @returns "background"（明确后台任务）/ "shell"（shell 类但未标后台）/ undefined。
 */
export function classifyShellCall(name, argumentsText) {
  const tool = typeof name === "string" ? name.toLowerCase() : "";
  const shellLike = SHELL_TOOL_NAMES.has(tool);
  let parsed;
  try {
    parsed = typeof argumentsText === "string" && argumentsText.length > 0 ? JSON.parse(argumentsText) : undefined;
  } catch {
    parsed = undefined;
  }
  const flaggedBackground =
    parsed !== null &&
    typeof parsed === "object" &&
    BACKGROUND_ARG_KEYS.some((key) => parsed[key] === true);
  if (flaggedBackground) return "background";
  return shellLike ? "shell" : undefined;
}

/** 状态 → 文案（对应内核结果码）。 */
const STATUS_TEXT = Object.freeze({
  [TOOL_OUTCOME_UNKNOWN]: { state: "结果未知", detail: "已派发、未记录结果" },
  [TOOL_ABORTED_BEFORE_DISPATCH]: { state: "未派发", detail: "" },
  [TOOL_NOT_STARTED]: { state: "未记录启动", detail: "无 tool/call 记录" },
  // 已派发后被中止：有没有落地不知道，按「结果未知」陈述。
  [TOOL_ABORTED]: { state: "结果未知", detail: "已派发后被中止" },
});

const FALLBACK_STATUS_TEXT = { state: "结果未知", detail: "已派发、未记录结果" };

/**
 * shell 类未闭合调用的补充提示（Codex 的 "background processes may still be running" 对应物）：
 * dsh 的后台 job 在中断后仍会跑完并注入完成通知，重跑等于做两遍。
 */
export const BACKGROUND_HINT = {
  background: "；该调用是后台任务，可能仍在运行（有 job 记录）",
  shell: "；该命令可能有子进程仍在运行",
};

/** <resume> 消息的 source.kind：普通历史增长，只追加。 */
export const RESUME_SOURCE_KIND = "resume";
/** 草稿备用路径的标记（来源分类，写在 source.transport 上）。 */
export const RESUME_DRAFT_TRANSPORT = "resume-draft";
/** 命令通路的来源分类。 */
export const RESUME_COMMAND_TRANSPORT = "command";
/** 装载时自动续跑（宿主重启断点）的来源分类。 */
export const RESUME_AUTO_TRANSPORT = "auto-restart";

// ── 断点原因：决定文案，也决定「装载时要不要自己接着跑」 ──────────────────

/** 用户点了停止（turn/end reason.kind = aborted）。尊重停止：装载时不自动续跑。 */
export const CAUSE_USER = "user-interrupted";
/** 宿主进程在轮内退出（turn/end reason.kind = interrupted，内核崩溃恢复闭包）。 */
export const CAUSE_RESTART = "host-restart";

/** turn/end 的 reason.kind → 断点原因；null = 这不是中断，不产生断点。 */
export function causeOf(reason) {
  const kind = reason?.kind;
  if (kind === "aborted") return CAUSE_USER;
  if (kind === "interrupted") return CAUSE_RESTART;
  return null;
}

/** 只有宿主重启的断点在装载时自动续跑；用户按的停止必须等用户自己点。 */
export function isAutoResumable(snapshot) {
  return snapshot !== null && snapshot !== undefined && snapshot.cause === CAUSE_RESTART;
}

/** 备用路径的草稿哨兵；提交后由 Host 在步骤进入前替换，绝不进历史。 */
export const DRAFT_SENTINEL = "⟦dsh-resume⟧";

/** 未闭合调用最多列 5 条。 */
export const OPEN_CALL_LIMIT = 5;

/**
 * 装载后等多久才自动续跑（毫秒）。
 * 一次性客户端（headless/ACP）是「先建 agent、紧接着提交任务」，如果一创建就排
 * `<resume>`，那一轮会被旧活占掉、人的新指令反而排到下一轮。等一个安静窗口，
 * 让这段时间里到达的人类消息先落地——有它就整条让行。
 */
export const RESTART_SETTLE_MS = 600;

/**
 * 续跑要求（逐字恒定）。
 * 这是**作用域限定**的祈使：只在 <resume> 是最后一条人类消息时有效，其后任何
 * 人类消息优先。Fix issue 1（一句「你好」触发了断点前的提交动作）由最后一行兜住，
 * 而「不再询问下一步 / 轮数」由第一行给出。
 */
export const RESUME_DIRECTIVE_LINES = Object.freeze([
  "续跑要求：把断点前正在做的那件事接着做完；不要询问「下一步做什么」「要不要继续」「继续几轮」，不要重新规划或复述需求，缺的事实自己查。",
  "结果未知的调用先用只读手段核验外部状态，再决定是否重试；未派发的调用按需重新发起；不可逆动作（提交、推送、删除）先说明再执行。",
  "本条只对紧随其后的这一轮有效：其后出现任何人类消息，以新消息为准，本条作废。",
]);

/** 系统提示词贡献段：内容逐字恒定（变了会换系统节点伤缓存）。 */
export const SYSTEM_SECTION = [
  "## 中断与续行",
  "`<resume>` 是会话被打断后注入的一条用户消息：内容是该断点的坐标、未闭合工具调用的状态，以及把在飞工作接着做完的续跑要求。",
  "看到它时：",
  "- `<resume>` 只对紧随其后的这一轮有效。其后出现任何人类消息，以新消息为准，旧 `<resume>` 作废，不要按它继续。",
  "- `<resume>` 就是当前这一轮的消息时：接着做断点前没做完的那件事。不要询问「下一步做什么」「要不要继续」「继续几轮」，不要重新规划或复述需求；能被你查到的事实自己查，只有缺用户才能提供的信息时才发问。",
  "- 标注「结果未知」的工具调用：先用只读手段核验外部状态，再决定是否重试。",
  "- 标注「未派发」的调用按需重新发起；不可逆动作（提交、推送、删除）先说明再执行。",
].join("\n");

// ─────────────────────────────────────────────────────────────────────────────
// 1) 断点派生（纯函数）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 空的派生状态。
 * @param sessionId - 会话身份。
 * @returns the initial fold state.
 */
export function initialFold(sessionId) {
  return {
    sessionId,
    open: false,
    turn: null,
    step: 0,
    truncated: false,
    calls: {},
    order: 0,
    /** 活的断点：只在最后一轮以中断（aborted/interrupted）结束时存在。 */
    breakpoint: null,
    /** 断点坐标锚：跨过 turn/start 仍保留，供 pre-step 复核。 */
    anchor: null,
    /** 历史里出现过的 <resume id>：同一坐标不重复自动续跑（跨进程去重）。 */
    resumeIds: new Set(),
    /** 本 turn 是否已经产出过 assistant 内容（人类消息抢占时的判定面）。 */
    produced: false,
  };
}

/** 断点 id：R-{turn}-{step}，与 <resume id> 同源。 */
export function resumeIdOf(turn, step) {
  return `R-${turn}-${step}`;
}

/** <resume id="R-1-2"> 的识别式（历史扫描用）。 */
const RESUME_ID_PATTERN = /<resume id="(R-\d+-\d+)"/;

/**
 * 记一条 <resume id>（投影状态是 JSON 往返的，Set 可能退化成普通对象，故做形态检查）。
 * @param state - 折叠状态。
 * @param id - 抽到的断点 id。
 */
function rememberResumeId(state, id) {
  if (id === undefined) return;
  if (state.resumeIds === undefined || state.resumeIds === null) state.resumeIds = new Set();
  if (typeof state.resumeIds.add === "function") state.resumeIds.add(id);
}

/** 从一条消息的 content 里抽 <resume id>（没有则 undefined）。 */
function resumeIdInMessage(message) {
  const text = textOf(message);
  const matched = text.match(RESUME_ID_PATTERN);
  return matched === null ? undefined : matched[1];
}

/**
 * 折叠一条会话事件。
 * 只有「最后一轮以中断结束」才产生断点；新 turn/start 清掉活断点但保留锚。
 * 同时记下历史里出现过的 <resume id>，供装载时的自动续跑去重。
 * @param state - 可变折叠状态。
 * @param event - 一条 session 事件（形状 {type, data}）。
 * @returns the same state.
 */
export function foldBreakpoint(state, event) {
  const type = event?.type;
  const data = event?.data ?? {};
  // 去重面：历史里出现过的 <resume id>（人类消息或排队插入两种落盘形状）。
  if (type === "user/message") {
    rememberResumeId(state, resumeIdInMessage(data.message ?? data));
  } else if (type === "agent/inbox/spliced") {
    for (const message of Array.isArray(data.inserted) ? data.inserted : []) {
      rememberResumeId(state, resumeIdInMessage(message));
    }
  }
  switch (type) {
    case "turn/start":
      state.open = true;
      state.turn = typeof data.turn === "number" ? data.turn : state.turn;
      state.step = 0;
      state.truncated = false;
      state.produced = false;
      state.calls = {};
      state.order = 0;
      state.breakpoint = null;
      return state;
    case "step/start":
      if (state.open) state.step = typeof data.step === "number" ? data.step : state.step;
      return state;
    case "assistant/message":
      if (!state.open) return state;
      state.produced = true;
      if (typeof data.step === "number") state.step = data.step;
      if (data.interrupted === true) state.truncated = true;
      return state;
    case "tool/call": {
      if (!state.open || typeof data.callId !== "string") return state;
      if (typeof data.step === "number") state.step = data.step;
      state.calls[data.callId] = {
        callId: data.callId,
        name: typeof data.name === "string" ? data.name : "tool",
        status: TOOL_OUTCOME_UNKNOWN, // 有 tool/call 无结果 → 结果未知
        order: state.order,
        background: classifyShellCall(data.name, data.arguments),
      };
      state.order += 1;
      return state;
    }
    case "tool/result": {
      if (!state.open) return state;
      // 持久字段是 ToolResultMessage.toolCallId（dsh-llm），createToolResultMessage 的入参叫 callId。
      const callId = data.message?.toolCallId ?? data.message?.callId;
      const record = typeof callId === "string" ? state.calls[callId] : undefined;
      if (record === undefined) return state;
      const code = data.error?.code;
      record.status = typeof code === "string" && code.length > 0 ? code : STATUS_COMPLETED;
      return state;
    }
    case "turn/end": {
      if (!state.open) return state;
      const cause = causeOf(data.reason);
      if (cause !== null && data.turn === state.turn) {
        const snapshot = {
          turn: state.turn,
          step: state.step,
          truncated: state.truncated,
          cause,
          calls: Object.values(state.calls)
            .sort((left, right) => left.order - right.order)
            .map((call) => ({
              callId: call.callId,
              name: call.name,
              status: call.status,
              ...(call.background === undefined ? {} : { background: call.background }),
            }))
            .filter((call) => call.status !== STATUS_COMPLETED),
        };
        state.breakpoint = snapshot;
        state.anchor = snapshot;
      } else {
        state.breakpoint = null;
        state.anchor = null;
      }
      state.open = false;
      return state;
    }
    default:
      return state;
  }
}

/**
 * 崩溃尾巴：日志停在轮内（没有 turn/end）时的隐式断点。
 * 正常路径上 dsh 会在装载时补 interrupted 闭包（openTurnClosers），这条只兜底
 * 「日志未经修复就被读到」的情形——有在飞的活，就当宿主重启断点，别让用户重述。
 * @param state - 折叠状态（open=true）。
 * @returns snapshot or null.
 */
export function openTailSnapshot(state) {
  if (state?.open !== true) return null;
  return {
    turn: state.turn,
    step: state.step,
    truncated: true,
    cause: CAUSE_RESTART,
    calls: Object.values(state.calls)
      .sort((left, right) => left.order - right.order)
      .map((call) => ({
        callId: call.callId,
        name: call.name,
        status: call.status,
        ...(call.background === undefined ? {} : { background: call.background }),
      }))
      .filter((call) => call.status !== STATUS_COMPLETED),
  };
}

/**
 * 当前活断点快照；没有则 null。
 * @param state - 折叠状态。
 * @param queued - 中止期间已排队的输入条数。
 * @returns snapshot or null.
 */
export function breakpointOf(state, queued = 0) {
  const breakpoint = state.breakpoint;
  if (breakpoint === null || breakpoint === undefined) return null;
  return {
    sessionId: state.sessionId,
    turn: breakpoint.turn,
    step: breakpoint.step,
    truncated: breakpoint.truncated === true,
    cause: breakpoint.cause === CAUSE_RESTART ? CAUSE_RESTART : CAUSE_USER,
    openCalls: breakpoint.calls.map((call) => ({ ...call })),
    queued: Number.isFinite(queued) ? queued : 0,
  };
}

/**
 * 由一段事件序列派生断点。
 * @param sessionId - 会话身份。
 * @param events - 事件序列（形状 {type, data}）。
 * @param queued - 中止期间已排队的输入条数。
 * @returns snapshot or null.
 */
export function deriveBreakpoint(sessionId, events, queued = 0) {
  let state = initialFold(sessionId);
  for (const event of events) state = foldBreakpoint(state, event);
  return breakpointOf(state, queued);
}

/**
 * 断点键：{sessionId}:{turn}:{step}。
 * @param snapshot - 断点快照或锚。
 * @returns the register key.
 */
export function breakpointKey(snapshot) {
  return `${snapshot.sessionId}:${snapshot.turn}:${snapshot.step}`;
}

/**
 * 折叠状态里锚的键（跨过 turn/start 仍可用）。
 * @param state - 折叠状态。
 * @returns the anchor key, or null.
 */
export function anchorKeyOf(state) {
  const anchor = state?.anchor;
  if (anchor === null || anchor === undefined) return null;
  return `${state.sessionId}:${anchor.turn}:${anchor.step}`;
}

/**
 * 由锚重建快照（草稿路径在步骤进入前渲染时用）。
 * @param state - 折叠状态。
 * @param queued - 排队条数。
 * @returns snapshot or null.
 */
export function snapshotOfAnchor(state, queued = 0) {
  const anchor = state?.anchor;
  if (anchor === null || anchor === undefined) return null;
  return {
    sessionId: state.sessionId,
    turn: anchor.turn,
    step: anchor.step,
    truncated: anchor.truncated === true,
    cause: anchor.cause === CAUSE_RESTART ? CAUSE_RESTART : CAUSE_USER,
    openCalls: anchor.calls.map((call) => ({ ...call })),
    queued: Number.isFinite(queued) ? queued : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1b) 会话投影：把「有没有断点」变成客户端可读的逐会话状态
// ─────────────────────────────────────────────────────────────────────────────

/** 投影键：客户端 `session.projections.faceOf('resumeBreakpoint')` 读同一个键。 */
export const PROJECTION_KEY = "resumeBreakpoint";

/** 只这两种事件会改变断点；其余事件必须原引用返回（零下游工作）。 */
const PROJECTION_EVENTS = new Set(["turn/start", "turn/end", "step/start", "assistant/message", "tool/call", "tool/result"]);

/**
 * 投影状态签名：折叠状态本身（不含 sessionId）逐字节比较。
 * 只看 wire 视图不够——turn/start 不清断点可见性，却必须写进折叠状态。
 */
function projectionSignature(state) {
  return JSON.stringify({
    open: state?.open === true,
    turn: state?.turn ?? null,
    step: state?.step ?? 0,
    truncated: state?.truncated === true,
    order: state?.order ?? 0,
    calls: state?.calls ?? {},
    breakpoint: state?.breakpoint ?? null,
    anchor: state?.anchor ?? null,
  });
}

/** 折叠状态 schema：投影检查点回放时会 parse，做形态校验而不是全量 JSON Schema。 */
const foldStateSchema = {
  parse(value) {
    if (value === null || typeof value !== "object") throw new Error("resumeBreakpoint: state must be an object");
    if (typeof value.calls !== "object" || value.calls === null) throw new Error("resumeBreakpoint: state.calls must be an object");
    const breakpoint = value.breakpoint;
    if (breakpoint !== null && breakpoint !== undefined) {
      if (!Number.isSafeInteger(breakpoint.turn) || !Number.isSafeInteger(breakpoint.step)) {
        throw new Error("resumeBreakpoint: breakpoint coordinates must be integers");
      }
      if (!Array.isArray(breakpoint.calls)) throw new Error("resumeBreakpoint: breakpoint.calls must be an array");
    }
    return value;
  },
};

/** 客户端视图 schema。 */
const viewSchema = {
  parse(value) {
    if (value === null || typeof value !== "object") throw new Error("resumeBreakpoint view must be an object");
    if (typeof value.available !== "boolean") throw new Error("resumeBreakpoint view.available must be boolean");
    if (!Number.isSafeInteger(value.openCalls)) throw new Error("resumeBreakpoint view.openCalls must be an integer");
    return value;
  },
};

/** 折叠状态 → 客户端视图（只给布尔 + 坐标 + 原因，不塞历史）。 */
export function projectionView(state) {
  const breakpoint = state?.breakpoint;
  return {
    available: breakpoint !== null && breakpoint !== undefined,
    turn: breakpoint?.turn ?? null,
    step: breakpoint?.step ?? null,
    truncated: breakpoint?.truncated === true,
    cause: breakpoint === null || breakpoint === undefined ? null : breakpoint.cause === CAUSE_RESTART ? CAUSE_RESTART : CAUSE_USER,
    openCalls: Array.isArray(breakpoint?.calls) ? breakpoint.calls.length : 0,
  };
}

/**
 * 投影 apply：事件驱动的同一套折叠，只在断点可见性变化时换引用。
 * @param state - 上次的折叠状态（JSON-safe）。
 * @param event - 一条会话事件。
 * @returns the next state, or the same reference when nothing changed.
 */
export function projectionApply(state, event) {
  if (!PROJECTION_EVENTS.has(event?.type)) return state;
  // resumeIds 只属 Host 侧的跨进程去重，不进投影检查点（JSON-safe 状态里不要 Set）。
  const { resumeIds: _ignored, ...rest } = state;
  const next = foldBreakpoint({ ...rest, calls: { ...rest.calls } }, event);
  return projectionSignature(next) === projectionSignature(state) ? state : next;
}

/** 注册用的投影定义。 */
export const resumeBreakpointProjection = {
  key: PROJECTION_KEY,
  stateVersion: 1,
  stateSchema: foldStateSchema,
  init: () => initialFold(""),
  apply: projectionApply,
  wire: { viewSchema, view: projectionView },
};

// ─────────────────────────────────────────────────────────────────────────────
// 2) renderResume（提示词契约，逐字）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 渲染 <resume> 消息正文（逐字契约）。
 *
 * 三段固定顺序：
 *   1) 标签行：`<resume id="R-{turn}-{step}" reason="{cause}">`；
 *   2) 事实：断点坐标 + 截断 + 未闭合调用状态 + 排队条数；
 *   3) 续跑要求（RESUME_DIRECTIVE_LINES）：作用域限定，只在它是最后一条人类
 *      消息时有效 —— 这样「接着做完、不要问下一步/轮数」与「后来的人类消息
 *      优先」同时成立。
 * @param snapshot - {sessionId,turn,step,truncated,cause,openCalls,queued}
 * @param options - {maxOpenCalls} 未闭合调用展示上限（默认 5）
 * @returns the exact message text.
 */
export function renderResume(snapshot, options = {}) {
  const limit = Number.isFinite(options.maxOpenCalls) && options.maxOpenCalls > 0 ? options.maxOpenCalls : OPEN_CALL_LIMIT;
  const turn = snapshot.turn;
  const step = snapshot.step;
  const cause = snapshot.cause === CAUSE_RESTART ? CAUSE_RESTART : CAUSE_USER;
  const openCalls = Array.isArray(snapshot.openCalls) ? snapshot.openCalls : [];
  const queued = Number.isFinite(snapshot.queued) ? snapshot.queued : 0;

  const lines = [`<resume id="${resumeIdOf(turn, step)}" reason="${cause}">`];
  lines.push(
    cause === CAUSE_RESTART
      ? `宿主进程在 turn ${turn} / step ${step} 进行中退出（内核以 interrupted 收尾），断点前的活没有做完。`
      : `上一轮在 turn ${turn} / step ${step} 被用户点击停止，断点前的活没有做完。`,
  );
  lines.push(`断点位置：turn ${turn} / step ${step}`);
  if (snapshot.truncated === true) {
    lines.push("模型输出在此处被截断，已交付部分见上一条 assistant 消息。");
  }
  if (openCalls.length > 0) {
    lines.push("未闭合的工具调用：");
    for (const call of openCalls.slice(0, limit)) {
      const text = STATUS_TEXT[call.status] ?? FALLBACK_STATUS_TEXT;
      const detail = typeof text.detail === "string" && text.detail.length > 0 ? `（${text.detail}）` : "";
      lines.push(`- ${call.name}(${call.callId})：${text.state}${detail}${BACKGROUND_HINT[call.background] ?? ""}`);
    }
    if (openCalls.length > limit) {
      lines.push(`（另有 ${openCalls.length - limit} 条未闭合调用未列出）`);
    }
  }
  if (queued > 0) {
    lines.push(`中断期间已排队 ${queued} 条输入，将在下一步边界交付。`);
  }
  lines.push(...RESUME_DIRECTIVE_LINES);
  lines.push("</resume>");
  return lines.join("\n");
}

/**
 * 构造 <resume> 用户消息。
 * 与 @deepseek-ai/dsh-llm 的 createUserMessage 同构：role=user + 全新 id + 逐字 content。
 * @param text - renderResume 的输出。
 * @param transport - 来源分类（command / resume-draft）。
 * @returns a JSON-safe user message.
 */
export function createResumeMessage(text, transport) {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: RESUME_SOURCE_KIND, transport },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) Host 接线
// ─────────────────────────────────────────────────────────────────────────────

export const Config = z.object({
  draftSentinel: z.string().default(DRAFT_SENTINEL).description("备用草稿路径的哨兵文本；Host 在步骤进入前替换，绝不进历史"),
  maxOpenCalls: z.natural().min(1).max(20).default(OPEN_CALL_LIMIT).description("<resume> 里未闭合调用的展示上限"),
  systemSection: z.boolean().default(true).description("是否注入「中断与续行」系统提示词段"),
  autoResumeOnRestart: z
    .boolean()
    .default(true)
    .description("宿主在轮内退出后（turn/end interrupted）装载时自动续跑：接着干，不询问用户下一步或轮数；用户按的停止（aborted）不受影响"),
  rearmGoal: z
    .boolean()
    .default(true)
    .description("续跑时把「active 但 disarmed」的 goal 重新武装，让 goal-round-driver 接着排队下一轮（不询问轮数）；pause/complete/block 过的 goal 不碰"),
  restartSettleMs: z
    .natural()
    .max(10000)
    .default(RESTART_SETTLE_MS)
    .description("宿主重启断点在装载后等多久（毫秒）才自动续跑；这段窗口里到达的人类消息优先，有它就整条让行"),
});

function renderThrown(value) {
  return value instanceof Error ? value.message : String(value);
}

function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

export function apply(ctx, config = {}) {
  const settings = {
    draftSentinel: typeof config.draftSentinel === "string" && config.draftSentinel.length > 0 ? config.draftSentinel : DRAFT_SENTINEL,
    maxOpenCalls: Number.isFinite(config.maxOpenCalls) ? config.maxOpenCalls : OPEN_CALL_LIMIT,
    systemSection: config.systemSection !== false,
    autoResumeOnRestart: config.autoResumeOnRestart !== false,
    rearmGoal: config.rearmGoal !== false,
    restartSettleMs: Number.isFinite(config.restartSettleMs) ? Math.max(0, config.restartSettleMs) : RESTART_SETTLE_MS,
  };

  const folds = new Map(); // sessionId -> fold state
  const registers = new Map(); // breakpoint key -> register
  const timers = new Set(); // 装载延迟续跑的定时器（teardown 清掉）
  const scheduled = new Set(); // 已排过延迟续跑的断点键
  let stopped = false;
  /** 可选服务：不在就退化成「没有 goal 也能跑」（headless 模板没有 goals）。 */
  let goals;
  const diagnostics = { warnings: [], lastError: null, goalRearms: [], autoResumes: [] };
  const warn = (message) => {
    diagnostics.warnings.push(message);
    if (diagnostics.warnings.length > 50) diagnostics.warnings.shift();
    ctx.logger?.warn?.(`dsh-resume: ${message}`);
  };

  /** 延迟执行（teardown 会清掉未触发的定时器）。 */
  function later(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      if (stopped) return;
      try {
        fn();
      } catch (error) {
        warn(`deferred resume failed: ${renderThrown(error)}`);
      }
    }, ms);
    timers.add(id);
    return id;
  }

  // ── 折叠与快照 ───────────────────────────────────────────────────────────

  function foldFor(sessionId) {
    let state = folds.get(sessionId);
    if (state === undefined) {
      state = initialFold(sessionId);
      folds.set(sessionId, state);
    }
    return state;
  }

  function seedFromSession(agent) {
    const session = agent?.session;
    const sessionId = typeof session?.id === "string" ? session.id : undefined;
    if (sessionId === undefined) return;
    if (folds.has(sessionId)) return;
    if (typeof session.ownEvents !== "function") {
      foldFor(sessionId);
      return;
    }
    let events = [];
    try {
      events = session.ownEvents();
    } catch (error) {
      warn(`seed failed for "${sessionId}": ${renderThrown(error)}`);
      events = [];
    }
    // 断点只可能落在最后一轮：从最后一个 turn/start 起折叠即可。
    let start = 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === "turn/start") {
        start = index;
        break;
      }
    }
    const state = foldFor(sessionId);
    for (const event of events.slice(start)) foldBreakpoint(state, event);
    // 崩溃尾巴兜底：日志停在轮内（没有被 repair 补闭包）时，仍然当成宿主重启断点。
    if (state.open === true && state.breakpoint === null) {
      const tail = openTailSnapshot(state);
      if (tail !== null) {
        state.breakpoint = tail;
        state.anchor = tail;
        state.open = false;
      }
    }
  }

  function queuedCount(agent, excludeId) {
    const lists = [agent?.inbox?.nextTurn ?? [], agent?.inbox?.nextStep ?? []];
    let total = 0;
    for (const list of lists) {
      for (const message of list) {
        if (message?.source?.kind === RESUME_SOURCE_KIND) continue;
        if (excludeId !== undefined && message?.id === excludeId) continue;
        total += 1;
      }
    }
    return total;
  }

  function snapshotFor(agent) {
    const sessionId = typeof agent?.session?.id === "string" ? agent.session.id : undefined;
    if (sessionId === undefined) return null;
    return breakpointOf(foldFor(sessionId), queuedCount(agent));
  }

  function registerOf(messageId) {
    if (typeof messageId !== "string") return undefined;
    for (const register of registers.values()) {
      if (register.messageId === messageId) return register;
    }
    return undefined;
  }

  function isSentinelMessage(message) {
    if (message?.source?.kind !== "user") return false;
    const text = textOf(message);
    return text === settings.draftSentinel || text === DRAFT_SENTINEL;
  }

  function dropQueued(agent, messageId) {
    if (messageId === null || messageId === undefined) return;
    try {
      agent?.inbox?.remove?.(messageId);
    } catch (error) {
      warn(`could not drop queued resume: ${renderThrown(error)}`);
    }
  }

  function revokeFor(agent, reason) {
    const sessionId = typeof agent?.session?.id === "string" ? agent.session.id : undefined;
    if (sessionId === undefined) return;
    for (const register of registers.values()) {
      if (register.sessionId !== sessionId) continue;
      // 已经续跑过、之后又来了人类消息：不再算「当前断点」，留痕即可（不改历史）。
      if (register.phase === "consumed") {
        register.phase = "superseded";
        register.supersededBy = reason;
        continue;
      }
      if (register.phase !== "queued" && register.phase !== "reserved") continue;
      register.phase = "revoked";
      register.revokedBy = reason;
      dropQueued(agent, register.messageId);
    }
  }

  // ── 消费/作废 ────────────────────────────────────────────────────────────

  async function resumeNow(agent, transport) {
    if (stopped) throw new Error("插件已卸载");
    const session = agent?.session;
    if (session === undefined) throw new Error("没有活动会话");
    const sessionId = typeof session.id === "string" ? session.id : "";
    const live = snapshotFor(agent);
    if (live === null) {
      const anchored = anchorKeyOf(folds.get(sessionId));
      const consumed = anchored === null ? undefined : registers.get(anchored);
      if (consumed !== undefined && consumed.phase === "consumed") {
        return { kind: "error", text: "该断点已续跑过" };
      }
      return { kind: "error", text: "续跑未启动：没有可续跑的断点" };
    }
    const key = breakpointKey(live);
    const existing = registers.get(key);
    if (existing !== undefined) {
      if (existing.phase === "consumed") return { kind: "error", text: "该断点已续跑过" };
      if (existing.phase === "queued" || existing.phase === "reserved") {
        return { kind: "error", text: `续跑已排队（${key}），等待下一步边界` };
      }
    }

    // 先预留后准入：同步置位，避免两次点击各排一条。
    const register = {
      key,
      sessionId: live.sessionId,
      turn: live.turn,
      step: live.step,
      messageId: null,
      phase: "reserved",
      transport,
      createdAt: Date.now(),
    };
    registers.set(key, register);

    try {
      await ctx.sessions.flush(session);
    } catch (error) {
      registers.delete(key);
      diagnostics.lastError = renderThrown(error);
      return { kind: "error", text: `续跑未启动：${renderThrown(error)}` };
    }

    if (stopped || ctx.agents.get(agent.id) !== agent) {
      registers.delete(key);
      return { kind: "error", text: "续跑未启动：会话已关闭" };
    }
    const after = snapshotFor(agent);
    if (after === null || breakpointKey(after) !== key) {
      registers.delete(key);
      return { kind: "error", text: "续跑未启动：断点已消失" };
    }

    // 先判后断：有排队的人类输入就不排续跑（而不是排完再撤）。判定放在 flush 之后，
    // 保证看到的是最后一次持久化后的 inbox。
    if (queuedCount(agent) > 0) {
      registers.delete(key);
      return { kind: "error", text: "续跑已作废（你已发送新消息）" };
    }

    const message = createResumeMessage(renderResume(after, { maxOpenCalls: settings.maxOpenCalls }), transport);
    register.messageId = message.id;
    register.phase = "queued";
    register.snapshot = after;
    register.cause = after.cause;
    try {
      agent.followup(message);
    } catch (error) {
      registers.delete(key);
      diagnostics.lastError = renderThrown(error);
      return { kind: "error", text: `续跑未启动：${renderThrown(error)}` };
    }
    afterResume(agent, register);
    return { kind: "success", text: `已续跑断点 ${key}` };
  }

  /** resumeNow 成功之后的统一收尾：重新武装 goal（让轮驱动接着跑，不询问轮数）。 */
  function afterResume(agent, register) {
    if (register !== undefined) register.rearmed = true;
    rearmGoal(agent, register?.transport ?? "resume");
  }

  // ── goal 重新武装：让自动轮驱动接着跑，而不是回来问「继续几轮」 ─────────────

  /**
   * 把「active 但 disarmed」的 goal 重新武装。
   *
   * dsh-goal 在 `agent/created` 上无条件 disarm（会话启动边），于是重启后即使
   * 用户/插件已经续跑，goal-round-driver 也不会再排队下一轮，模型只能回头问用户
   * 「要不要继续/继续几轮」。这里补上那次人类授权：只有 phase 仍是 active
   * （用户 pause/complete/block 过的不碰）、activation 仍是 disarmed 时才 rearm。
   * @param agent - 会话对应的活 agent。
   * @param reason - 记进诊断的触发点（command / draft / auto-restart）。
   */
  function rearmGoal(agent, reason) {
    if (!settings.rearmGoal || goals === undefined) return;
    try {
      const goal = goals.get(agent);
      if (goal === undefined || goal === null) return;
      if (goal.phase !== "active" || goal.activation !== "disarmed") return;
      goals.resume(agent, { id: goal.id, revision: goal.revision });
      diagnostics.goalRearms.push(`${agent?.id ?? "?"}:${goal.id}@${goal.revision} (${reason})`);
      if (diagnostics.goalRearms.length > 20) diagnostics.goalRearms.shift();
    } catch (error) {
      // 轮数用尽/竞态都走这里：不续跑也不能把装载流程弄挂，更不改问用户。
      warn(`goal re-arm skipped for "${agent?.id ?? "?"}" (${reason}): ${renderThrown(error)}`);
    }
  }

  // ── 装载时自动续跑：宿主重启断点不需要人点、更不需要人回答 ──────────────────

  /**
   * 宿主重启断点的自动续跑。
   *
   * 只处理 cause=host-restart：
   *   - 用户按的停止（cause=user-interrupted）不自动续跑——停止是人的意思；
   *   - 已经有排队人类输入 → 让行；
   *   - 同一坐标已经在历史里续跑过（跨进程去重）→ 跳过，避免重启后重复点火。
   * @param agent - 刚装载的活 agent。
   * @param source - agent/created 的来源（startup / resume / …），只进诊断。
   */
  async function autoResumeOnRestart(agent, source) {
    if (!settings.autoResumeOnRestart || stopped) return;
    const sessionId = typeof agent?.session?.id === "string" ? agent.session.id : undefined;
    if (sessionId === undefined) return;
    const state = folds.get(sessionId);
    const live = snapshotFor(agent);
    if (live === null || !isAutoResumable(live)) return;
    // 一次性客户端会在 created 之后立刻提交任务：这期间到达的人类消息优先。
    if (agent?.status === "running") {
      diagnostics.autoResumes.push(`${breakpointKey(live)} skipped (agent already running)`);
      return;
    }
    const key = breakpointKey(live);
    if (state?.resumeIds?.has(resumeIdOf(live.turn, live.step)) === true) {
      diagnostics.autoResumes.push(`${key} skipped (already resumed in history)`);
      return;
    }
    const existing = registers.get(key);
    if (existing !== undefined && (existing.phase === "queued" || existing.phase === "reserved" || existing.phase === "consumed")) {
      return;
    }
    if (queuedCount(agent) > 0) {
      diagnostics.autoResumes.push(`${key} skipped (human input queued)`);
      return;
    }
    const outcome = await resumeNow(agent, RESUME_AUTO_TRANSPORT);
    diagnostics.autoResumes.push(`${key} ${outcome.kind}${source === undefined ? "" : ` via ${source}`}`);
    if (diagnostics.autoResumes.length > 20) diagnostics.autoResumes.shift();
  }

  /**
   * 排一次「安静窗口之后」的自动续跑。
   * 同一断点只排一个；窗口结束时再判一次（人类消息、寄存器、去重都在 autoResumeOnRestart 里复查）。
   * @param agent - 刚装载/刚 idle 的 agent。
   * @param source - 触发来源（只进诊断）。
   */
  function scheduleAutoResume(agent, source) {
    if (!settings.autoResumeOnRestart || stopped) return;
    const live = snapshotFor(agent);
    if (live === null || !isAutoResumable(live)) return;
    const key = breakpointKey(live);
    if (scheduled.has(key)) return;
    if (registers.has(key)) return;
    if (folds.get(live.sessionId)?.resumeIds?.has(resumeIdOf(live.turn, live.step)) === true) {
      diagnostics.autoResumes.push(`${key} skipped (already resumed in history)`);
      if (diagnostics.autoResumes.length > 20) diagnostics.autoResumes.shift();
      return;
    }
    scheduled.add(key);
    later(() => {
      scheduled.delete(key);
      void autoResumeOnRestart(agent, source).catch((error) =>
        warn(`auto resume failed for "${agent?.id ?? "?"}": ${renderThrown(error)}`),
      );
    }, settings.restartSettleMs);
  }

  /**
   * 人类消息抢占：续跑轮已经开始、但模型还没有任何产出时，人的消息立刻接管。
   * 已经产出（哪怕只有一个 token）就不撤——撤了会丢工作，让人等到下一步边界。
   * @param agent - 收到人类消息的 agent。
   */
  function preemptResumeTurn(agent) {
    const sessionId = typeof agent?.session?.id === "string" ? agent.session.id : undefined;
    if (sessionId === undefined) return;
    const state = folds.get(sessionId);
    if (state?.produced === true) return;
    if (agent?.status !== "running") return;
    for (const register of registers.values()) {
      if (register.sessionId !== sessionId) continue;
      if (register.admittedTurn === undefined || register.admittedTurn !== state?.turn) continue;
      if (register.phase !== "consumed" && register.phase !== "superseded") continue;
      try {
        agent.cancel({ kind: "user" }, { keepInbox: true });
        register.revokedBy = register.revokedBy ?? "human-message-preempt";
        diagnostics.autoResumes.push(`${register.key} preempted by human message`);
      } catch (error) {
        warn(`could not preempt resume turn for "${agent?.id ?? "?"}": ${renderThrown(error)}`);
      }
      return;
    }
  }

  // ── 事件接线 ─────────────────────────────────────────────────────────────

  ctx.effect(function* resumeLifecycle() {
    ctx.on("agent/created", ({ agent, source }) => {
      seedFromSession(agent);
      // 装载即续跑：宿主重启断点不等点击、更不问用户。延迟一个安静窗口再排，
      // 让「建完 agent 立刻提交任务」的客户端先落地——有人类消息就整条让行。
      scheduleAutoResume(agent, source);
    });

    // 兜底：装载时 agent 还没到 idle（或 followup 抛错）时，下一次 idle 再排一次。
    ctx.on("agent/status", ({ agent, status }) => {
      if (status !== "idle") return;
      scheduleAutoResume(agent, "idle");
    });

    ctx.on("agent/disposed", ({ agent }) => {
      const sessionId = typeof agent?.session?.id === "string" ? agent.session.id : undefined;
      if (sessionId !== undefined) folds.delete(sessionId);
      for (const [key, register] of registers) {
        if (register.sessionId === sessionId) registers.delete(key);
      }
    });

    ctx.on("session/event", (session, event) => {
      const sessionId = typeof session?.id === "string" ? session.id : undefined;
      if (sessionId === undefined) return;
      foldBreakpoint(foldFor(sessionId), event);
    });

    ctx.on("agent/inbox/inserted", ({ agent, message }) => {
      const own = registerOf(message?.id);
      if (own !== undefined) return;
      if (message?.source?.kind === RESUME_SOURCE_KIND) return;

      if (!isSentinelMessage(message)) {
        // 人类消息先到 → 让行：续跑标记作废，已排队的 <resume> 一并撤回；
        // 若续跑轮已经在跑且模型还没有产出，直接把这轮撤掉，让人接管。
        if (message?.source?.kind === "user") {
          preemptResumeTurn(agent);
          revokeFor(agent, "human-message");
        }
        return;
      }

      // 备用草稿路径：入队即置位；正文在 pre-step 进入步骤前替换。
      // 先判后断：这条哨兵之前已经排了人类输入时，哨兵直接丢弃。
      if (queuedCount(agent, message?.id) > 0) {
        dropQueued(agent, message?.id);
        warn(`dropped sentinel: human input is already queued on "${agent?.id ?? "?"}"`);
        return;
      }
      const live = snapshotFor(agent);
      if (live === null) {
        dropQueued(agent, message?.id);
        warn(`dropped sentinel without breakpoint on "${agent?.id ?? "?"}"`);
        return;
      }
      const key = breakpointKey(live);
      const existing = registers.get(key);
      if (existing !== undefined && existing.phase === "consumed") {
        dropQueued(agent, message?.id);
        return;
      }
      if (existing !== undefined && (existing.phase === "queued" || existing.phase === "reserved")) {
        // 已有待续跑寄存器：多余哨兵直接丢掉，保持「只入队 1 条」。
        dropQueued(agent, message?.id);
        return;
      }
      registers.set(key, {
        key,
        sessionId: live.sessionId,
        turn: live.turn,
        step: live.step,
        messageId: message.id,
        phase: "queued",
        transport: RESUME_DRAFT_TRANSPORT,
        createdAt: Date.now(),
        snapshot: live,
      });
    });

    ctx.on("agent/inbox/claimed", ({ agent, message }) => {
      const register = registerOf(message?.id);
      if (register === undefined) return;
      if (register.phase === "revoked") return;
      register.phase = "consumed";
      register.claimedAt = Date.now();
      const sessionId = typeof agent?.session?.id === "string" ? agent.session.id : register.sessionId;
      const turn = folds.get(sessionId)?.turn;
      if (typeof turn === "number") register.admittedTurn = turn;
    });

    ctx.on("agent/inbox/discarded", ({ message }) => {
      const register = registerOf(message?.id);
      if (register === undefined) return;
      // 已经因让行/卸载作废的不再改因：撤销原因保留第一手。
      if (register.phase === "consumed" || register.phase === "revoked") return;
      register.phase = "revoked";
      register.revokedBy = "discarded";
    });

    ctx.on("agent/error", ({ agent }) => {
      // fail-closed：错误路径不再自动续跑，寄存器一律作废。
      revokeFor(agent, "agent-error");
    });

    /**
     * 步骤进入前的准入复核：<resume> 必须仍然对得上同一断点。
     * 草稿路径在此把哨兵正文替换成 <resume> 模板——裸哨兵绝不进历史。
     */
    ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
      const submitted = messages.find(
        (message) => message?.source?.kind === RESUME_SOURCE_KIND || isSentinelMessage(message),
      );
      if (submitted === undefined) return next();

      const register = registerOf(submitted.id);
      const sessionId = typeof agent?.session?.id === "string" ? agent.session.id : undefined;
      const state = sessionId === undefined ? undefined : folds.get(sessionId);

      let valid = false;
      try {
        valid =
          !stopped &&
          register !== undefined &&
          (register.phase === "consumed" || register.phase === "superseded") &&
          ctx.agents.get(agent.id) === agent &&
          sessionId !== undefined &&
          anchorKeyOf(state) === register.key;
      } catch (error) {
        warn(`pre-step check failed for agent "${agent.id}": ${renderThrown(error)}`);
        valid = false;
      }

      if (!valid) {
        if (register !== undefined && register.phase !== "consumed" && register.phase !== "superseded") {
          register.phase = "revoked";
        }
        restoreOtherClaimed(agent, messages, submitted.id);
        return { kind: "reject" };
      }

      // 草稿路径：正文替换为 <resume> 模板（同 id 语义：新消息对象，尚未进历史）。
      let replacement = submitted;
      if (submitted.source?.kind !== RESUME_SOURCE_KIND) {
        const snapshot =
          snapshotOfAnchor(state, queuedCount(agent)) ?? (register.snapshot === undefined ? null : register.snapshot);
        if (snapshot === null) {
          register.phase = "revoked";
          restoreOtherClaimed(agent, messages, submitted.id);
          return { kind: "reject" };
        }
        replacement = createResumeMessage(renderResume(snapshot, { maxOpenCalls: settings.maxOpenCalls }), RESUME_DRAFT_TRANSPORT);
        register.messageId = replacement.id;
        register.transport = RESUME_DRAFT_TRANSPORT;
      }
      afterResume(agent, register);

      let decision;
      try {
        decision = await next();
      } catch (error) {
        if (register.phase !== "consumed" && register.phase !== "superseded") register.phase = "revoked";
        throw error;
      }
      if (decision.kind === "enter" && replacement !== submitted) {
        return {
          kind: "enter",
          messages: decision.messages.map((message) => (message.id === submitted.id ? replacement : message)),
          ...(decision.startsRequestSeries === true ? { startsRequestSeries: true } : {}),
        };
      }
      return decision;
    });

    if (settings.systemSection) {
      ctx.systemPrompt.section({
        name: "resume:contract",
        order: 2660,
        text: SYSTEM_SECTION,
        interpolate: false,
      });
    }

    yield async function teardown() {
      stopped = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      scheduled.clear();
      for (const register of registers.values()) {
        if (register.phase === "queued" || register.phase === "reserved") {
          register.phase = "revoked";
          register.revokedBy = "teardown";
        }
      }
      registers.clear();
      folds.clear();
    };
  }, "dsh-resume lifecycle");

  /** 把被本次拒绝顺带摘下的其他已领取消息放回队列（照抄 goal-round-driver）。 */
  function restoreOtherClaimed(agent, messages, messageId) {
    const retained = messages.filter((message) => message.id !== messageId);
    for (const message of retained.toReversed()) {
      if (agent.inbox.nextStep.some((candidate) => candidate.id === message.id)) continue;
      if (agent.inbox.nextTurn.some((candidate) => candidate.id === message.id)) continue;
      agent.inbox.prepend("next-step", message);
    }
  }

  // ── 会话投影（客户端据此把发送键变成续跑键） ──────────────────────────────

  ctx.inject(["sessionProjections"], (host) => {
    host.sessionProjections.register(resumeBreakpointProjection);
  });

  // ── goal 服务（可选）：重启后重新武装，让轮驱动接着跑 ─────────────────────

  ctx.inject(["goals"], (host) => {
    goals = host.goals;
  });

  // ── 命令面 ───────────────────────────────────────────────────────────────

  ctx.inject(["commands"], (host) => {
    host.commands.register({
      name: "resume",
      description: "dsh-resume：从中断点继续（不重新描述需求，不复述任务）",
      handler: async (invocation) => {
        try {
          return await resumeNow(invocation?.agent, RESUME_COMMAND_TRANSPORT);
        } catch (error) {
          diagnostics.lastError = renderThrown(error);
          return { kind: "error", text: `续跑未启动：${renderThrown(error)}` };
        }
      },
    });

    host.commands.register({
      name: "resume-status",
      description: "dsh-resume：断点派生结果与续跑寄存器状态（只读）",
      handler: (invocation) => {
        const agent = invocation?.agent;
        const sessionId = typeof agent?.session?.id === "string" ? agent.session.id : "-";
        const state = folds.get(sessionId);
        const live = snapshotFor(agent);
        const anchor = anchorKeyOf(state);
        const rows = [...registers.values()]
          .filter((register) => register.sessionId === sessionId)
          .map(
            (register) =>
              `- ${register.key}  phase=${register.phase}  transport=${register.transport}  messageId=${register.messageId ?? "-"}${register.revokedBy === undefined ? "" : `  revokedBy=${register.revokedBy}`}`,
          );
        return {
          kind: "success",
          text: [
            `session: ${sessionId}`,
            `live breakpoint: ${live === null ? "none" : `${breakpointKey(live)} cause=${live.cause} truncated=${live.truncated} openCalls=${live.openCalls.length} queued=${live.queued}`}`,
            `anchor: ${anchor ?? "none"}`,
            `registers: ${rows.length === 0 ? "none" : `\n${rows.join("\n")}`}`,
            `auto-resume: ${diagnostics.autoResumes.length === 0 ? "none" : `\n- ${diagnostics.autoResumes.join("\n- ")}`}`,
            `goal re-arms: ${diagnostics.goalRearms.length === 0 ? "none" : `\n- ${diagnostics.goalRearms.join("\n- ")}`}`,
            diagnostics.warnings.length === 0 ? "warnings: none" : `warnings:\n- ${diagnostics.warnings.join("\n- ")}`,
          ].join("\n"),
        };
      },
    });
  });

  return {
    /** 测试与诊断面：不构成公开契约。 */
    __internals: { folds, registers, diagnostics, snapshotFor, settings, rearmGoal, autoResumeOnRestart },
  };
}

export const __internals = {
  SYSTEM_SECTION,
  RESUME_DIRECTIVE_LINES,
  BACKGROUND_HINT,
  CAUSE_USER,
  CAUSE_RESTART,
  classifyShellCall,
  causeOf,
  isAutoResumable,
  openTailSnapshot,
  resumeIdOf,
  PROJECTION_KEY,
  resumeBreakpointProjection,
  projectionView,
  projectionApply,
  STATUS_TEXT,
  FALLBACK_STATUS_TEXT,
  deriveBreakpoint,
  renderResume,
  breakpointKey,
  createResumeMessage,
};
