// Helpers specific to Opencode CLI output/argv handling.

// Preferred binary name for Opencode CLI invocations.
export const OPENCODE_BIN = "opencode";

export const OPENCODE_IDENTITY_PREFIX =
  "You are Openclawd running on the user's Mac via warelay. Your scratchpad is /Users/sidhaarthkrishnan/openclawd; this is your folder and you can add what you like in markdown files and/or images. You don't need to be concise, but WhatsApp replies must stay under ~1500 characters. Media you can send: images ≤6MB, audio/video ≤16MB, documents ≤100MB. The prompt may include a media path and an optional Transcript: section—use them when present. If a prompt is a heartbeat poll and nothing needs attention, reply with exactly HEARTBEAT_OK and nothing else; for any alert, do not include HEARTBEAT_OK.";

export type OpencodeJsonParseResult = {
  text?: string;
  parsed: unknown[];
  valid: boolean;
  meta?: {
    durationMs?: number;
    cost?: number;
    tokens?: {
      input?: number;
      output?: number;
    };
  };
};

export function parseOpencodeJson(raw: string): OpencodeJsonParseResult {
  const lines = raw.split(/\n+/).filter((s) => s.trim());
  const parsed: unknown[] = [];
  let text = "";
  let valid = false;
  let startTime: number | undefined;
  let endTime: number | undefined;
  let cost = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      parsed.push(event);
      if (event && typeof event === "object") {
        // Opencode emits a stream of events.
        if (event.type === "step_start") {
          valid = true;
          if (typeof event.timestamp === "number") {
            if (startTime === undefined || event.timestamp < startTime) {
              startTime = event.timestamp;
            }
          }
        }

        if (event.type === "text" && event.part?.text) {
          text += event.part.text;
          valid = true;
        }

        if (event.type === "step_finish") {
          valid = true;
          if (typeof event.timestamp === "number") {
            endTime = event.timestamp;
          }
          if (event.part) {
            if (typeof event.part.cost === "number") {
              cost += event.part.cost;
            }
            if (event.part.tokens) {
              inputTokens += event.part.tokens.input || 0;
              outputTokens += event.part.tokens.output || 0;
            }
          }
        }
      }
    } catch {
      // ignore non-JSON lines
    }
  }

  const meta: OpencodeJsonParseResult["meta"] = {};
  if (startTime !== undefined && endTime !== undefined) {
    meta.durationMs = endTime - startTime;
  }
  if (cost > 0) meta.cost = cost;
  if (inputTokens > 0 || outputTokens > 0) {
    meta.tokens = { input: inputTokens, output: outputTokens };
  }

  return {
    text: text || undefined,
    parsed,
    valid: valid && parsed.length > 0,
    meta: Object.keys(meta).length > 0 ? meta : undefined,
  };
}

export function summarizeOpencodeMetadata(
  meta: OpencodeJsonParseResult["meta"],
): string | undefined {
  if (!meta) return undefined;
  const parts: string[] = [];
  if (meta.durationMs !== undefined)
    parts.push(`duration=${meta.durationMs}ms`);
  if (meta.cost !== undefined) parts.push(`cost=$${meta.cost.toFixed(4)}`);
  if (meta.tokens) {
    parts.push(`tokens=${meta.tokens.input}+${meta.tokens.output}`);
  }
  return parts.length ? parts.join(", ") : undefined;
}
