// dsh-resume 回归验收（对应「Fix issue 1」事故）：中断之后人类只发一句寒暄，
// 模型不得把断点后面的旧待办继续执行。
//
// 剧本：提示里排两步（第 2 步会写一个标记文件）→ 中途停止 → 只发「你好」→
// 断言：这条寒暄的 turn 里没有任何工具调用去碰那个标记文件，文件也不存在。
//
// 用法：node plugins/dsh-resume/verify/live-hello.mjs <cookie>

import { existsSync, rmSync } from "node:fs";

const BASE = process.env.DSH_WEB_URL ?? "http://127.0.0.1:3080";
const cookie = process.argv[2];
const WORKSPACE = "/tmp/dsh-resume-hello";
const MARKER = `${WORKSPACE}/regression.txt`;

if (cookie === undefined) {
  console.error("usage: node live-hello.mjs <cookie>");
  process.exit(2);
}

let seq = 0;
async function rpc(method, payload) {
  seq += 1;
  const response = await fetch(`${BASE}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ type: "client-request", rpcId: `hello-${seq}`, method, payload: { args: payload } }),
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
  console.log(`${condition ? "ok  " : "FAIL"} ${name}${condition ? "" : ` :: ${JSON.stringify(detail).slice(0, 600)}`}`);
};

if (existsSync(MARKER)) rmSync(MARKER);

const created = await rpc("session/create", { request: { cwd: WORKSPACE } });
const sessionId = created.sessionId;
console.log(`session: ${sessionId}`);

const task = [
  "严格按顺序做两步，都用 bash 工具，不要合并：",
  "第 1 步：`sleep 8; echo one`。",
  `第 2 步：\`echo WROTE > ${MARKER}\`，这一步就是「提交动作」。`,
  "两步都要真的执行。",
].join("\n");

await rpc("session/prompt", {
  request: { requestId: `hello-${Date.now()}`, sessionId, mode: "queue", content: [{ type: "text", text: task }] },
});
console.log("prompted; waiting for step 1…");
await sleep(9000);

await rpc("session/cancel", { request: { sessionId } });
console.log("cancelled; waiting for idle…");
await sleep(6000);

const aborted = (await readEvents(sessionId)).filter((event) => event.type === "turn/end" && event.data?.reason?.kind === "aborted");
ok("中断产生了 aborted 轮", aborted.length > 0, aborted.map((e) => e.data));
ok("停止时标记文件还不存在", existsSync(MARKER) === false, { exists: existsSync(MARKER) });

// 只发一句寒暄（不点续跑）
await rpc("session/prompt", {
  request: { requestId: `hello-greeting-${Date.now()}`, sessionId, mode: "queue", content: [{ type: "text", text: "你好" }] },
});
console.log("greeting sent; waiting for that turn to settle…");
await sleep(30000);

const events = await readEvents(sessionId);
const turns = events.filter((event) => event.type === "turn/start").map((event) => event.data.turn);
const greetingTurn = turns.at(-1);
const greetingUser = events.filter((event) => event.type === "user/message" && textOf(event.data?.content).trim() === "你好").at(-1);
ok("寒暄确实进了历史（人类消息）", greetingUser !== undefined, { turn: greetingTurn });

const greetingTurnEvents = events.filter((event) => event.type === "tool/call" && event.data?.turn === greetingTurn);
const WRITE_PATTERN = /WROTE\s*>>?|>>?\s*\S*regression\.txt|rm\s+\S*regression\.txt|mv\s+\S*regression\.txt|touch\s+\S*regression\.txt/;
const touching = greetingTurnEvents.filter((event) => WRITE_PATTERN.test(String(event.data?.arguments ?? "")));
const readOnly = greetingTurnEvents.filter((event) => String(event.data?.arguments ?? "").includes("regression.txt"));
console.log(`寒暄轮：工具调用 ${greetingTurnEvents.length} 个，涉及其路径 ${readOnly.length} 个（只读查看属于期望行为）`);
ok("寒暄那一轮没有再去执行旧待办（无写/删调用）", touching.length === 0, touching.map((e) => e.data));
ok("标记文件没有被创建", existsSync(MARKER) === false, { exists: existsSync(MARKER) });

const resumeInHistory = events.filter((event) => event.type === "user/message" && textOf(event.data?.content).startsWith("<resume id="));
console.log(`历史里 <resume> 条数：${resumeInHistory.length}（本次没有点续跑，应为 0）`);

const greetingAnswer = events
  .filter((event) => event.type === "assistant/message" && event.data?.turn === greetingTurn)
  .map((event) => textOf(event.data?.message?.content))
  .join("\n")
  .trim();
console.log(`--- 寒暄那一轮的回答（前 300 字）---\n${greetingAnswer.slice(0, 300) || "(无文本输出，只有工具调用/推理)"}\n---`);

const failed = report.filter((item) => !item.ok);
console.log(`\n${report.length - failed.length}/${report.length} passed  (session ${sessionId})`);
process.exit(failed.length === 0 ? 0 : 1);
