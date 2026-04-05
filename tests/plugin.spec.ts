import { describe, expect, it, beforeEach } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("paperclip-plugin-chat", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = createTestHarness({
      manifest,
      config: {
        defaultAdapterType: "claude_local",
        systemPromptOverride: "",
      },
    });
    await plugin.definition.setup(harness.ctx);
  });

  // -----------------------------------------------------------------------
  // Setup
  // -----------------------------------------------------------------------

  it("logs setup message on startup", () => {
    expect(harness.logs.some((l) => l.message.includes("setup"))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Thread CRUD
  // -----------------------------------------------------------------------

  describe("action: createThread", () => {
    it("creates a new thread with defaults", async () => {
      const thread = await harness.performAction<{
        id: string;
        companyId: string;
        title: string;
        adapterType: string;
        status: string;
      }>("createThread", {
        companyId: "comp-1",
      });

      expect(thread.id).toBeTruthy();
      expect(thread.companyId).toBe("comp-1");
      expect(thread.title).toBe("New Chat");
      expect(thread.adapterType).toBe("claude_local");
      expect(thread.status).toBe("idle");
    });

    it("respects custom adapter and title", async () => {
      const thread = await harness.performAction<{
        title: string;
        adapterType: string;
      }>("createThread", {
        companyId: "comp-1",
        adapterType: "codex_local",
        title: "My Chat",
      });

      expect(thread.title).toBe("My Chat");
      expect(thread.adapterType).toBe("codex_local");
    });

    it("throws when companyId is missing", async () => {
      await expect(
        harness.performAction("createThread", {}),
      ).rejects.toThrow("companyId is required");
    });
  });

  describe("action: deleteThread", () => {
    it("deletes a thread and its messages", async () => {
      const thread = await harness.performAction<{ id: string }>(
        "createThread",
        { companyId: "comp-1" },
      );

      const result = await harness.performAction<{ ok: boolean }>(
        "deleteThread",
        { threadId: thread.id, companyId: "comp-1" },
      );

      expect(result.ok).toBe(true);

      // Thread list should be empty
      const threads = await harness.getData<unknown[]>("threads", {
        companyId: "comp-1",
      });
      expect(threads).toHaveLength(0);
    });

    it("throws when missing params", async () => {
      await expect(
        harness.performAction("deleteThread", {}),
      ).rejects.toThrow("threadId and companyId required");
    });
  });

  describe("action: updateThreadTitle", () => {
    it("updates the thread title", async () => {
      const thread = await harness.performAction<{ id: string }>(
        "createThread",
        { companyId: "comp-1" },
      );

      const updated = await harness.performAction<{ title: string }>(
        "updateThreadTitle",
        { threadId: thread.id, title: "Renamed" },
      );

      expect(updated.title).toBe("Renamed");
    });

    it("throws for non-existent thread", async () => {
      await expect(
        harness.performAction("updateThreadTitle", {
          threadId: "nope",
          title: "x",
        }),
      ).rejects.toThrow("Thread not found");
    });
  });

  // -----------------------------------------------------------------------
  // Data handlers
  // -----------------------------------------------------------------------

  describe("data: threads", () => {
    it("returns empty array when no threads exist", async () => {
      const threads = await harness.getData<unknown[]>("threads", {
        companyId: "comp-1",
      });
      expect(threads).toEqual([]);
    });

    it("returns threads sorted by updatedAt descending", async () => {
      await harness.performAction("createThread", {
        companyId: "comp-1",
        title: "First",
      });
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));
      await harness.performAction("createThread", {
        companyId: "comp-1",
        title: "Second",
      });

      const threads = await harness.getData<Array<{ title: string }>>(
        "threads",
        { companyId: "comp-1" },
      );

      expect(threads).toHaveLength(2);
      // Most recent first
      expect(threads[0].title).toBe("Second");
      expect(threads[1].title).toBe("First");
    });

    it("returns empty when companyId is missing", async () => {
      const result = await harness.getData("threads", {});
      expect(result).toEqual([]);
    });
  });

  describe("data: messages", () => {
    it("returns empty array for a new thread", async () => {
      const thread = await harness.performAction<{ id: string }>(
        "createThread",
        { companyId: "comp-1" },
      );

      const msgs = await harness.getData<unknown[]>("messages", {
        threadId: thread.id,
      });
      expect(msgs).toEqual([]);
    });

    it("returns empty when threadId is missing", async () => {
      const result = await harness.getData("messages", {});
      expect(result).toEqual([]);
    });
  });

  describe("data: adapters", () => {
    it("returns default Claude adapter when no agents exist", async () => {
      const adapters = await harness.getData<
        Array<{ type: string; label: string; available: boolean }>
      >("adapters", { companyId: "comp-1" });

      expect(adapters.length).toBeGreaterThanOrEqual(1);
      expect(adapters[0].type).toBe("claude_local");
      expect(adapters[0].available).toBe(true);
    });

    it("returns Claude fallback when companyId is missing", async () => {
      const adapters = await harness.getData<
        Array<{ type: string }>
      >("adapters", {});

      expect(adapters).toHaveLength(1);
      expect(adapters[0].type).toBe("claude_local");
    });

    it("deduplicates agents by adapterType", async () => {
      harness.seed({
        agents: [
          {
            id: "agent-1",
            companyId: "comp-1",
            name: "Claude 1",
            adapterType: "claude_local",
            status: "idle",
            nameKey: "claude-1",
            agentConfig: null,
            createdByUserId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as any,
          {
            id: "agent-2",
            companyId: "comp-1",
            name: "Claude 2",
            adapterType: "claude_local",
            status: "idle",
            nameKey: "claude-2",
            agentConfig: null,
            createdByUserId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as any,
        ],
      });

      const adapters = await harness.getData<Array<{ type: string }>>(
        "adapters",
        { companyId: "comp-1" },
      );

      const claudeAdapters = adapters.filter(
        (a) => a.type === "claude_local",
      );
      expect(claudeAdapters).toHaveLength(1);
    });

    it("marks adapter unavailable when all agents are terminated", async () => {
      harness.seed({
        agents: [
          {
            id: "agent-1",
            companyId: "comp-1",
            name: "Dead Claude",
            adapterType: "claude_local",
            status: "terminated",
            nameKey: "claude-1",
            agentConfig: null,
            createdByUserId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as any,
        ],
      });

      const adapters = await harness.getData<
        Array<{ type: string; available: boolean }>
      >("adapters", { companyId: "comp-1" });

      expect(adapters[0].available).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // sendMessage action
  // -----------------------------------------------------------------------

  describe("action: sendMessage", () => {
    it("saves user message and auto-generates title", async () => {
      const thread = await harness.performAction<{
        id: string;
        title: string;
      }>("createThread", { companyId: "comp-1" });

      // sendMessage spawns a background process, but the sync part
      // (user message save, title update, status change) happens before it
      const result = await harness.performAction<{ ok: boolean }>(
        "sendMessage",
        {
          threadId: thread.id,
          message: "Hello, can you help me?",
          companyId: "comp-1",
        },
      );

      expect(result.ok).toBe(true);

      // Verify user message was persisted
      const msgs = await harness.getData<
        Array<{ role: string; content: string }>
      >("messages", { threadId: thread.id });
      expect(msgs.length).toBeGreaterThanOrEqual(1);
      expect(msgs[0].role).toBe("user");
      expect(msgs[0].content).toBe("Hello, can you help me?");
    });

    it("throws when missing required params", async () => {
      await expect(
        harness.performAction("sendMessage", { threadId: "t1" }),
      ).rejects.toThrow();
    });

    it("throws for non-existent thread", async () => {
      await expect(
        harness.performAction("sendMessage", {
          threadId: "nonexistent",
          message: "hi",
          companyId: "comp-1",
        }),
      ).rejects.toThrow("Thread not found");
    });
  });

  // -----------------------------------------------------------------------
  // stopThread action
  // -----------------------------------------------------------------------

  describe("action: stopThread", () => {
    it("marks a running thread as idle", async () => {
      const thread = await harness.performAction<{ id: string }>(
        "createThread",
        { companyId: "comp-1" },
      );

      const result = await harness.performAction<{
        ok: boolean;
        stopped: boolean;
      }>("stopThread", { threadId: thread.id, companyId: "comp-1" });

      expect(result.ok).toBe(true);
      expect(result.stopped).toBe(true);
    });

    it("returns stopped: false for non-existent thread", async () => {
      const result = await harness.performAction<{
        ok: boolean;
        stopped: boolean;
      }>("stopThread", { threadId: "nope", companyId: "comp-1" });

      expect(result.ok).toBe(true);
      expect(result.stopped).toBe(false);
    });

    it("throws when missing params", async () => {
      await expect(
        harness.performAction("stopThread", {}),
      ).rejects.toThrow("threadId and companyId required");
    });
  });

  // -----------------------------------------------------------------------
  // Health check
  // -----------------------------------------------------------------------

  describe("onHealth", () => {
    it("reports healthy status", async () => {
      const health = await plugin.definition.onHealth!();
      expect(health.status).toBe("ok");
    });
  });
});
