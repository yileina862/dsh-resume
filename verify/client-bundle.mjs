// dsh-resume Client 半侧验收（不需要浏览器）：把 client.js 当 __ModuleLoader__ bundle 载入，
// 用桩 require 拿导出，验证「什么时候把发送键变成续跑三角」的判定与样式契约。
//
// 用法：node plugins/dsh-resume/verify/client-bundle.mjs

import { readFileSync } from "node:fs";

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

// ── 桩：window.__ModuleLoader__ + require('react') ─────────────────────────
const loaded = new Map();
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useRef: (initial) => ({ current: initial }),
  useEffect: () => undefined,
  useCallback: (fn) => fn,
};
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      loaded.set(id, factory);
    },
  },
};
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
new Function("window", "MutationObserver", source)(globalThis.window, globalThis.MutationObserver);

eq("bundle id 已注册", [...loaded.keys()], ["dsh-resume"]);
const exportsOfBundle = loaded.get("dsh-resume")((request) => {
  if (request === "react") return reactStub;
  throw new Error(`unexpected require: ${request}`);
});

eq(
  "导出面",
  ["apply", "inject", "ResumeProbe", "shouldShowPlay", "selectPendingResume", "findPrimaryButton", "PLAY_ATTRIBUTE", "PLAY_CSS", "COMMAND_TEXT"].filter(
    (key) => exportsOfBundle[key] === undefined,
  ),
  [],
);
eq("client inject（cordis 服务）", exportsOfBundle.inject, ["slots", "sessions"]);
eq("命令文本", exportsOfBundle.COMMAND_TEXT, "/resume");

// ── 判定：三条同时成立才接管主键 ───────────────────────────────────────────
const { shouldShowPlay, selectPendingResume, PLAY_ATTRIBUTE, PLAY_CSS, apply, findPrimaryButton } = exportsOfBundle;

eq("有断点 + 空闲 + 空草稿 → 三角", shouldShowPlay({ available: true, running: false, draft: "", phase: "plain" }), true);
eq("无断点 → 原生发送键", shouldShowPlay({ available: false, running: false, draft: "", phase: "plain" }), false);
eq("运行中 → 原生（停止方块）", shouldShowPlay({ available: true, running: true, draft: "", phase: "plain" }), false);
eq("草稿有内容 → 原生发送", shouldShowPlay({ available: true, running: false, draft: "把日志贴出来", phase: "plain" }), false);
eq("草稿只有空白 → 仍算空", shouldShowPlay({ available: true, running: false, draft: "   \n ", phase: "plain" }), true);
eq("提交中 → 不接管", shouldShowPlay({ available: true, running: false, draft: "", phase: "submitting" }), false);
eq(
  "投影还没到达（undefined）→ 原生",
  shouldShowPlay({ available: undefined, running: false, draft: "", phase: "plain" }),
  false,
);

// ── inbox 投影 → 是否有排队中的 <resume> ───────────────────────────────────
const resumeMsg = { id: "m1", source: { kind: "resume", transport: "command" } };
const humanMsg = { id: "m2", source: { kind: "user" } };
eq("inbox 无值 → 不算排队", selectPendingResume(undefined), false);
eq("inbox 空 → 不算排队", selectPendingResume({ "next-turn": [], "next-step": [] }), false);
eq("next-turn 里有 resume → 排队", selectPendingResume({ "next-turn": [humanMsg, resumeMsg], "next-step": [] }), true);
eq("next-step 里有 resume → 排队", selectPendingResume({ "next-turn": [], "next-step": [resumeMsg] }), true);
eq("只有人类消息 → 不算排队", selectPendingResume({ "next-turn": [humanMsg], "next-step": [] }), false);
eq("畸形值不炸", selectPendingResume({ "next-turn": "nope" }), false);

// ── 样式契约：藏原生图标 + 空心三角（fill:none，有描边）─────────────────────
ok("样式挂在标记属性上", PLAY_CSS.includes(`[${PLAY_ATTRIBUTE}="true"]`), PLAY_CSS);
ok("原生 svg 被隐藏", /\[data-dsh-resume-play="true"\] > svg \{ display: none !important; \}/.test(PLAY_CSS), PLAY_CSS);
ok("三角是空心的（fill='none' + stroke）", PLAY_CSS.includes("fill%3D'none'") && PLAY_CSS.includes("stroke%3D'white'"), PLAY_CSS);
ok("不使用文字内容（不写「继续」二字）", !PLAY_CSS.includes("继续"), PLAY_CSS);

// ── 主键定位：优先 class 含 primary 的按钮 ─────────────────────────────────
const fakeButton = (className, hasSvg) => ({
  className,
  disabled: false,
  attrs: new Map(),
  querySelector: () => (hasSvg ? {} : null),
  classList: { contains: () => false },
});
const primary = fakeButton("InputBar_module__primary___abc", true);
const other = fakeButton("toolbar-button", true);
const card = { querySelectorAll: () => [other, primary] };
eq("优先找 primary 按钮", findPrimaryButton(card) === primary, true);
eq(
  "退化：class 不含 primary 时取最后一个带 svg 的按钮",
  findPrimaryButton({ querySelectorAll: () => [other, primary] }) !== undefined,
  true,
);

// ── apply：注册进 conversation.input.right，并给出 running / 断点两个钩子 ──
const registered = [];
const face = { getSnapshot: () => undefined, subscribe: () => () => {} };
const sessions = {
  binding: () => ({ session: { projections: { faceOf: (key) => ({ key, ...face }) } } }),
};
const ctx = {
  get: (name) => (name === "sessions" ? sessions : undefined),
  slots: {
    inject: (name, callback) => {
      registered.push({ inject: name });
      callback();
    },
    register: (options, component) => {
      registered.push({ options, component });
      return () => {};
    },
  },
};
apply(ctx);

const injectCall = registered.find((entry) => entry.inject !== undefined);
const registerCall = registered.find((entry) => entry.options !== undefined);
eq("挂在 conversation.input.right", injectCall?.inject, "conversation.input.right");
eq("列表项 id", registerCall?.options.id, "resume");
eq("组件是探针", registerCall?.component === exportsOfBundle.ResumeProbe, true);

const face64 = registerCall.options.inject("session-x");
eq("注入的钩子名", Object.keys(face64.hooks), ["running", "resumeBreakpoint", "inbox"]);
eq("断点钩子读同一个投影键", face64.hooks.resumeBreakpoint.key, "resumeBreakpoint");
eq("inbox 钩子读官方 inbox 投影", face64.hooks.inbox.key, "inbox");

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
