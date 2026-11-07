// dsh-resume 实机补充验收（A#3）：中断点落在 shell 类调用上时，<resume> 必须带
// 「先核对后台 job / 子进程，不要重跑」的提示。
//
// 用法：node plugins/dsh-resume/verify/live-background.mjs <cookie>
//   DSH_WEB_URL 指向被验收的宿主（默认 3080）。

const BASE = process.env.DSH_WEB_URL ?? "http://127.0.0.1:3080";
const cookie = process.argv[2];
if (cookie === undefined) {
  console.error("usage: node live-background.mjs <cookie>");
  process.exit(2);
}

let seq = 0;
async function rpc(method, payload) {
  seq += 1;
  const response = await fetch(`${BASE}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ type: "client-request", rpcId: `bg-${seq}`, method, payload: { args: payload } }),
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
const textOf = (content) => (Array.isArray(content) ? content : []).filter((b) => b?.type === "text").map((b) => b.text).join("");

async function readEvents(sessionId) {
  let throughSeq = Number.MAX_SAFE_INTEGER;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const page = await rpc("session/page", { request: { address: { kind: "session", sessionId }, throughSeq, maxMessages: 500 } });
      const events = [];
      const walk = (value) => {
        if (value === null || typeof value !== "object") return;
        if (Array.isArray(value)) return value.forEach(walk);
        if (value.type === "event" && typeof value.event?.type === "string") return events.push(value.event);
        Object.values(value).forEach(walk);
      };
      walk(page);
      const merged = new Map();
      for (const event of events) merged.set(`${event.type}#${event.seq}`, event);
      return [...merged.values()].sort((a, b) => a.seq - b.seq);
    } catch (error) {
      const match = /past cursor (\d+)/.exec(error?.remote?.message ?? error.message);
      if (match === null) throw error;
      throughSeq = Number(match[1]);
    }
  }
  throw new Error("could not read session page");
}

const report = [];
const ok = (name, condition, detail) => {
  report.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "ok  " : "FAIL"} ${name}${condition ? "" : ` :: ${JSON.stringify(detail).slice(0, 500)}`}`);
};

const created = await rpc("session/create", { request: { cwd: "/tmp/dsh-resume-e2e" } });
const sessionId = created.sessionId;
console.log(`session: ${sessionId}`);

const task = [
  "严格按顺序调用 bash 工具两次，不要用别的工具，也不要一次合并：",
  "第 1 次：参数 run_in_background 设为 true，command 为 `sleep 90; echo bg-done`。",
  "第 2 次：参数 run_in_background 设为 false，command 为 `sleep 25; echo fg-done`。",
  "两次都要真的调用工具。",
].join("\n");

await rpc("session/prompt", {
  request: { requestId: `bg-prompt-${Date.now()}`, sessionId, mode: "queue", content: [{ type: "text", text: task }] },
});
console.log("prompted; waiting for the shell calls…");
await sleep(14000);

await rpc("session/cancel", { request: { sessionId } });
console.log("cancelled; waiting for idle…");
await sleep(7000);

const before = await readEvents(sessionId);
const aborted = before.filter((event) => event.type === "turn/end" && event.data?.reason?.kind === "aborted");
const calls = before.filter((event) => event.type === "tool/call").map((event) => event.data);
const backgroundCalls = calls.filter((call) => String(call.arguments ?? "").includes("run_in_background"));
console.log(`calls=${calls.length} backgroundFlagged=${backgroundCalls.length} abortedTurns=${aborted.length}`);
ok("停止产生了 aborted 轮", aborted.length > 0, aborted.map((e) => e.data));

const projection = await rpc("session/projections", { request: { sessionId } });
const breakpoint = projection?.values?.resumeBreakpoint;
console.log(`projection: ${JSON.stringify(breakpoint)}`);
ok("投影报告 available=true 且带未闭合调用", breakpoint?.available === true && breakpoint.openCalls > 0, breakpoint);

const executed = await rpc("commands/execute", { agentId: sessionId, line: "/resume", submittedAttachments: [] });
console.log(`/resume => ${JSON.stringify(executed?.result ?? executed).slice(0, 200)}`);
ok("Host 接受续跑", /已续跑断点/.test(JSON.stringify(executed)), executed);

await sleep(20000);

const after = await readEvents(sessionId);
const resumeEvent = after.filter((event) => event.type === "user/message" && textOf(event.data?.content).startsWith("<resume id=")).at(-1);
const resumeText = resumeEvent === undefined ? "" : textOf(resumeEvent.data.content);
if (resumeText !== "") console.log(`--- <resume> ---\n${resumeText}\n---`);

const hintMatched = /该调用是后台任务|该命令可能有子进程仍在运行/.test(resumeText);
ok("<resume> 带 shell/后台事实", hintMatched, resumeText);
ok("提示陈述了后台/子进程事实", /有 job 记录|子进程仍在运行/.test(resumeText), resumeText);
ok("提示不含「该怎么做」的动作指令", !/先 job_list|不要重跑|不要直接重跑|先核验/.test(resumeText), resumeText);

const inboxAfter = await rpc("session/projections", { request: { sessionId } });
const inbox = inboxAfter?.values?.inbox;
const pendingResume = ["next-turn", "next-step"].some((key) => (inbox?.[key] ?? []).some((message) => message?.source?.kind === "resume"));
ok("续跑消费后 inbox 不再挂 <resume>", pendingResume === false, inbox);

const failed = report.filter((item) => !item.ok);
console.log(`\n${report.length - failed.length}/${report.length} passed  (session ${sessionId})`);
process.exit(failed.length === 0 ? 0 : 1);
