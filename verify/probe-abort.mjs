// 实证：点「停止」时，正在跑的工具调用会不会停；后台 job 会不会停。
//
// 用法：node plugins/dsh-resume/verify/probe-abort.mjs <cookie>
//
// A 前台：bash `sleep 25; echo survived > /tmp/dsh-probe-fg.txt`
//   → 6s 后 cancel，立刻看进程是否还在、tool/result 的 error.code、25s 后文件是否出现
// B 后台：bash run_in_background `sleep 20; echo bg > /tmp/dsh-probe-bg.txt`
//   → 5s 后 cancel，20s 后看文件是否出现（出现 = 后台任务不受停止影响）

import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";

const BASE = process.env.DSH_WEB_URL ?? "http://127.0.0.1:3080";
const cookie = process.argv[2];
if (cookie === undefined) {
  console.error("usage: node probe-abort.mjs <cookie>");
  process.exit(2);
}

let seq = 0;
async function rpc(method, payload) {
  seq += 1;
  const response = await fetch(`${BASE}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ type: "client-request", rpcId: `pa-${seq}`, method, payload: { args: payload } }),
  });
  const body = await response.json();
  if (body?.result?.ok !== true) {
    const error = new Error(`${method}: ${JSON.stringify(body?.result?.error)}`);
    error.remote = body?.result?.error;
    throw error;
  }
  return body.result.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function events(sessionId) {
  let through = Number.MAX_SAFE_INTEGER;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const page = await rpc("session/page", { request: { address: { kind: "session", sessionId }, throughSeq: through, maxMessages: 500 } });
      const out = [];
      const walk = (value) => {
        if (value === null || typeof value !== "object") return;
        if (Array.isArray(value)) return value.forEach(walk);
        if (value.type === "event" && typeof value.event?.type === "string") return out.push(value.event);
        Object.values(value).forEach(walk);
      };
      walk(page);
      const merged = new Map();
      for (const event of out) merged.set(`${event.type}#${event.seq}`, event);
      return [...merged.values()].sort((a, b) => a.seq - b.seq);
    } catch (error) {
      const match = /past cursor (\d+)/.exec(error?.remote?.message ?? error.message);
      if (match === null) throw error;
      through = Number(match[1]);
    }
  }
  throw new Error("page read failed");
}

const alive = (needle) => {
  const out = execSync("ps -eo pid,cmd", { encoding: "utf8" });
  return out.split("\n").filter((line) => line.includes(needle) && !line.includes("ps -eo") && !line.includes("node "));
};

async function runProbe({ label, prompt, cancelAfterMs, settleMs, file, needle }) {
  try {
    rmSync(file, { force: true });
  } catch {}
  const created = await rpc("session/create", { request: { cwd: "/tmp/dsh-resume-e2e" } });
  const sessionId = created.sessionId;
  await rpc("session/prompt", {
    request: { requestId: `pa-${label}-${Date.now()}`, sessionId, mode: "queue", content: [{ type: "text", text: prompt }] },
  });
  await sleep(cancelAfterMs);

  const beforeCancel = await events(sessionId);
  const calls = beforeCancel.filter((event) => event.type === "tool/call");
  await rpc("session/cancel", { request: { sessionId } });
  const justAfter = alive(needle);
  await sleep(1200);
  const afterCancel = await events(sessionId);
  const results = afterCancel.filter((event) => event.type === "tool/result");
  const abortedCode = results.map((event) => event.data?.error?.code).filter(Boolean);
  const abortedText = results
    .map((event) => (Array.isArray(event.data?.message?.content) ? event.data.message.content.map((b) => b.text).join("") : ""))
    .join(" | ")
    .slice(0, 120);

  await sleep(settleMs);
  const fileExists = existsSync(file);
  const stillAlive = alive(needle);
  console.log(
    JSON.stringify(
      {
        label,
        sessionId,
        toolCallsBeforeCancel: calls.map((event) => event.data?.name),
        abortedResultCodes: abortedCode,
        abortedResultText: abortedText,
        processAliveRightAfterCancel: justAfter.length,
        processAliveLater: stillAlive.length,
        fileAfterSettle: fileExists,
        fileContent: fileExists ? readFileSync(file, "utf8").trim() : null,
      },
      null,
      1,
    ),
  );
  return sessionId;
}

await runProbe({
  label: "A-foreground",
  prompt: "只做一件事：调用 bash 工具执行 `sleep 25; echo survived > /tmp/dsh-probe-fg.txt`。不要解释，不要用别的工具。",
  cancelAfterMs: 7000,
  settleMs: 24000,
  file: "/tmp/dsh-probe-fg.txt",
  needle: "sleep 25; echo survived",
});

await runProbe({
  label: "B-background",
  prompt:
    "只做一件事：调用 bash 工具，参数 run_in_background 设为 true，command 为 `sleep 18; echo bg-survived > /tmp/dsh-probe-bg.txt`。不要解释，不要用别的工具。",
  cancelAfterMs: 6000,
  settleMs: 20000,
  file: "/tmp/dsh-probe-bg.txt",
  needle: "sleep 18; echo bg-survived",
});
