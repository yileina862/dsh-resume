// dsh-resume —— 中断后续跑（Client 半侧）。
//
// 形态：dsh 的客户端插件 bundle 是预构建的 __ModuleLoader__ 包装（与
// @deepseek-ai/dsh-client-ui-* 的 lib/client.js 同形），由 /plugins 运行时下发，
// 不需要 Vite 重新构建。
//
// 交互（不新增任何按钮）：接管 composer 的**主发送键**。
//   - 有断点、agent 空闲、草稿为空 → 主键显示为空心右三角（▶），点一下即续跑；
//   - 草稿里有内容 → 保持原生发送箭头，点一下正常发送；
//   - agent 运行中（草稿为空）→ 保持原生停止方块，点一下正常停止。
// 「有没有断点」由 Host 的会话投影 `resumeBreakpoint` 决定（日志派生），
// 客户端不猜：断点一被消费，三角立刻回到发送键。
//
// 续跑动作走 Host 的 `/resume` 命令；命令裁定不可用时，'/resume' 会作为普通文本入队，
// 由 Host 在步骤进入前替换成 <resume> 模板（裸文本不进历史）。

window.__ModuleLoader__.load({
  id: "dsh-resume",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");

    /** 主键被改成续跑键时挂的标记属性。 */
    const PLAY_ATTRIBUTE = "data-dsh-resume-play";
    /** 主路径命令文本（Host 注册的 resume 命令）。 */
    const COMMAND_TEXT = "/resume";
    /** 主键在续跑态的无障碍标签。 */
    const PLAY_LABEL = "继续（从断点续跑）";
    /** 断点原因 → 悬停说明（宿主投影的 cause）。 */
    const PLAY_TITLE = {
      "user-interrupted": "从断点继续：接着做完中断前的工作",
      "host-restart": "宿主重启前的活没做完：接着做完",
    };

    /** 空心右三角：16×16 视窗居中，描边 currentColor 的白色版（主键背景是青绿圆）。 */
    const PLAY_ICON = encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' width='16' height='16'>" +
        "<path d='M6 4.2 L12 8 L6 11.8 Z' fill='none' stroke='white' stroke-width='1.6' stroke-linejoin='round' stroke-linecap='round'/>" +
        "</svg>",
    );

    /** 只注入一次的样式：藏掉原生箭头/方块，换成空心三角，保持圆形主键几何不变。 */
    const PLAY_CSS =
      `[${PLAY_ATTRIBUTE}="true"] > svg { display: none !important; }\n` +
      `[${PLAY_ATTRIBUTE}="true"] { position: relative; background-image: url("data:image/svg+xml,${PLAY_ICON}"); ` +
      `background-repeat: no-repeat; background-position: center; background-size: 16px 16px; }\n` +
      `[${PLAY_ATTRIBUTE}="true"]:disabled { cursor: pointer; opacity: 1; }\n`;

    /** 样式标签的一次性注入点。 */
    const STYLE_ID = "dsh-resume-play-style";

    /**
     * 主键该不该显示成续跑三角。
     * 三条都得成立：宿主说有断点、agent 不忙、草稿为空（有字就还原成发送键）。
     * @param input - {available, running, draft, phase, pending}
     * @returns whether to take over the primary submit button.
     */
    function shouldShowPlay(input) {
      if (input === null || typeof input !== "object") return false;
      if (input.available !== true) return false;
      if (input.running === true) return false;
      if (input.phase !== undefined && input.phase !== "plain") return false;
      // 续跑已经排队（inbox 里有 source.kind==='resume' 的条目）→ 立刻还原，不给人第二次可点的错觉。
      if (input.pending === true) return false;
      const draft = typeof input.draft === "string" ? input.draft : "";
      return draft.trim() === "";
    }

    /**
     * 在 composer 卡片里找主发送键：优先 class 含 primary 的按钮，退化为最后一个带 svg 的按钮。
     * @param card - `[data-composer-card]` 元素。
     * @returns the primary button, or undefined.
     */
    function findPrimaryButton(card) {
      if (card === null || card === undefined || typeof card.querySelectorAll !== "function") return undefined;
      const buttons = [...card.querySelectorAll("button")];
      const primary = buttons.find((button) => /primary/i.test(String(button.className ?? "")));
      if (primary !== undefined) return primary;
      return buttons.filter((button) => button.querySelector("svg") !== null).at(-1);
    }

    /** 注入一次样式（幂等：已有同 id 的 style 就不重复加）。 */
    function ensureStyle(doc) {
      if (doc === null || doc === undefined) return;
      if (doc.getElementById(STYLE_ID) !== null) return;
      const style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = PLAY_CSS;
      doc.head.append(style);
    }

    /** 去掉续跑态，把主键还给原生发送（连 aria-label 一起还原）。 */
    function releaseButton(button) {
      if (button === null || button === undefined) return;
      button.removeAttribute(PLAY_ATTRIBUTE);
      button.removeAttribute("title");
      const originalLabel = button.getAttribute("data-dsh-resume-label");
      if (originalLabel !== null) {
        button.setAttribute("aria-label", originalLabel);
        button.removeAttribute("data-dsh-resume-label");
      }
    }

    /**
     * 探针组件：本身不可见，只负责把 composer 主键接管/还原。
     * 挂在 `conversation.input.right`（在同一张 composer 卡片里，能 closest 到卡片）。
     * @param props - Session 标准 props + 注入的 running / resumeBreakpoint 钩子。
     * @returns a hidden marker element.
     */
    function ResumeProbe(props) {
      const marker = react.useRef(null);
      const actions = props?.inputActions;
      const useInput = props?.useInput;
      const useRunning = props?.useRunning;
      const useResumeBreakpoint = props?.useResumeBreakpoint;
      const useInbox = props?.useInbox;

      const draft = typeof useInput === "function" ? useInput(selectDraft) : "";
      const phase = typeof useInput === "function" ? useInput(selectPhase) : "plain";
      const running = typeof useRunning === "function" ? useRunning(selectRunning) === true : false;
      const available =
        typeof useResumeBreakpoint === "function" ? useResumeBreakpoint(selectAvailable) === true : false;
      const cause = typeof useResumeBreakpoint === "function" ? useResumeBreakpoint(selectCause) : null;
      const pending = typeof useInbox === "function" ? useInbox(selectPendingResume) === true : false;

      const play = shouldShowPlay({ available, running, draft, phase, pending });

      react.useEffect(() => {
        const markerNode = marker.current;
        const card = markerNode === null ? null : markers(markerNode);
        const button = findPrimaryButton(card);
        if (button === null || button === undefined) return undefined;
        if (!play) {
          releaseButton(button);
          return undefined;
        }

        ensureStyle(markerNode.ownerDocument);
        if (!button.hasAttribute("data-dsh-resume-label")) {
          button.setAttribute("data-dsh-resume-label", button.getAttribute("aria-label") ?? "");
        }
        button.setAttribute(PLAY_ATTRIBUTE, "true");
        button.setAttribute("title", PLAY_TITLE[cause] ?? "从断点继续：接着做完中断前的工作");
        // 空草稿时原生主键是 disabled；接管后必须可点。
        button.disabled = false;
        button.setAttribute("aria-disabled", "false");
        button.setAttribute("aria-label", PLAY_LABEL);

        /** 捕获阶段先吃掉这次点击，React 的 onClick 不再参与。 */
        const onClick = (event) => {
          event.preventDefault();
          event.stopPropagation();
          releaseButton(button);
          if (actions === undefined) return;
          try {
            actions.setDraft(COMMAND_TEXT);
            actions.submit();
          } catch (error) {
            console.warn("[dsh-resume] could not submit the resume draft:", error);
          }
        };
        button.addEventListener("click", onClick, true);

        // React 每次重渲染都会把空草稿的 disabled 写回来；观察并保持可点。
        const observer = new MutationObserver(() => {
          if (button.disabled) button.disabled = false;
        });
        observer.observe(button, { attributes: true, attributeFilter: ["disabled"] });

        return () => {
          observer.disconnect();
          button.removeEventListener("click", onClick, true);
          releaseButton(button);
        };
      }, [play, actions, cause]);

      return react.createElement("span", {
        ref: marker,
        "data-dsh-resume-probe": "",
        "aria-hidden": "true",
        style: { display: "none" },
      });
    }

    /** closest 的薄封装：只在有 closest 时用。 */
    function markers(node) {
      return typeof node.closest === "function" ? node.closest("[data-composer-card]") : null;
    }

    const selectDraft = (state) => state.draft;
    const selectPhase = (state) => state.phase;
    const selectRunning = (state) => state.running === true;
    const selectAvailable = (state) => (state === null || state === undefined ? false : state.available === true);
    /** 断点原因（user-interrupted / host-restart），只用于悬停文案。 */
    const selectCause = (state) => (state === null || state === undefined ? null : (state.cause ?? null));

    /**
     * inbox 投影里是否已经排着一条 <resume>（官方 `inbox` 投影：{"next-turn":[...],"next-step":[...]}）。
     * @param state - inbox 投影值。
     * @returns whether a resume message is pending.
     */
    const selectPendingResume = (state) => {
      if (state === null || state === undefined) return false;
      for (const key of ["next-turn", "next-step"]) {
        const list = state[key];
        if (!Array.isArray(list)) continue;
        for (const message of list) {
          if (message?.source?.kind === "resume") return true;
        }
      }
      return false;
    };

    const inject = ["slots", "sessions"];

    /**
     * Client 插件体：只挂一个不可见探针，接管主发送键。
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.slots.inject("conversation.input.right", () =>
        ctx.slots.register(
          {
            name: "conversation.input.right",
            id: "resume",
            order: 80,
            registrant: "dsh-resume",
            inject: (sessionId) => {
              const sessions = ctx.get("sessions");
              const binding = sessions?.binding?.(sessionId);
              if (binding === undefined) throw new Error(`dsh-resume: session "${sessionId}" is unavailable`);
              const projections = binding.session.projections;
              return {
                hooks: {
                  /** 当前会话是否在跑（SessionFace 是 ObservableSnapshot）。 */
                  running: binding.session,
                  /** Host 日志派生的断点可见性。 */
                  resumeBreakpoint: projections.faceOf("resumeBreakpoint"),
                  /** 官方 inbox 投影：续跑是否已经在排队。 */
                  inbox: projections.faceOf("inbox"),
                },
              };
            },
          },
          ResumeProbe,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.ResumeProbe = ResumeProbe;
    exports.shouldShowPlay = shouldShowPlay;
    exports.selectPendingResume = selectPendingResume;
    exports.findPrimaryButton = findPrimaryButton;
    exports.PLAY_ATTRIBUTE = PLAY_ATTRIBUTE;
    exports.PLAY_CSS = PLAY_CSS;
    exports.COMMAND_TEXT = COMMAND_TEXT;
    return module.exports;
  },
});
