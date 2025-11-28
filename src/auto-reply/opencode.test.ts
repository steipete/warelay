import { describe, expect, it } from "vitest";

import { parseOpencodeJson, summarizeOpencodeMetadata } from "./opencode.js";

describe("opencode JSON parsing", () => {
  it("extracts text and metadata from a stream of events", () => {
    const stream = `
{ "type": "step_start", "timestamp": 1000, "sessionID": "ses_1" }
{ "type": "text", "timestamp": 1500, "sessionID": "ses_1", "part": { "type": "text", "text": "Hello " } }
{ "type": "text", "timestamp": 1600, "sessionID": "ses_1", "part": { "type": "text", "text": "world!" } }
{ "type": "step_finish", "timestamp": 2000, "sessionID": "ses_1", "part": { "cost": 0.002, "tokens": { "input": 100, "output": 20 } } }
`;
    const result = parseOpencodeJson(stream);
    expect(result.text).toBe("Hello world!");
    expect(result.valid).toBe(true);
    expect(result.parsed).toHaveLength(4);
    expect(result.meta).toEqual({
      durationMs: 1000,
      cost: 0.002,
      tokens: { input: 100, output: 20 },
    });
  });

  it("handles empty or invalid input", () => {
    expect(parseOpencodeJson("").valid).toBe(false);
    expect(parseOpencodeJson("not json").valid).toBe(false);
  });

  it("ignores non-text events", () => {
    const stream = `{ "type": "other", "part": { "text": "ignored" } } `;
    const result = parseOpencodeJson(stream);
    expect(result.text).toBeUndefined();
    expect(result.valid).toBe(false);
  });

  it("marks as valid if step_start is present even without text", () => {
    const stream = `{ "type": "step_start" } `;
    const result = parseOpencodeJson(stream);
    expect(result.valid).toBe(true);
    expect(result.text).toBeUndefined();
  });

  it("summarizes metadata correctly", () => {
    const meta = {
      durationMs: 1500,
      cost: 0.015,
      tokens: { input: 500, output: 100 },
    };
    expect(summarizeOpencodeMetadata(meta)).toBe(
      "duration=1500ms, cost=$0.0150, tokens=500+100",
    );
  });

  it("summarizes partial metadata", () => {
    expect(summarizeOpencodeMetadata({ durationMs: 100 })).toBe(
      "duration=100ms",
    );
    expect(summarizeOpencodeMetadata({})).toBeUndefined();
    expect(summarizeOpencodeMetadata(undefined)).toBeUndefined();
  });
});
