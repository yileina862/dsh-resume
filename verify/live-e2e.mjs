// dsh-resume 实机验收：在活体 host（默认 127.0.0.1:3080）上走真实链路
//   session/create → session/prompt（长任务）→ session/cancel（= 停止按钮）
//   → commands/execute "/resume"（= 「继续」按钮点的那一下）→ 读回会话事件核对
//
// 用法：node plugins/dsh-resume/verify/live-e2e.mjs <cookie> [sessionId]
//   cookie：浏览器会话 cookie（dsh-auth-...=v1....），从 `curl -c jar` 的 cookie jar 取。
//   带 sessionId：跳过阶段 1–3，直接在既有会话上做续跑（崩溃/中断后重试用）。

const BASE = process.env.DSH_WEB_URL ?? "http://127.0.0.1:3080";
const cookie = process.argv[2];
const reuseSessionId = process.argv[3];
if (cookie === undefined) {
  console.error("usage: node live-e2e.mjs <cookie> [sessionId]");
  process.exit(2);
}

let rpcSeq = 0;
async function rpc(method, payload) {
  rpcSeq += 1;
  const response = await fetch(`${BASE}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ type: "client-request", rpcId: `e2e-${rpcSeq}`, method, payload: { args: payload } }),
  });
  const body = await response.json();
  if (body?.result?.ok !== true) {
    const error = new Error(`${method} failed: ${JSON.stringify(body?.result?.error ?? body)}`);
    error.remote = body?.result?.error;
    throw error;
  }
  return body.result.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 读会话事件；session/page 要求 throughSeq ≤ 当前 cursor，从错误里取真值重试。 */
async function readEvents(sessionId) {
  let throughSeq = Number.MAX_SAFE_INTEGER;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const page = await rpc("session/page", {
        request: {
          address: { kind: "session", sessionId },
          throughSeq,
          maxMessages: 500,
        },
      });
      const events = [];
      const walk = (value) => {
        if (value === null || typeof value !== "object") return;
        if (Array.isArray(value)) {
          for (const item of value) walk(item);
          return;
        }
        if (value.type === "event" && typeof value.event?.type === "string") {
          events.push(value.event);
          return;
        }
        for (const item of Object.values(value)) walk(item);
      };
      walk(page);
      const merged = new Map();
      for (const event of events) merged.set(`${event.type}#${event.seq}`, event);
      return [...merged.values()].sort((left, right) => left.seq - right.seq);
    } catch (error) {
      const match = /past cursor (\d+)/.exec(error?.remote?.message ?? error.message);
      if (match === null) throw error;
      throughSeq = Number(match[1]);
    }
  }
  throw new Error("could not read session page");
}

/** 读宿主侧投影（客户端判断「要不要把发送键变成三角」就靠它）。 */
async function readProjection(sessionId, key) {
  const values = await rpc("session/projections", { request: { sessionId } });
  return values?.values?.[key];
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("");

/** 轮询到条件成立或超时。 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(700);
  }
}

const report = [];
const ok = (name, condition, detail) => {
  report.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? "ok  " : "FAIL"} ${name}${condition ? "" : ` :: ${JSON.stringify(detail).slice(0, 600)}`}`);
};

let sessionId = reuseSessionId;
if (sessionId === undefined) {
  const created = await rpc("session/create", { request: { cwd: "/tmp/dsh-resume-e2e" } });
  sessionId = created.sessionId;
  console.log(`session: ${sessionId}`);

  const task = [
    "按顺序执行五步，每步都要真的跑命令并把结果贴出来，不要提前总结：",
    "1) bash: sleep 12; echo step-1",
    "2) bash: sleep 12; echo step-2",
    "3) bash: sleep 12; echo step-3",
    "4) bash: sleep 12; echo step-4",
    "5) bash: sleep 12; echo step-5",
  ].join("\n");
  await rpc("session/prompt", {
    request: {
      requestId: `e2e-prompt-${Date.now()}`,
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: task }],
    },
  });
  console.log("prompted; waiting for the first tool call…");
  const started = await waitFor(
    async () => (await readEvents(sessionId)).some((event) => event.type === "tool/call"),
    45000,
  );
  ok("在途工具调用已出现（可被中断的窗口）", started === true, { started });
  await sleep(1200);

  const cancel = await rpc("session/cancel", { request: { sessionId } });
  console.log(`cancelled: ${JSON.stringify(cancel)}; waiting for the aborted turn…`);
  const abortedSeen = await waitFor(
    async () =>
      (await readEvents(sessionId)).some(
        (event) => event.type === "turn/end" && event.data?.reason?.kind === "aborted",
      ),
    25000,
  );
  ok("取消确实落成了 aborted 轮", abortedSeen === true, { abortedSeen });
} else {
  console.log(`session (reused): ${sessionId}`);
}

// ── 断点事实核对（停止之后、续跑之前） ─────────────────────────────────────
const before = await readEvents(sessionId);
const abortedTurns = before.filter((event) => event.type === "turn/end" && event.data?.reason?.kind === "aborted");
const interruptedAnchors = before.filter((event) => event.type === "assistant/message" && event.data?.interrupted === true);
const calls = before.filter((event) => event.type === "tool/call");
const results = before.filter((event) => event.type === "tool/result");
const openCalls = calls.filter((call) => !results.some((result) => result.data?.message?.toolCallId === call.data.callId));
const synthetic = results.filter((result) => ["ABORTED_BEFORE_DISPATCH", "TOOL_OUTCOME_UNKNOWN", "TOOL_NOT_STARTED", "TOOL_ABORTED"].includes(result.data?.error?.code));
console.log(
  `before: events=${before.length} abortedTurns=${abortedTurns.length} interruptedAnchors=${interruptedAnchors.length} openCalls=${openCalls.length} syntheticResults=${synthetic.length}`,
);
ok("停止产生了 aborted 轮", abortedTurns.length > 0, abortedTurns.map((event) => event.data));
// 事件级取证只作日志：session/page 的窗口不一定带出中断尾部的合成结果，
// 真正的判据是「宿主投影 + <resume> 正文」，两者下面各自断言。
console.log(
  `forensics: interruptedAnchors=${interruptedAnchors.length} openCalls=${openCalls.length} synthetic=${synthetic.length}`,
);


// ── 投影：客户端据此把发送键变成续跑三角 ───────────────────────────────────
const projectionBefore = await readProjection(sessionId, "resumeBreakpoint");
console.log(`projection before resume: ${JSON.stringify(projectionBefore)}`);
ok("投影 resumeBreakpoint 已上线", projectionBefore !== undefined && projectionBefore !== null, projectionBefore);
ok("投影在停止后报告 available=true", projectionBefore?.available === true, projectionBefore);
ok("投影坐标与断点一致", projectionBefore?.turn === abortedTurns.at(-1)?.data?.turn, {
  projection: projectionBefore,
  aborted: abortedTurns.at(-1)?.data,
});

// ── 一次点击：/resume（主发送键被接管后点的那一下） ────────────────────────
const executed = await rpc("commands/execute", { agentId: sessionId, line: "/resume", submittedAttachments: [] });
const executedText = JSON.stringify(executed);
console.log(`commands/execute /resume => ${executedText.slice(0, 300)}`);
ok("Host 接受续跑", /已续跑断点/.test(executedText), executed);

await sleep(30000);

const after = await readEvents(sessionId);
const resumeEvents = after.filter((event) => event.type === "user/message" && textOf(event.data?.content).startsWith("<resume id="));
const resumeEvent = resumeEvents.at(-1);
ok("历史里出现 <resume> 用户消息", resumeEvent !== undefined, after.slice(-8).map((event) => event.type));
if (resumeEvent !== undefined) {
  const text = textOf(resumeEvent.data.content);
  console.log(`--- <resume> (seq ${resumeEvent.seq}) ---\n${text}\n---`);
  ok("<resume> 带断点坐标 id=R-{turn}-{step}", /<resume id="R-\d+-\d+" reason="user-interrupted">/.test(text), text);
  ok("<resume> 是续跑来源而非人类消息", resumeEvent.data.source?.kind === "resume", resumeEvent.data.source);
  ok("裸「继续」/哨兵未进历史", !text.includes("⟦dsh-resume⟧"), text);
}

// 前缀未变：resume 之前的全部事件逐条一致（seq + type）
const beforePrefix = before.map((event) => `${event.seq}:${event.type}`);
const afterPrefix = after.slice(0, before.length).map((event) => `${event.seq}:${event.type}`);
ok("历史前缀未被改写（只追加）", JSON.stringify(beforePrefix) === JSON.stringify(afterPrefix), {
  before: before.length,
  after: after.length,
  firstDiff: beforePrefix.findIndex((value, index) => value !== afterPrefix[index]),
});

// 续跑后是否接着干：新出现的 assistant/tool 事件
const tail = after.slice(before.length);
const tailAssistant = tail.filter((event) => event.type === "assistant/message");
const tailTools = tail.filter((event) => event.type === "tool/call");
const tailText = textOf(tailAssistant.at(-1)?.data?.message?.content);
ok("续跑后模型继续产出", tailAssistant.length > 0 || tailTools.length > 0, tail.map((event) => event.type));
console.log(`\n--- tail after resume ---`);
for (const event of tail.slice(0, 14)) {
  const detail =
    event.type === "assistant/message"
      ? textOf(event.data?.message?.content).slice(0, 120)
      : event.type === "tool/call"
        ? `${event.data?.name}(${event.data?.callId}) ${String(event.data?.arguments).slice(0, 60)}`
        : event.type === "user/message"
          ? textOf(event.data?.content).slice(0, 120)
          : "";
  console.log(`${event.seq} ${event.type} ${detail.replaceAll("\n", " ")}`);
}
ok("续跑后没有再问一遍需求", !/请(你)?(确认|提供)|你希望我|要不要我|是否继续/.test(tailText), tailText.slice(0, 300));

// 续跑开始后投影必须回落（三角立刻变回发送键）
const projectionAfter = await readProjection(sessionId, "resumeBreakpoint");
console.log(`projection after resume: ${JSON.stringify(projectionAfter)}`);
ok("投影在续跑后回落为 available=false", projectionAfter?.available === false, projectionAfter);

// 断点已消费：同一断点再点一次应为「该断点已续跑过」或「没有可续跑的断点」
const again = await rpc("commands/execute", { agentId: sessionId, line: "/resume", submittedAttachments: [] });
const againText = JSON.stringify(again);
ok("重复续跑被拒（幂等）", /该断点已续跑过|没有可续跑的断点|续跑已排队/.test(againText), again);

const failed = report.filter((item) => !item.ok);
console.log(`\n${report.length - failed.length}/${report.length} passed  (session ${sessionId})`);
process.exit(failed.length === 0 ? 0 : 1);
