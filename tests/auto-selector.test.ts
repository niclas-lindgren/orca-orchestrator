import { describe, expect, it } from "vitest";

import { invalidIssue } from "../src/auto/selector.mjs";

const complete = {
  number: 7,
  state: "OPEN",
  title: "t",
  body: "b",
  labels: [],
  comments: [{ id: "c1", body: "hi" }],
};

describe("campsty-auto issue reads", () => {
  it("accepts a complete issue payload", () => {
    expect(invalidIssue(complete, 7)).toBeNull();
  });

  it("rejects a payload that lacks what the scope comparison needs", () => {
    expect(invalidIssue(null, 7)).toBe("not an object");
    expect(invalidIssue({ ...complete, number: 8 }, 7)).toBe("wrong issue number");
    expect(invalidIssue({ ...complete, state: undefined }, 7)).toBe("missing state");
    expect(invalidIssue({ ...complete, body: undefined }, 7)).toBe("missing title or body");
    expect(invalidIssue({ ...complete, comments: undefined }, 7)).toBe("missing comments");
    expect(invalidIssue({ ...complete, comments: [{ id: 1, body: "x" }] }, 7)).toBe("malformed comment");
  });
});
