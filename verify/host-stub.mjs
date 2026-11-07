// dsh-resume 验收：幂等 / 让行 / 草稿路径 / 失败文案（宿主桩，不需要 dsh 运行时）。
//
// 桩只模拟 apply(ctx, config) 需要的服务面与事件面，形状取自 dsh 实际类型：
//   ctx.on / ctx.effect(generator) / ctx.inject(['commands']) / ctx.systemPrompt.section
//   ctx.agents.get|list / ctx.sessions.flush / agent.followup|inbox|session|status
// 用法：node plugins/dsh-resume/verify/host-stub.mjs

import { apply, breakpointKey, deriveBreakpoint, renderResume, DRAFT_SENTINEL, TOOL_OUTCOME_UNKNOWN } from "../index.js";

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

const ev = (type, data) => ({ type, data });

function abortedTail(events) {
  events.push(
    ev("user/message", { id: "u-1", role: "user", content: [{ type: "text", text: "跑长任务" }], source: { kind: "user" } }),
    ev("turn/start", { turn: 1 }),
    ev("step/start", { turn: 1, step: 1 }),
    ev("tool/call", { turn: 1, step: 1, callId: "call_1", name: "shell_exec", arguments: "{}" }),
    ev("tool/result", {
      turn: 1,
      step: 1,
      message: { id: "r-1", role: "tool", toolCallId: "call_1", content: [{ type: "text", text: "Error" }], isError: true },
      error: { name: "AbortError", code: "ABORTED_BEFORE_DISPATCH" },
    }),
    ev("assistant/message", { turn: 1, step: 1, message: { id: "a-1" }, stream: [] }),
    ev("step/start", { turn: 1, step: 2 }),
    ev("tool/call", { turn: 1, step: 2, callId: "call_2", name: "read_file", arguments: "{}" }),
    ev("assistant/message", { turn: 1, step: 2, message: { id: "a-2" }, stream: [], interrupted: true }),
    ev("turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } }),
  );
  return events;
}

function makeHost(options = {}) {
  const listeners = new Map();
  const commands = new Map();
  const sections = [];
  const warnings = [];
  const events = [];
  let teardown = undefined;
  /** goals 服务桩：记录 get/resume 调用，可按用例注入 phase/activation 或抛错。 */
  const goalCalls = { get: 0, resume: [] };
  const goals =
    options.goals === false
      ? undefined
      : {
          get() {
            goalCalls.get += 1;
            return options.goal === undefined ? undefined : { ...options.goal };
          },
          resume(agent, ref) {
            goalCalls.resume.push({ agentId: agent?.id, id: ref?.id, revision: ref?.revision });
            if (options.goalResumeError !== undefined) throw options.goalResumeError;
            return { ...(options.goal ?? {}), phase: "active", activation: "armed" };
          },
        };

  const agent = {
    id: "agent-1",
    status: "idle",
    inbox: {
      nextTurn: [],
      nextStep: [],
      remove(id) {
        for (const key of ["nextTurn", "nextStep"]) {
          const list = agent.inbox[key];
          const at = list.findIndex((message) => message.id === id);
          if (at >= 0) {
            const [message] = list.splice(at, 1);
            emit("agent/inbox/discarded", { agent, message });
            return true;
          }
        }
        return false;
      },
      prepend(target, message) {
        agent.inbox[target === "next-step" ? "nextStep" : "nextTurn"].unshift(message);
      },
    },
    session: { id: "sess-1", ownEvents: () => events },
    followup(message) {
      agent.inbox.nextTurn.push(message);
      emit("agent/inbox/inserted", { agent, message });
    },
    /** 人类消息抢占时会调它（真实签名 agent.cancel(reason, {keepInbox})）。 */
    cancel(reason, options) {
      cancels.push({ reason, options });
      agent.status = "idle";
      emit("session/event", agent.session, ev("turn/end", { turn: 2, reason: { kind: "aborted", reason } }));
      return true;
    },
  };
  const cancels = [];

  /** 投递事件；session/event 这类多参监听器要拿到全部实参（真实 ctx.emit 就是多参）。 */
  function emit(name, ...args) {
    for (const handler of listeners.get(name) ?? []) handler(...args);
  }

  const host = {
    on(name, handler) {
      const list = listeners.get(name) ?? [];
      list.push(handler);
      listeners.set(name, list);
      return () => {
        const current = listeners.get(name) ?? [];
        const at = current.indexOf(handler);
        if (at >= 0) current.splice(at, 1);
      };
    },
    effect(fn) {
      const produced = fn();
      if (produced !== undefined && typeof produced.next === "function") {
        const first = produced.next();
        teardown = first.value;
      } else if (typeof produced === "function") {
        teardown = produced;
      }
      return teardown;
    },
    inject(names, callback) {
      if (names.includes("commands")) {
        callback({
          commands: {
            register(definition) {
              commands.set(definition.name, definition);
              return () => commands.delete(definition.name);
            },
          },
        });
      }
      if (names.includes("goals") && goals !== undefined) {
        callback({ goals });
      }
      if (names.includes("sessionProjections")) {
        callback({ sessionProjections: { register: () => () => {} } });
      }
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    sessions: {
      async flush() {
        if (options.flushError !== undefined) throw options.flushError;
        return true;
      },
    },
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      list: () => [agent],
      currentInitiator: () => agent,
    },
    logger: { warn: (message) => warnings.push(message) },
  };

  /** 跑一遍 agent/pre-step 瀑布，next 落到 enter。 */
  async function preStep(messages) {
    const handlers = listeners.get("agent/pre-step") ?? [];
    const signal = new AbortController().signal;
    const invoke = (index) => async () => {
      if (index >= handlers.length) return { kind: "enter", messages };
      return handlers[index]({ agent, messages, turn: 2, step: 1, signal }, invoke(index + 1));
    };
    return invoke(0)();
  }

  const internals = apply(host, { restartSettleMs: 0, ...(options.config ?? {}) });
  return {
    host,
    agent,
    emit,
    preStep,
    commands,
    sections,
    warnings,
    events,
    internals,
    goalCalls,
    goals,
    /** 让装载时的自动续跑定时器 + 异步尾跑完。 */
    settle: () =>
      new Promise((resolve) => {
        setTimeout(() => setTimeout(() => setTimeout(resolve, 0), 0), 0);
      }),
    cancels,
    runTeardown: async () => teardown?.(),
  };
}

/** 事件按 loop 的真实顺序投递（session/event 折叠）。 */
function feed(harness) {
  abortedTail(harness.events);
  harness.emit("agent/created", { agent: harness.agent, source: "startup" });
  for (const event of harness.events) harness.emit("session/event", harness.agent.session, event);
}

// ── A. 幂等：同一 {turn,step} 连续触发 10 次，只入队 1 条 ───────────────────

{
  const harness = makeHost();
  feed(harness);
  const command = harness.commands.get("resume");
  ok("命令已注册 /resume", command !== undefined, { commands: [...harness.commands.keys()] });

  const snapshot = deriveBreakpoint("sess-1", harness.events, 0);
  eq("桩内派生断点键", breakpointKey(snapshot), "sess-1:1:2");

  const outcomes = [];
  for (let index = 0; index < 10; index += 1) outcomes.push(await command.handler({ agent: harness.agent }));
  eq("10 次触发只入队 1 条", harness.agent.inbox.nextTurn.length, 1);
  eq("首次成功、其余被拒", outcomes.map((outcome) => outcome.kind), [
    "success",
    ...Array.from({ length: 9 }, () => "error"),
  ]);
  ok(
    "重复触发文案",
    outcomes.slice(1).every((outcome) => outcome.text.includes("续跑已排队")),
    { texts: outcomes.slice(1).map((outcome) => outcome.text) },
  );

  const queuedMessage = harness.agent.inbox.nextTurn[0];
  eq("入队消息 source.kind=resume", queuedMessage.source.kind, "resume");
  eq("入队消息走命令通路", queuedMessage.source.transport, "command");
  eq("入队消息正文 = renderResume(snapshot)", queuedMessage.content[0].text, renderResume(snapshot));
  eq(
    "寄存器入队即置位（queued）",
    [...harness.internals.__internals.registers.values()].map((register) => `${register.key}:${register.phase}`),
    ["sess-1:1:2:queued"],
  );

  // 领取：turn/start + inbox/claimed（真实顺序），应转 consumed
  harness.emit("session/event", harness.agent.session, ev("turn/start", { turn: 2 }));
  harness.emit("agent/inbox/claimed", { agent: harness.agent, message: queuedMessage, turn: 2 });
  eq(
    "claimed 转 consumed",
    [...harness.internals.__internals.registers.values()].map((register) => register.phase),
    ["consumed"],
  );

  const afterClaim = [];
  for (let index = 0; index < 5; index += 1) afterClaim.push(await command.handler({ agent: harness.agent }));
  eq("claimed 后再触发 0 条", harness.agent.inbox.nextTurn.length, 1);
  ok(
    "claimed 后文案：该断点已续跑过",
    afterClaim.every((outcome) => outcome.kind === "error" && outcome.text === "该断点已续跑过"),
    { texts: afterClaim.map((outcome) => outcome.text) },
  );
}

// ── B. 让行：人类消息先到 → revoked，且不作废后重新入队 ────────────────────

{
  const harness = makeHost();
  feed(harness);
  const command = harness.commands.get("resume");
  const first = await command.handler({ agent: harness.agent });
  eq("让行用例：首次续跑入队", [first.kind, harness.agent.inbox.nextTurn.length], ["success", 1]);

  const human = { id: "human-1", role: "user", content: [{ type: "text", text: "先别继续，我改个需求" }], source: { kind: "user" } };
  harness.agent.inbox.nextTurn.push(human);
  harness.emit("agent/inbox/inserted", { agent: harness.agent, message: human });

  eq(
    "人类消息先到 → 寄存器 revoked",
    [...harness.internals.__internals.registers.values()].map((register) => `${register.phase}/${register.revokedBy}`),
    ["revoked/human-message"],
  );
  eq(
    "已排队的 <resume> 被撤回",
    harness.agent.inbox.nextTurn.filter((message) => message.source.kind === "resume").length,
    0,
  );
  eq(
    "人类消息仍保留",
    harness.agent.inbox.nextTurn.map((message) => message.id),
    ["human-1"],
  );
  eq(
    "revoked 后不再自动入队",
    harness.agent.inbox.nextTurn.filter((message) => message.source.kind === "resume").length,
    0,
  );
}

// ── B2. 先判后断：有排队人类输入时不排续跑（Codex InterruptIfNoPendingInput） ──

{
  const harness = makeHost();
  feed(harness);
  const human = { id: "human-2", role: "user", content: [{ type: "text", text: "先按我的来" }], source: { kind: "user" } };
  harness.agent.inbox.nextTurn.push(human);
  harness.emit("agent/inbox/inserted", { agent: harness.agent, message: human });

  const outcome = await harness.commands.get("resume").handler({ agent: harness.agent });
  eq("有排队输入 → 拒绝续跑", outcome, { kind: "error", text: "续跑已作废（你已发送新消息）" });
  eq("拒绝时不入队", harness.agent.inbox.nextTurn.map((message) => message.id), ["human-2"]);
  eq("拒绝时不留寄存器", harness.internals.__internals.registers.size, 0);
}

// ── B3. 已续跑（consumed）之后又有人类消息：寄存器转 superseded（留痕，不改历史） ──

{
  const harness = makeHost();
  feed(harness);
  const first = await harness.commands.get("resume").handler({ agent: harness.agent });
  eq("B3 前置：续跑已入队", first.kind, "success");
  const queued = harness.agent.inbox.nextTurn[0];
  harness.emit("session/event", harness.agent.session, ev("turn/start", { turn: 2 }));
  harness.emit("agent/inbox/claimed", { agent: harness.agent, message: queued, turn: 2 });
  harness.agent.inbox.nextTurn.length = 0;
  eq(
    "B3 前置：claimed 转 consumed",
    [...harness.internals.__internals.registers.values()].map((register) => register.phase),
    ["consumed"],
  );

  const later = { id: "human-later", role: "user", content: [{ type: "text", text: "你好" }], source: { kind: "user" } };
  harness.agent.inbox.nextTurn.push(later);
  harness.emit("agent/inbox/inserted", { agent: harness.agent, message: later });
  eq(
    "consumed 之后来人类消息 → superseded",
    [...harness.internals.__internals.registers.values()].map((register) => `${register.phase}/${register.supersededBy ?? "-"}`),
    ["superseded/human-message"],
  );
}

// ── C. 草稿备用路径：哨兵入队 → pre-step 替换成 <resume> 模板 ───────────────

{
  const harness = makeHost();
  feed(harness);
  const sentinel = {
    id: "draft-1",
    role: "user",
    content: [{ type: "text", text: DRAFT_SENTINEL }],
    source: { kind: "user" },
  };
  harness.agent.inbox.nextTurn.push(sentinel);
  harness.emit("agent/inbox/inserted", { agent: harness.agent, message: sentinel });
  eq(
    "哨兵入队即置位（resume-draft）",
    [...harness.internals.__internals.registers.values()].map((register) => `${register.phase}/${register.transport}`),
    ["queued/resume-draft"],
  );

  // 第二个哨兵：同一断点只保留 1 条
  const sentinel2 = { id: "draft-2", role: "user", content: [{ type: "text", text: DRAFT_SENTINEL }], source: { kind: "user" } };
  harness.agent.inbox.nextTurn.push(sentinel2);
  harness.emit("agent/inbox/inserted", { agent: harness.agent, message: sentinel2 });
  eq("第二个哨兵被丢弃", harness.agent.inbox.nextTurn.some((message) => message.id === "draft-2"), false);

  // 真实顺序：turn/start → claimed → pre-step
  harness.emit("session/event", harness.agent.session, ev("turn/start", { turn: 2 }));
  harness.emit("agent/inbox/claimed", { agent: harness.agent, message: sentinel, turn: 2 });
  harness.agent.inbox.nextTurn.length = 0;

  const decision = await harness.preStep([sentinel]);
  eq("pre-step 准入 enter", decision.kind, "enter");
  const rewritten = decision.messages[0];
  ok("草稿正文被替换（裸哨兵不进历史）", rewritten.content[0].text.startsWith("<resume id=\"R-1-2\""), {
    text: rewritten.content[0].text,
  });
  ok("哨兵字符未出现在历史消息里", !rewritten.content[0].text.includes(DRAFT_SENTINEL), { text: rewritten.content[0].text });
  eq("替换消息 source.kind=resume", rewritten.source.kind, "resume");
  eq("替换消息 transport=resume-draft", rewritten.source.transport, "resume-draft");
  eq(
    "替换后与 renderResume(派生快照) 逐字一致",
    rewritten.content[0].text,
    renderResume(deriveBreakpoint("sess-1", harness.events.filter((event) => event.type !== "turn/start" || event.data.turn === 1), 0)),
  );
}

// ── C2. 草稿路径的先判后断：队列里已有人类输入时哨兵被丢弃 ─────────────────

{
  const harness = makeHost();
  feed(harness);
  const human = { id: "human-3", role: "user", content: [{ type: "text", text: "我改主意了" }], source: { kind: "user" } };
  harness.agent.inbox.nextTurn.push(human);
  harness.emit("agent/inbox/inserted", { agent: harness.agent, message: human });

  const sentinel = { id: "draft-9", role: "user", content: [{ type: "text", text: "⟦dsh-resume⟧" }], source: { kind: "user" } };
  harness.agent.inbox.nextTurn.push(sentinel);
  harness.emit("agent/inbox/inserted", { agent: harness.agent, message: sentinel });

  eq("哨兵被丢弃", harness.agent.inbox.nextTurn.some((message) => message.id === "draft-9"), false);
  eq("人类消息仍在", harness.agent.inbox.nextTurn.map((message) => message.id), ["human-3"]);
  eq("哨兵不置寄存器", harness.internals.__internals.registers.size, 0);
}

// ── D. 失败文案：flush 失败 → 续跑未启动：{原因} 且不入队 ───────────────────

{
  const harness = makeHost({ flushError: new Error("write path closed") });
  abortedTail(harness.events);
  harness.emit("agent/created", { agent: harness.agent, source: "startup" });
  for (const event of harness.events) harness.emit("session/event", harness.agent.session, event);
  const outcome = await harness.commands.get("resume").handler({ agent: harness.agent });
  eq("flush 失败文案", outcome, { kind: "error", text: "续跑未启动：write path closed" });
  eq("flush 失败不入队", harness.agent.inbox.nextTurn.length, 0);
  eq(
    "flush 失败不留寄存器",
    harness.internals.__internals.registers.size,
    0,
  );
}

// ── E0. 宿主重启尾巴：装载即自己接着干（不点、不问） ──────────────────────

/**
 * 真实事故形状（session-fbcb5c6b）：宿主在轮内退出，内核装载时补
 * TOOL_OUTCOME_UNKNOWN 的合成结果 + step/end + turn/end {kind:'interrupted'}。
 * @param events - 目标事件数组。
 * @returns the same array.
 */
function interruptedTail(events) {
  events.push(
    ev("user/message", {
      id: "u-restart",
      role: "user",
      content: [{ type: "text", text: "这一轮把 M7 收口" }],
      source: { kind: "user" },
    }),
    ev("turn/start", { turn: 1 }),
    ev("step/start", { turn: 1, step: 10 }),
    ev("tool/call", { turn: 1, step: 10, callId: "call_ask", name: "ask_user_question", arguments: "{}" }),
    ev("tool/result", {
      turn: 1,
      step: 10,
      message: { id: "r-ask", role: "tool", toolCallId: "call_ask", content: [{ type: "text", text: "interrupted" }], isError: true },
      error: { name: "ToolOutcomeUnknownError", code: TOOL_OUTCOME_UNKNOWN },
    }),
    ev("step/end", { turn: 1, step: 10 }),
    ev("turn/end", { turn: 1, reason: { kind: "interrupted" } }),
  );
  return events;
}

/** 装载一个已有中断尾巴的会话（真实顺序：agent/created → session/event 回放）。 */
async function boot(options, tail) {
  const harness = makeHost(options);
  tail(harness.events);
  harness.emit("agent/created", { agent: harness.agent, source: "startup" });
  for (const event of harness.events) harness.emit("session/event", harness.agent.session, event);
  await harness.settle();
  return harness;
}

{
  const harness = await boot({}, interruptedTail);
  const queued = harness.agent.inbox.nextTurn.filter((message) => message.source?.kind === "resume");
  eq("重启断点：装载即自动续跑，不需要人点", queued.length, 1);
  eq("自动续跑来源分类 transport=auto-restart", queued[0]?.source?.transport, "auto-restart");
  ok(
    "自动续跑正文带 restart 原因",
    queued[0]?.content?.[0]?.text?.startsWith('<resume id="R-1-10" reason="host-restart">'),
    { text: queued[0]?.content?.[0]?.text },
  );
  ok(
    "自动续跑正文要求接着做完且不问下一步/轮数",
    queued[0]?.content?.[0]?.text?.includes("把断点前正在做的那件事接着做完") &&
      queued[0]?.content?.[0]?.text?.includes("不要询问「下一步做什么」「要不要继续」「继续几轮」"),
    { text: queued[0]?.content?.[0]?.text },
  );
  ok(
    "自动续跑正文把未闭合的 ask_user_question 标成结果未知",
    queued[0]?.content?.[0]?.text?.includes("ask_user_question(call_ask)：结果未知"),
    { text: queued[0]?.content?.[0]?.text },
  );
  eq(
    "自动续跑留下寄存器（queued）",
    [...harness.internals.__internals.registers.values()].map((register) => `${register.key}:${register.phase}`),
    ["sess-1:1:10:queued"],
  );
}

// ── E1. 用户按的停止：装载不自动续跑（停止是人的意思，等他自己点） ──────────

{
  const harness = await boot({}, abortedTail);
  eq("用户停止：装载时不自动续跑", harness.agent.inbox.nextTurn.length, 0);
  eq("用户停止：不留寄存器", harness.internals.__internals.registers.size, 0);
  const outcome = await harness.commands.get("resume").handler({ agent: harness.agent });
  eq("用户停止：点一次才续跑", [outcome.kind, harness.agent.inbox.nextTurn.length], ["success", 1]);
  eq("用户停止：续跑来源 transport=command", harness.agent.inbox.nextTurn[0].source.transport, "command");
}

// ── E2. 有人类输入排队时，重启也不抢跑 ────────────────────────────────────

{
  const harness = await boot({}, interruptedTail);
  // boot 之后人工模拟「排队里已有人的输入」：先清掉自动那条，再排人类消息。
  harness.agent.inbox.nextTurn.length = 0;
  const human = { id: "human-boot", role: "user", content: [{ type: "text", text: "等等，先按我说的来" }], source: { kind: "user" } };
  harness.agent.inbox.nextTurn.push(human);
  harness.internals.__internals.registers.clear();
  await harness.internals.__internals.autoResumeOnRestart(harness.agent, "idle");
  eq("排队里有人的输入 → 不自动续跑", harness.agent.inbox.nextTurn.map((message) => message.id), ["human-boot"]);
}

// ── E3. 跨进程去重：历史里已续跑过同一坐标就不再点火 ───────────────────────

{
  const harness = await boot({}, (events) => {
    interruptedTail(events);
    // 上一进程在入队之后、那一轮开始之前就死了：队列插入留在日志里，尾巴仍是 1:10。
    events.push(
      ev("agent/inbox/spliced", {
        target: "next-turn",
        start: 0,
        inserted: [
          {
            id: "u-prev-resume",
            role: "user",
            content: [{ type: "text", text: '<resume id="R-1-10" reason="host-restart">\n（上一进程注入过）\n</resume>' }],
            source: { kind: "resume", transport: "auto-restart" },
          },
        ],
      }),
    );
  });
  eq(
    "同一坐标已续跑过 → 不重复自动续跑（历史里有那条 <resume id>）",
    harness.agent.inbox.nextTurn.filter((message) => message.source?.kind === "resume").length,
    0,
  );
  ok(
    "去重原因进诊断",
    harness.internals.__internals.diagnostics.autoResumes.some((line) => line.includes("already resumed in history")),
    { lines: harness.internals.__internals.diagnostics.autoResumes },
  );
}

// ── E4. goal 重新武装：重启后让轮驱动接着跑，而不是问「继续几轮」 ──────────

{
  const harness = await boot(
    { goal: { id: "goal-1", revision: 3, phase: "active", activation: "disarmed" } },
    interruptedTail,
  );
  eq("goal active+disarmed → 重新武装一次", harness.goalCalls.resume, [{ agentId: "agent-1", id: "goal-1", revision: 3 }]);
  ok(
    "重新武装留痕",
    harness.internals.__internals.diagnostics.goalRearms.some((line) => line.includes("goal-1@3")),
    { lines: harness.internals.__internals.diagnostics.goalRearms },
  );
}

{
  const harness = await boot({ goal: { id: "goal-2", revision: 5, phase: "paused", activation: "disarmed" } }, interruptedTail);
  eq("goal 是 paused → 不动它（用户暂停优先）", harness.goalCalls.resume, []);
}

{
  const harness = await boot({ goal: { id: "goal-3", revision: 1, phase: "active", activation: "armed" } }, interruptedTail);
  eq("goal 已 armed → 不重复 resume", harness.goalCalls.resume, []);
}

{
  const harness = await boot(
    {
      goal: { id: "goal-4", revision: 2, phase: "active", activation: "disarmed" },
      goalResumeError: new Error("goal\"goal-4\" exhausted 256 goal rounds"),
    },
    interruptedTail,
  );
  eq("轮数用尽时 rearm 抛错 → 不崩、不入队重复", harness.agent.inbox.nextTurn.filter((m) => m.source?.kind === "resume").length, 1);
  ok(
    "rearm 失败只进 warnings",
    harness.warnings.some((line) => line.includes("goal re-arm skipped")),
    { warnings: harness.warnings },
  );
}

// ── E5. 命令通路续跑也重新武装 goal（点一下 = 人类授权） ──────────────────

{
  const harness = await boot({ goal: { id: "goal-5", revision: 1, phase: "active", activation: "disarmed" } }, abortedTail);
  const outcome = await harness.commands.get("resume").handler({ agent: harness.agent });
  eq("命令通路续跑成功", outcome.kind, "success");
  eq("命令通路也重新武装 goal", harness.goalCalls.resume.map((call) => call.id), ["goal-5"]);
}

// ── E6. 没有 goals 服务（headless 模板）也能跑 ─────────────────────────────

{
  const harness = await boot({ goals: false }, interruptedTail);
  eq("无 goals 服务：自动续跑照旧", harness.agent.inbox.nextTurn.filter((m) => m.source?.kind === "resume").length, 1);
  eq("无 goals 服务：不产生 rearm 记录", harness.internals.__internals.diagnostics.goalRearms.length, 0);
}

// ── E7. 自动续跑后不再重复：断点被消费 + 尾巴闭合 → 没有第二个断点 ────────

{
  const harness = await boot({}, interruptedTail);
  const queued = harness.agent.inbox.nextTurn[0];
  harness.emit("session/event", harness.agent.session, ev("turn/start", { turn: 2 }));
  harness.emit("agent/inbox/claimed", { agent: harness.agent, message: queued, turn: 2 });
  harness.agent.inbox.nextTurn.length = 0;
  await harness.settle();
  await harness.internals.__internals.autoResumeOnRestart(harness.agent, "idle");
  eq("新一轮开始后不再自动续跑", harness.agent.inbox.nextTurn.length, 0);
}

// ── E8. 安静窗口：装载后立刻提交的任务优先，自动续跑整条让行 ────────────────

{
  const harness = makeHost({ config: { restartSettleMs: 40 } });
  interruptedTail(harness.events);
  harness.emit("agent/created", { agent: harness.agent, source: "startup" });
  for (const event of harness.events) harness.emit("session/event", harness.agent.session, event);
  // 一次性客户端的行为：建完 agent 立刻把任务排进队列。
  const human = { id: "human-boot-2", role: "user", content: [{ type: "text", text: "只回答四个字：我在" }], source: { kind: "user" } };
  harness.agent.inbox.nextTurn.push(human);
  harness.emit("agent/inbox/inserted", { agent: harness.agent, message: human });

  await new Promise((resolve) => setTimeout(resolve, 90));
  eq("安静窗口里来了人类消息 → 不自动续跑", harness.agent.inbox.nextTurn.map((m) => m.id), ["human-boot-2"]);
  eq("安静窗口里来了人类消息 → 不排寄存器", harness.internals.__internals.registers.size, 0);
}

{
  const harness = makeHost({ config: { restartSettleMs: 30 } });
  interruptedTail(harness.events);
  harness.emit("agent/created", { agent: harness.agent, source: "startup" });
  for (const event of harness.events) harness.emit("session/event", harness.agent.session, event);
  await new Promise((resolve) => setTimeout(resolve, 80));
  eq(
    "安静窗口结束且无人插话 → 自动续跑照常",
    harness.agent.inbox.nextTurn.filter((m) => m.source?.kind === "resume").length,
    1,
  );
}

// ── E9. 人类消息抢占：续跑轮还没有产出时，人的消息立刻接管 ────────────────

{
  const harness = makeHost();
  interruptedTail(harness.events);
  harness.emit("agent/created", { agent: harness.agent, source: "startup" });
  for (const event of harness.events) harness.emit("session/event", harness.agent.session, event);
  await harness.settle();
  const resumeMessage = harness.agent.inbox.nextTurn[0];
  harness.emit("session/event", harness.agent.session, ev("turn/start", { turn: 2 }));
  harness.agent.status = "running";
  harness.emit("agent/inbox/claimed", { agent: harness.agent, message: resumeMessage, turn: 2 });
  harness.agent.inbox.nextTurn.length = 0;

  const human = { id: "human-preempt", role: "user", content: [{ type: "text", text: "停，改做另一件事" }], source: { kind: "user" } };
  harness.agent.inbox.nextTurn.push(human);
  harness.emit("agent/inbox/inserted", { agent: harness.agent, message: human });

  eq("续跑轮无产出 + 人类消息 → 撤掉该轮", harness.cancels.length, 1);
  eq("撤销用真实签名（keepInbox 保住人类消息）", harness.cancels[0]?.options, { keepInbox: true });
  eq("人类消息仍在队列里", harness.agent.inbox.nextTurn.map((m) => m.id), ["human-preempt"]);
}

{
  const harness = makeHost();
  interruptedTail(harness.events);
  harness.emit("agent/created", { agent: harness.agent, source: "startup" });
  for (const event of harness.events) harness.emit("session/event", harness.agent.session, event);
  await harness.settle();
  const resumeMessage = harness.agent.inbox.nextTurn[0];
  harness.emit("session/event", harness.agent.session, ev("turn/start", { turn: 2 }));
  harness.agent.status = "running";
  harness.emit("agent/inbox/claimed", { agent: harness.agent, message: resumeMessage, turn: 2 });
  // 模型已经产出：这时候撤轮会丢工作，只能让人等到下一步边界。
  harness.emit("session/event", harness.agent.session, ev("assistant/message", { turn: 2, step: 1, message: { id: "a-2-1" }, stream: [] }));
  harness.agent.inbox.nextTurn.length = 0;

  const human = { id: "human-late", role: "user", content: [{ type: "text", text: "顺便看一下日志" }], source: { kind: "user" } };
  harness.agent.inbox.nextTurn.push(human);
  harness.emit("agent/inbox/inserted", { agent: harness.agent, message: human });

  eq("续跑轮已产出 → 不撤轮（不丢工作）", harness.cancels.length, 0);
}

// ── E. 系统提示段：只注入一段、逐字恒定 ────────────────────────────────────

{
  const harness = makeHost();
  eq(
    "系统提示段注册一次",
    harness.sections.map((section) => section.name),
    ["resume:contract"],
  );
  eq(
    "系统提示段 interpolate=false（字节稳定）",
    harness.sections[0].interpolate,
    false,
  );
}

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
