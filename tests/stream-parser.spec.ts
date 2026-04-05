import { describe, expect, it } from "vitest";
import { createStreamJsonParser } from "../src/stream-parser.js";
import type { ChatStreamEvent } from "../src/types.js";

function collect(lines: string[]): ChatStreamEvent[] {
  const events: ChatStreamEvent[] = [];
  const parser = createStreamJsonParser((e) => events.push(e));
  for (const line of lines) {
    parser.push(line);
  }
  parser.flush();
  return events;
}

describe("createStreamJsonParser", () => {
  // -----------------------------------------------------------------------
  // Claude CLI stream-json format
  // -----------------------------------------------------------------------

  describe("assistant messages", () => {
    it("parses text blocks", () => {
      const events = collect([
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Hello world" }],
          },
        }) + "\n",
      ]);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "text", text: "Hello world" });
    });

    it("parses thinking blocks", () => {
      const events = collect([
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "thinking", thinking: "Let me think..." }],
          },
        }) + "\n",
      ]);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "thinking", text: "Let me think..." });
    });

    it("parses tool_use blocks", () => {
      const events = collect([
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "read_file", input: { path: "/tmp/a" } },
            ],
          },
        }) + "\n",
      ]);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "tool_use",
        name: "read_file",
        input: { path: "/tmp/a" },
      });
    });

    it("parses multiple content blocks in one message", () => {
      const events = collect([
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "hmm" },
              { type: "text", text: "answer" },
            ],
          },
        }) + "\n",
      ]);

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("thinking");
      expect(events[1].type).toBe("text");
    });

    it("ignores non-object content blocks", () => {
      const events = collect([
        JSON.stringify({
          type: "assistant",
          message: {
            content: ["string_block", null, [1, 2, 3], { type: "text", text: "ok" }],
          },
        }) + "\n",
      ]);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "text", text: "ok" });
    });

    it("defaults tool_use name to 'tool' when missing", () => {
      const events = collect([
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", input: {} }],
          },
        }) + "\n",
      ]);

      expect(events[0].name).toBe("tool");
    });
  });

  // -----------------------------------------------------------------------
  // Tool results (user messages)
  // -----------------------------------------------------------------------

  describe("tool results", () => {
    it("parses string content", () => {
      const events = collect([
        JSON.stringify({
          type: "user",
          message: {
            content: [{ type: "tool_result", content: "file contents here" }],
          },
        }) + "\n",
      ]);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "tool_result",
        content: "file contents here",
        isError: false,
      });
    });

    it("parses array content with text parts", () => {
      const events = collect([
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                content: [
                  { type: "text", text: "line 1" },
                  { type: "text", text: "line 2" },
                ],
              },
            ],
          },
        }) + "\n",
      ]);

      expect(events[0].content).toBe("line 1\nline 2");
    });

    it("marks errors from is_error flag", () => {
      const events = collect([
        JSON.stringify({
          type: "user",
          message: {
            content: [
              { type: "tool_result", content: "failed", is_error: true },
            ],
          },
        }) + "\n",
      ]);

      expect(events[0].isError).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // System init
  // -----------------------------------------------------------------------

  describe("system init", () => {
    it("parses session_id from system init", () => {
      const events = collect([
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "sess-abc-123",
        }) + "\n",
      ]);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "session_init",
        sessionId: "sess-abc-123",
      });
    });

    it("ignores system messages without init subtype", () => {
      const events = collect([
        JSON.stringify({ type: "system", subtype: "other" }) + "\n",
      ]);
      expect(events).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Result
  // -----------------------------------------------------------------------

  describe("result", () => {
    it("parses result with usage and cost", () => {
      const events = collect([
        JSON.stringify({
          type: "result",
          usage: { input_tokens: 100, output_tokens: 50 },
          total_cost_usd: 0.0012,
        }) + "\n",
      ]);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "result",
        usage: { input_tokens: 100, output_tokens: 50 },
        costUsd: 0.0012,
      });
    });

    it("falls back to cost_usd field", () => {
      const events = collect([
        JSON.stringify({
          type: "result",
          cost_usd: 0.005,
        }) + "\n",
      ]);

      expect(events[0].costUsd).toBe(0.005);
    });

    it("parses result without usage", () => {
      const events = collect([
        JSON.stringify({ type: "result" }) + "\n",
      ]);

      expect(events[0].usage).toBeUndefined();
      expect(events[0].costUsd).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Anthropic API format (fallback)
  // -----------------------------------------------------------------------

  describe("content_block_delta (API format)", () => {
    it("parses text_delta", () => {
      const events = collect([
        JSON.stringify({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "streaming text" },
        }) + "\n",
      ]);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "text", text: "streaming text" });
    });

    it("parses thinking_delta", () => {
      const events = collect([
        JSON.stringify({
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "pondering" },
        }) + "\n",
      ]);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: "thinking", text: "pondering" });
    });
  });

  // -----------------------------------------------------------------------
  // Buffering & edge cases
  // -----------------------------------------------------------------------

  describe("buffering", () => {
    it("handles split chunks across push calls", () => {
      const events: ChatStreamEvent[] = [];
      const parser = createStreamJsonParser((e) => events.push(e));

      const full = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      });

      // Split in the middle
      parser.push(full.slice(0, 20));
      expect(events).toHaveLength(0);

      parser.push(full.slice(20) + "\n");
      expect(events).toHaveLength(1);
      expect(events[0].text).toBe("hello");
    });

    it("handles multiple lines in one chunk", () => {
      const line1 = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "first" }] },
      });
      const line2 = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "second" }] },
      });

      const events = collect([line1 + "\n" + line2 + "\n"]);
      expect(events).toHaveLength(2);
      expect(events[0].text).toBe("first");
      expect(events[1].text).toBe("second");
    });

    it("skips empty lines", () => {
      const events = collect(["\n\n\n"]);
      expect(events).toHaveLength(0);
    });

    it("skips invalid JSON lines", () => {
      const events = collect(["not json at all\n"]);
      expect(events).toHaveLength(0);
    });

    it("flushes incomplete buffer", () => {
      const events: ChatStreamEvent[] = [];
      const parser = createStreamJsonParser((e) => events.push(e));

      const full = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "flushed" }] },
      });
      parser.push(full); // No trailing newline
      expect(events).toHaveLength(0);

      parser.flush();
      expect(events).toHaveLength(1);
      expect(events[0].text).toBe("flushed");
    });
  });
});
