// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { FIRST_MESSAGE_JS } from "../src/orca/review-browser.mjs";

// jsdom does not implement innerText; textContent is equivalent for these fixtures.
Object.defineProperty(HTMLElement.prototype, "innerText", {
  configurable: true,
  get() {
    return this.textContent ?? "";
  },
});

const run = () => JSON.parse(String(window.eval(FIRST_MESSAGE_JS)));

describe("FIRST_MESSAGE_JS against ChatGPT DOM shapes (#1170)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("reads the user bubble when author-role metadata is missing", () => {
    document.body.innerHTML = `<main>
      <div data-user-message-bubble="true"><div class="whitespace-pre-wrap">ping</div></div>
      <div class="whitespace-pre-wrap">assistant reply</div></main>`;
    expect(run()).toEqual({ text: "ping", fallback: false });
  });

  it("prefers the author-role user message", () => {
    document.body.innerHTML = `<main>
      <div data-message-author-role="user"><div class="whitespace-pre-wrap">ping</div></div></main>`;
    expect(run()).toEqual({ text: "ping", fallback: false });
  });

  it("does not trust an assistant text node that precedes the user message", () => {
    document.body.innerHTML = `<main>
      <div class="whitespace-pre-wrap">assistant text</div>
      <div data-user-message-bubble="true"><div class="whitespace-pre-wrap">ping</div></div></main>`;
    expect(run().text).toBe("ping");
  });

  it("does not use a bare text node when no user container exists", () => {
    document.body.innerHTML = `<main><div class="whitespace-pre-wrap">assistant text</div></main>`;
    expect(run()).toEqual({ text: "", fallback: true });
  });
});
