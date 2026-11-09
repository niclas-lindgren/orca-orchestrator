import { describe, expect, it } from "vitest";
import { main, parseArgs } from "../src/orca/cli.mjs";
import {
  composerDraftText,
  reviewProjectUrl,
  isReviewProjectUrl,
  reviewDelete,
  reviewOpen,
  reviewRead,
  reviewSend,
  reviewWait,
} from "../src/orca/review-browser.mjs";

const PAGE = "page-1";
const PROJECT = "https://chatgpt.com/g/g-p-6a3f627992648191a41d0b2097584655/project";
const CHAT = PROJECT.replace(/project$/, "c/abc-123");
const CHAT_PATH = CHAT.replace(/^https?:\/\/[^/]+/, "");

type State = {
  url: string;
  active: boolean;
  draft: string;
  replies: string[];
  composer: string;
  sentUrl: string;
  blocked: boolean;
  inflateBlankLines?: boolean;
};

function fakeOrca(over: Partial<State> = {}) {
  const state: State = {
    url: PROJECT,
    active: true,
    draft: "",
    replies: [""],
    composer: "Ask ChatGPT",
    sentUrl: CHAT,
    blocked: false,
    ...over,
  };
  const calls: string[] = [];
  const orcaCwds = new Set<string>();
  const ok = (result: unknown) => ({
    status: 0,
    stderr: "",
    stdout: JSON.stringify({ ok: true, result }),
  });
  const exec = (c: string, args: string[], cwd = "") => {
    if (c === "git") return { status: 0, stderr: "", stdout: "/repo/.git\n" };
    orcaCwds.add(cwd);
    const a = args.filter((x) => x !== "--json");
    calls.push(a.join(" "));
    const [cmd, sub] = a;
    if (cmd === "tab" && sub === "create") return ok({ browserPageId: PAGE });
    if (cmd === "tab" && sub === "switch") return ok({ switched: 1 });
    if (cmd === "tab" && sub === "list")
      return ok({
        tabs: [{ browserPageId: PAGE, url: state.url, active: state.active }],
      });
    if (cmd === "snapshot")
      return ok({
        origin: state.url,
        refs: {
          e1: { role: "textbox", name: state.composer },
          e2: { role: "button", name: "Send" },
        },
      });
    if (cmd === "fill") {
      state.draft = a[a.indexOf("--value") + 1];
      return ok({ filled: "e1" });
    }
    if (cmd === "click") {
      state.url = state.sentUrl;
      return ok({ clicked: "e2" });
    }
    if (cmd === "eval") {
      const expr = a[a.indexOf("--expression") + 1];
      return ok({
        result: expr.includes("ChatGPT said")
          ? JSON.stringify({
              reply:
                state.replies.length > 1
                  ? state.replies.shift()
                  : state.replies[0],
              blocked: state.blocked,
            })
          : state.inflateBlankLines
            ? state.draft.replace(/\n\n/g, "\n\n\n\n\n")
            : state.draft,
      });
    }
    return { status: 1, stdout: "", stderr: "unexpected " + a.join(" ") };
  };
  return { exec, calls, state, orcaCwds };
}

describe("orca review browser", () => {
  it("accepts only chatgpt.com campsty project URLs", () => {
    expect(isReviewProjectUrl(PROJECT)).toBe(true);
    expect(isReviewProjectUrl("https://chatgpt.com/c/abc")).toBe(false);
    expect(isReviewProjectUrl("https://evil.example/g/g-p-6a3f627992648191a41d0b2097584655/c/abc")).toBe(false);
    expect(isReviewProjectUrl(PROJECT, { conversation: true })).toBe(false);
    expect(isReviewProjectUrl(CHAT, { conversation: true })).toBe(true);
  });

  it("review-open returns the page when project, login and composer are ready", () => {
    const f = fakeOrca();
    expect(reviewOpen({ repoRoot: ".", exec: f.exec })).toMatchObject({
      ok: true,
      pageId: PAGE,
    });
    expect(f.calls[0]).toContain(PROJECT);
  });

  it.each([
    ["wrong project", { url: "https://chatgpt.com/c/abc" }, "WRONG_PROJECT"],
    ["inactive page", { active: false }, "PAGE_NOT_ACTIVE"],
    ["missing composer", { composer: "Something else" }, "COMPOSER_MISSING"],
  ])("review-open fails closed: %s", (_n, over, code) => {
    expect(
      reviewOpen({
        repoRoot: ".",
        exec: fakeOrca(over).exec,
        sleep: () => {},
        attempts: 2,
      }),
    ).toMatchObject({ ok: false, code });
  });

  it("runs orca from the main checkout, not the issue worktree", () => {
    const f = fakeOrca();
    reviewOpen({ repoRoot: "/repo/.worktrees/issue-1", exec: f.exec });
    expect([...f.orcaCwds]).toEqual(["/repo"]);
  });

  it("review-send fills, verifies the draft, clicks Send and requires a project chat URL", () => {
    const f = fakeOrca();
    const r = reviewSend({
      repoRoot: ".",
      exec: f.exec,
      pageId: PAGE,
      message: "review PR #1",
    });
    expect(r).toMatchObject({ ok: true, url: CHAT });
    expect(f.calls.some((c) => c.startsWith("click"))).toBe(true);
  });

  it("review-send accepts multi-paragraph messages that the composer renders with extra blank lines", () => {
    const f = fakeOrca({ inflateBlankLines: true });
    const r = reviewSend({
      repoRoot: ".",
      exec: f.exec,
      pageId: PAGE,
      message: "first paragraph\n\nsecond paragraph",
    });
    expect(r).toMatchObject({ ok: true, url: CHAT });
    const g = fakeOrca({ inflateBlankLines: true });
    expect(
      reviewSend({
        repoRoot: ".",
        exec: g.exec,
        pageId: PAGE,
        message: "a\n\nb",
      }),
    ).toMatchObject({ ok: true });
  });

  it("extracts meaningful text from ProseMirror structure without layout artifacts", () => {
    type DraftNode = {
      nodeType: number;
      nodeName: string;
      nodeValue?: string;
      childNodes: DraftNode[];
      children?: DraftNode[];
      matches?: (selector: string) => boolean;
    };
    const text = (value: string): DraftNode => ({
      nodeType: 3,
      nodeName: "#text",
      nodeValue: value,
      childNodes: [],
    });
    const element = (
      nodeName: string,
      childNodes: DraftNode[],
      empty = false,
    ): DraftNode => ({
      nodeType: 1,
      nodeName,
      childNodes,
      children: childNodes.filter((node) => node.nodeType === 1),
      matches: (selector) =>
        empty && selector === "[data-empty-paragraph=true]",
    });
    const url = "https://github.com/niclas-lindgren/camping-booking/pull/1147";
    const root = {
      children: [
        element("P", [
          text("Review "),
          element("SPAN", [text(url)]),
          text(" now"),
        ]),
        element("P", [element("BR", [])], true),
        element("P", [text("Line one"), element("BR", []), text("Line two")]),
      ],
    };
    expect(composerDraftText(root)).toBe(
      `Review ${url} now\n\nLine one\nLine two`,
    );
  });

  it("review-send still rejects a draft whose words differ", () => {
    const f = fakeOrca();
    const exec = (c: string, args: string[], cwd = "") =>
      args.includes("fill")
        ? f.exec(
            c,
            args.map((x) => (x === "a b" ? "a c" : x)),
            cwd,
          )
        : f.exec(c, args, cwd);
    expect(
      reviewSend({ repoRoot: ".", exec, pageId: PAGE, message: "a b" }),
    ).toMatchObject({ ok: false, code: "DRAFT_MISMATCH" });
  });

  it("review-send rejects a draft that loses a meaningful line break", () => {
    const f = fakeOrca();
    const message = "- Approve\n- Do not merge";
    const exec = (c: string, args: string[], cwd = "") =>
      args.includes("fill")
        ? f.exec(
            c,
            args.map((x) => (x === message ? "- Approve - Do not merge" : x)),
            cwd,
          )
        : f.exec(c, args, cwd);
    expect(
      reviewSend({ repoRoot: ".", exec, pageId: PAGE, message }),
    ).toMatchObject({ ok: false, code: "DRAFT_MISMATCH" });
  });

  it("review-send never clicks when the chat leaves the project", () => {
    const f = fakeOrca({ sentUrl: "https://chatgpt.com/c/abc" });
    expect(
      reviewSend({ repoRoot: ".", exec: f.exec, pageId: PAGE, message: "m" }),
    ).toMatchObject({ ok: false, code: "NOT_A_PROJECT_CHAT" });
    const g = fakeOrca({ url: "https://chatgpt.com/c/abc" });
    expect(
      reviewSend({ repoRoot: ".", exec: g.exec, pageId: PAGE, message: "m" }),
    ).toMatchObject({ ok: false, code: "WRONG_PROJECT" });
    expect(
      g.calls.some((c) => c.startsWith("fill") || c.startsWith("click")),
    ).toBe(false);
  });

  it("review-read reports completeness from the disclaimer", () => {
    const done = fakeOrca({
      url: CHAT,
      replies: ["ChatGPT said:\nLGTM\nChatGPT can make mistakes"],
    });
    expect(
      reviewRead({ repoRoot: ".", exec: done.exec, pageId: PAGE }),
    ).toMatchObject({ ok: true, complete: true });
    const partial = fakeOrca({
      url: CHAT,
      replies: ["ChatGPT said:\nWorking for 3s"],
    });
    expect(
      reviewRead({ repoRoot: ".", exec: partial.exec, pageId: PAGE }),
    ).toMatchObject({ ok: true, complete: false });
  });

  it("review-read treats trailing page UI text after the disclaimer as a complete reply", () => {
    const f = fakeOrca({
      url: CHAT,
      replies: [
        "ChatGPT said:\nNo blocking findings.\nChatGPT can make mistakes. Check important info.\nLatest response\n\nThinking effort\nMedium",
      ],
    });
    const r = reviewRead({ repoRoot: ".", exec: f.exec, pageId: PAGE }) as {
      text: string;
    };
    expect(r).toMatchObject({ ok: true, complete: true });
    expect(r.text.endsWith("ChatGPT can make mistakes")).toBe(true);
    expect(r.text).not.toContain("Thinking effort");
  });

  it("review-read fails fast on a Cloudflare challenge and accepts temporary chat ids", () => {
    const f = fakeOrca({ url: CHAT, blocked: true });
    expect(
      reviewRead({ repoRoot: ".", exec: f.exec, pageId: PAGE }),
    ).toMatchObject({ ok: false, code: "BROWSER_CHALLENGE" });
    expect(
      isReviewProjectUrl(PROJECT.replace(/project$/, "c/local-chatgpt%3A24c7-f"), {
        conversation: true,
      }),
    ).toBe(true);
  });

  it("review-wait needs two identical complete reads and times out otherwise", () => {
    const full = "ChatGPT said:\nLGTM\nChatGPT can make mistakes";
    const f = fakeOrca({
      url: CHAT,
      replies: ["", "ChatGPT said:\nWorking", full],
    });
    let t = 0;
    const opts = {
      repoRoot: ".",
      pageId: PAGE,
      intervalMs: 1,
      timeoutMs: 100,
      sleep: () => {
        t += 1;
      },
      now: () => t,
    };
    expect(reviewWait({ ...opts, exec: f.exec })).toMatchObject({
      ok: true,
      complete: true,
      text: full,
    });
    const never = fakeOrca({ url: CHAT, replies: [""] });
    t = 0;
    expect(reviewWait({ ...opts, exec: never.exec })).toMatchObject({
      ok: false,
      code: "REPLY_TIMEOUT",
    });
  });

  it("parses and routes the CLI commands", () => {
    expect(parseArgs(["review-open"])).toEqual({ command: "review-open" });
    expect(parseArgs(["review-send", "--page", "p"])).toMatchObject({
      error: expect.stringContaining("--message-file"),
    });
    expect(parseArgs(["review-wait", "--page", "p"])).toMatchObject({
      command: "review-wait",
      pageId: "p",
    });
    const f = fakeOrca();
    expect(
      main(["review-open"], { repoRoot: ".", exec: f.exec }),
    ).toMatchObject({ code: 0, result: { ok: true } });
  });
});
