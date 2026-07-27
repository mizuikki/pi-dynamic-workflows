import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import {
  extractValidated,
  lastAssistantError,
  resolveStructuredOutput,
  type StructuredSession,
  throwIfAssistantError,
  throwIfProviderLimit,
} from "../src/agent.js";
import { WorkflowErrorCode } from "../src/errors.js";
import type { StructuredOutputCapture } from "../src/structured-output.js";

const Schema = Type.Object({ word: Type.String() });

describe("extractValidated", () => {
  it("extracts a fenced ```json block that validates", () => {
    assert.deepEqual(extractValidated('blah\n```json\n{"word":"hi"}\n```\nmore', Schema), { word: "hi" });
  });

  it("extracts a bare {...} object embedded in prose", () => {
    assert.deepEqual(extractValidated('here it is: {"word":"hi"} done', Schema), { word: "hi" });
  });

  it("coerces types toward the schema, then validates", () => {
    const NumSchema = Type.Object({ n: Type.Number() });
    assert.deepEqual(extractValidated('{"n":"5"}', NumSchema), { n: 5 });
  });

  it("returns undefined for prose with no JSON", () => {
    assert.equal(extractValidated("there is no json here", Schema), undefined);
  });

  it("returns undefined when the JSON does not satisfy the schema (no fabrication)", () => {
    assert.equal(extractValidated('{"notWord": 1}', Schema), undefined);
  });

  it("returns undefined for malformed JSON", () => {
    assert.equal(extractValidated("{word: ", Schema), undefined);
  });
});

describe("resolveStructuredOutput", () => {
  const opts = { maxSchemaRetries: 2 };
  const noText = () => "";

  function makeSession(behavior: { callAfter?: number } = {}): {
    session: StructuredSession;
    capture: StructuredOutputCapture<{ word: string }>;
    prompts: () => number;
  } {
    let prompts = 0;
    const capture: StructuredOutputCapture<{ word: string }> = { called: false, value: undefined };
    const session: StructuredSession = {
      async prompt() {
        prompts++;
        if (behavior.callAfter && prompts >= behavior.callAfter) {
          capture.called = true;
          capture.value = { word: "ok" };
        }
      },
      setActiveToolsByName() {},
      messages: [],
    };
    return { session, capture, prompts: () => prompts };
  }

  it("returns the captured value without re-prompting when already called", async () => {
    const { session, capture, prompts } = makeSession();
    capture.called = true;
    capture.value = { word: "done" };
    assert.deepEqual(await resolveStructuredOutput(session, capture, Schema, opts, noText), { word: "done" });
    assert.equal(prompts(), 0, "no repair prompts when already called");
  });

  it("recovers via a bounded repair re-prompt", async () => {
    const { session, capture, prompts } = makeSession({ callAfter: 1 });
    assert.deepEqual(await resolveStructuredOutput(session, capture, Schema, opts, noText), { word: "ok" });
    assert.equal(prompts(), 1, "one repair prompt recovered it");
  });

  it("falls back to strict prose extraction when repair fails", async () => {
    const { session, capture } = makeSession();
    const r = await resolveStructuredOutput(session, capture, Schema, opts, () => '{"word":"fromProse"}');
    assert.deepEqual(r, { word: "fromProse" });
  });

  it("throws SCHEMA_NONCOMPLIANCE when repair and extraction both fail", async () => {
    const { session, capture } = makeSession();
    await assert.rejects(
      () => resolveStructuredOutput(session, capture, Schema, opts, () => "no json at all"),
      /structured_output/i,
    );
  });

  it("honors an aborted signal", async () => {
    const { session, capture } = makeSession();
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      () => resolveStructuredOutput(session, capture, Schema, { ...opts, signal: ctrl.signal }, noText),
      /aborted/i,
    );
  });

  it("surfaces a provider usage limit hit during repair as PROVIDER_USAGE_LIMIT (not SCHEMA_NONCOMPLIANCE)", async () => {
    const { session, capture } = makeSession();
    // The repair re-prompts ran but the turn ended in a buried provider limit.
    session.messages = [
      {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Codex usage limit reached. Resets in ~3h.",
      },
    ];
    await assert.rejects(
      () => resolveStructuredOutput(session, capture, Schema, opts, () => "no json at all"),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
        assert.equal((err as { recoverable?: boolean }).recoverable, false);
        return true;
      },
    );
  });

  it("does not extract stale JSON after a repair turn ends in an error", async () => {
    const { session, capture } = makeSession();
    session.prompt = async () => {
      session.messages.push({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "HTTP 503 service unavailable",
      });
    };
    await assert.rejects(
      () => resolveStructuredOutput(session, capture, Schema, opts, () => '{"word":"stale"}'),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
        assert.equal((err as { recoverable?: boolean }).recoverable, true);
        return true;
      },
    );
  });

  it("rejects invalid maxSchemaRetries without prompting", async () => {
    const { session, capture, prompts } = makeSession();
    await assert.rejects(
      () => resolveStructuredOutput(session, capture, Schema, { maxSchemaRetries: 1.5 }, noText),
      /non-negative safe integer/,
    );
    assert.equal(prompts(), 0);
  });
});

describe("lastAssistantError / throwIfProviderLimit", () => {
  it("reads stopReason/errorMessage off the most recent assistant message", () => {
    const messages = [
      { role: "user", content: [] },
      { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" },
    ];
    assert.deepEqual(lastAssistantError(messages), { stopReason: "error", errorMessage: "boom" });
  });

  it("throws PROVIDER_USAGE_LIMIT only when stopReason is error AND the message matches a limit", () => {
    assert.throws(
      () =>
        throwIfProviderLimit(
          [
            {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "usage limit reached. Resets in ~3h.",
            },
          ],
          "lbl",
        ),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
        assert.equal((err as { resetHint?: string }).resetHint, "Resets in ~3h");
        assert.equal((err as { agentLabel?: string }).agentLabel, "lbl");
        return true;
      },
    );
  });

  it("does not throw for a successful turn whose text merely mentions 'rate limit'", () => {
    assert.doesNotThrow(() =>
      throwIfProviderLimit([
        {
          role: "assistant",
          content: [{ type: "text", text: "I handled the rate limit gracefully" }],
          stopReason: "stop",
        },
      ]),
    );
  });

  it("does not throw for a non-limit error turn", () => {
    assert.doesNotThrow(() =>
      throwIfProviderLimit([{ role: "assistant", content: [], stopReason: "error", errorMessage: "network blip" }]),
    );
  });

  it("preserves terminal local-provider setup errors instead of treating them as empty output", () => {
    assert.throws(
      () =>
        throwIfAssistantError(
          [
            {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "Codex tool profile is unavailable for the selected capability",
            },
          ],
          "profile",
        ),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
        assert.equal((err as { recoverable?: boolean }).recoverable, false);
        assert.equal((err as { agentLabel?: string }).agentLabel, "profile");
        return true;
      },
    );
  });

  it("does not retry a missing provider session route", () => {
    assert.throws(
      () =>
        throwIfAssistantError(
          [
            {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "Codex provider route is unavailable for the current Pi session",
            },
          ],
          "route",
        ),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
        assert.equal((err as { recoverable?: boolean }).recoverable, false);
        return true;
      },
    );
  });

  it("keeps Pi-classified transient provider errors recoverable", () => {
    assert.throws(
      () =>
        throwIfAssistantError([
          { role: "assistant", content: [], stopReason: "error", errorMessage: "HTTP 503 service unavailable" },
        ]),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
        assert.equal((err as { recoverable?: boolean }).recoverable, true);
        return true;
      },
    );
  });

  it("keeps unknown provider errors non-recoverable", () => {
    assert.throws(
      () =>
        throwIfAssistantError([
          { role: "assistant", content: [], stopReason: "error", errorMessage: "unexpected provider configuration" },
        ]),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
        assert.equal((err as { recoverable?: boolean }).recoverable, false);
        return true;
      },
    );
  });

  it("maps an aborted assistant terminal message to WORKFLOW_ABORTED", () => {
    assert.throws(
      () =>
        throwIfAssistantError([
          { role: "assistant", content: [], stopReason: "aborted", errorMessage: "request was aborted" },
        ]),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, WorkflowErrorCode.WORKFLOW_ABORTED);
        return true;
      },
    );
  });
});
