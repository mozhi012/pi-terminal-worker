import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  validateEnvelope,
  validatePayload,
  validateWorkerReport,
  isKnownMessageType,
  MESSAGE_TYPES,
  MAX_FRAME_SIZE,
  MAX_ID_LENGTH,
  MAX_TYPE_LENGTH,
  MAX_ERROR_MESSAGE_SIZE,
  MAX_FOLLOWUP_MESSAGE_SIZE,
  MAX_REPORT_SUMMARY_SIZE,
  MAX_TASK_TEXT_SIZE,
  MAX_REPORT_SIZE,
  ProtocolErrorCode,
  ProtocolValidationError,
} from "../dist/protocol.js";
import { timingSafeCompare } from "../dist/transport.js";
import { StringDecoder } from "node:string_decoder";

describe("Protocol and Envelope Tests", () => {
  it("应成功校验合法的 Envelope", () => {
    const raw = {
      version: 1,
      controllerId: "ctrl-1",
      workerId: "work-1",
      id: "msg-123",
      seq: 1,
      type: "ping",
      payload: { timestamp: 123456 },
    };

    const validated = validateEnvelope(raw);
    assert.strictEqual(validated.version, 1);
    assert.strictEqual(validated.controllerId, "ctrl-1");
    assert.strictEqual(validated.workerId, "work-1");
    assert.strictEqual(validated.type, "ping");
  });

  it("当 Envelope 缺少必要字段或版本不匹配时应抛出错误", () => {
    assert.throws(() => validateEnvelope(null), /必须是一个非空对象/);
    assert.throws(
      () => validateEnvelope({ version: 2, controllerId: "c", workerId: "w", id: "1", seq: 1, type: "ping" }),
      /不支持的协议版本/,
    );
    assert.throws(
      () => validateEnvelope({ version: 1, workerId: "w", id: "1", seq: 1, type: "ping" }),
      /缺少合法的 controllerId/,
    );
    assert.throws(
      () => validateEnvelope({ version: 1, controllerId: "c", id: "1", seq: 1, type: "ping" }),
      /缺少合法的 workerId/,
    );
    assert.throws(
      () => validateEnvelope({ version: 1, controllerId: "c", workerId: "w", seq: -1, type: "ping" }),
      /缺少合法的消息 id/,
    );
  });

  it("timingSafeCompare 能正确且常数时间判断 Token 是否匹配", () => {
    const token = "a8f3b9c24019283746152435a8f3b9c24019283746152435";
    assert.strictEqual(timingSafeCompare(token, token), true);
    assert.strictEqual(timingSafeCompare(token, token + "x"), false);
    assert.strictEqual(timingSafeCompare(token, "different_token_same_length_12345678901234567890"), false);
    assert.strictEqual(timingSafeCompare(null as any, token), false);
  });

  it("流式 UTF-8 跨 chunk 解码中文多字节字符时不乱码", () => {
    const text = "任务已完成：所有测试均已通过！👍";
    const buf = Buffer.from(text, "utf8");

    // 将 Buffer 在多字节边界处切断成多个小 chunk
    const chunk1 = buf.subarray(0, 5); // 故意在某个汉字编码中间切开
    const chunk2 = buf.subarray(5, 11);
    const chunk3 = buf.subarray(11);

    const decoder = new StringDecoder("utf8");
    let reconstructed = "";
    reconstructed += decoder.write(chunk1);
    reconstructed += decoder.write(chunk2);
    reconstructed += decoder.write(chunk3);
    reconstructed += decoder.end();

    assert.strictEqual(reconstructed, text);
  });
});

function baseEnvelope(): Record<string, unknown> {
  return {
    version: 1,
    controllerId: "ctrl-1",
    workerId: "work-1",
    id: "msg-1",
    seq: 1,
    type: "ping",
    payload: { timestamp: 1 },
  };
}

function assertProtocolError(fn: () => void, code: string): void {
  assert.throws(fn, (err: unknown) => {
    return (
      err instanceof ProtocolValidationError &&
      err.code === code &&
      typeof err.message === "string" &&
      err.message.includes(code)
    );
  });
}

describe("2A: Envelope 严格校验", () => {
  it("合法 Envelope 通过校验", () => {
    const env = validateEnvelope(baseEnvelope());
    assert.strictEqual(env.type, "ping");
    assert.deepStrictEqual(env.payload, { timestamp: 1 });
  });

  it("超长 id / type / controllerId 抛 PAYLOAD_TOO_LARGE", () => {
    assertProtocolError(() => validateEnvelope({ ...baseEnvelope(), id: "x".repeat(MAX_ID_LENGTH + 1) }), ProtocolErrorCode.PAYLOAD_TOO_LARGE);
    assertProtocolError(() => validateEnvelope({ ...baseEnvelope(), type: "x".repeat(MAX_TYPE_LENGTH + 1) }), ProtocolErrorCode.PAYLOAD_TOO_LARGE);
    assertProtocolError(() => validateEnvelope({ ...baseEnvelope(), controllerId: "x".repeat(MAX_ID_LENGTH + 1) }), ProtocolErrorCode.PAYLOAD_TOO_LARGE);
  });

  it("未知消息类型抛 PROTOCOL_ERROR", () => {
    assertProtocolError(
      () => validateEnvelope({ ...baseEnvelope(), type: "test_req" }),
      ProtocolErrorCode.PROTOCOL_ERROR,
    );
  });

  it("revision 为 0 或非整数时抛 PROTOCOL_ERROR", () => {
    assertProtocolError(() => validateEnvelope({ ...baseEnvelope(), revision: 0 }), ProtocolErrorCode.PROTOCOL_ERROR);
    assertProtocolError(() => validateEnvelope({ ...baseEnvelope(), revision: 1.5 }), ProtocolErrorCode.PROTOCOL_ERROR);
    assertProtocolError(() => validateEnvelope({ ...baseEnvelope(), revision: "1" }), ProtocolErrorCode.PROTOCOL_ERROR);
    // 合法 revision 通过
    assert.doesNotThrow(() => validateEnvelope({ ...baseEnvelope(), revision: 2 }));
  });

  it("taskId 为空串时抛 PROTOCOL_ERROR", () => {
    assertProtocolError(() => validateEnvelope({ ...baseEnvelope(), taskId: "" }), ProtocolErrorCode.PROTOCOL_ERROR);
  });

  it("payload 为数组或 null 时抛 PROTOCOL_ERROR", () => {
    assertProtocolError(() => validateEnvelope({ ...baseEnvelope(), payload: [] }), ProtocolErrorCode.PROTOCOL_ERROR);
    assertProtocolError(() => validateEnvelope({ ...baseEnvelope(), payload: null }), ProtocolErrorCode.PROTOCOL_ERROR);
    assertProtocolError(() => validateEnvelope({ ...baseEnvelope(), payload: "str" }), ProtocolErrorCode.PROTOCOL_ERROR);
  });

  it("replyTo 超长时抛错", () => {
    assertProtocolError(
      () => validateEnvelope({ ...baseEnvelope(), replyTo: "x".repeat(MAX_ID_LENGTH + 1) }),
      ProtocolErrorCode.PAYLOAD_TOO_LARGE,
    );
    assertProtocolError(
      () => validateEnvelope({ ...baseEnvelope(), replyTo: 42 }),
      ProtocolErrorCode.PROTOCOL_ERROR,
    );
  });
});

describe("2A: payload 严格校验", () => {
  it("task 缺 task 字段 / task 超 256 KiB → 抛错", () => {
    assertProtocolError(
      () => validatePayload("task", { taskId: "t-1", runId: 1, revision: 1 }),
      ProtocolErrorCode.PROTOCOL_ERROR,
    );
    assertProtocolError(
      () =>
        validatePayload("task", {
          taskId: "t-1",
          runId: 1,
          revision: 1,
          task: "x".repeat(MAX_TASK_TEXT_SIZE + 1),
        }),
      ProtocolErrorCode.PAYLOAD_TOO_LARGE,
    );
    const ok = validatePayload("task", { taskId: "t-1", runId: 1, revision: 1, task: "任务文本" });
    assert.deepStrictEqual(ok, { taskId: "t-1", runId: 1, revision: 1, task: "任务文本" });
  });

  it("followup.kind 非法 / message 超上限 → 抛错", () => {
    const followup = { taskId: "t-1", runId: 1, revision: 1, message: "补充", kind: "bogus" };
    assertProtocolError(() => validatePayload("followup", followup), ProtocolErrorCode.PROTOCOL_ERROR);
    assertProtocolError(
      () =>
        validatePayload("followup", {
          taskId: "t-1",
          runId: 1,
          revision: 1,
          message: "x".repeat(MAX_FOLLOWUP_MESSAGE_SIZE + 1),
          kind: "supplement",
        }),
      ProtocolErrorCode.PAYLOAD_TOO_LARGE,
    );
  });

  it("activity.state 非法 → 抛错", () => {
    assertProtocolError(
      () => validatePayload("activity", { state: "bogus" }),
      ProtocolErrorCode.PROTOCOL_ERROR,
    );
  });

  it("close.disposition 非法 → 抛错", () => {
    assertProtocolError(
      () => validatePayload("close", { disposition: "weird" }),
      ProtocolErrorCode.PROTOCOL_ERROR,
    );
  });

  it("launch 缺 extensionPath / thinkingLevel 非法 → 抛错", () => {
    const launch = {
      cwd: "/work",
      nodePath: "C:/node",
      piCliPath: "C:/pi",
      workerToken: "tok",
      workerPipePath: "C:/pipe",
    };
    assertProtocolError(() => validatePayload("launch", launch), ProtocolErrorCode.PROTOCOL_ERROR);
    assertProtocolError(
      () =>
        validatePayload("launch", { ...launch, extensionPath: "C:/ext", thinkingLevel: "ultra" }),
      ProtocolErrorCode.PROTOCOL_ERROR,
    );
    assert.doesNotThrow(() =>
      validatePayload("launch", { ...launch, extensionPath: "C:/ext", thinkingLevel: "high" }),
    );
  });

  it("hello.role 非法 → 抛错", () => {
    assertProtocolError(
      () =>
        validatePayload("hello", {
          role: "user",
          token: "tok",
          controllerId: "c",
          workerId: "w",
        }),
      ProtocolErrorCode.PROTOCOL_ERROR,
    );
  });

  it("error.message 超 4 KiB → 抛 PAYLOAD_TOO_LARGE", () => {
    assertProtocolError(
      () => validatePayload("error", { code: "X", message: "x".repeat(MAX_ERROR_MESSAGE_SIZE + 1) }),
      ProtocolErrorCode.PAYLOAD_TOO_LARGE,
    );
  });

  it("未知 type 的 payload 校验 → 抛 PROTOCOL_ERROR", () => {
    assertProtocolError(() => validatePayload("test_req", {}), ProtocolErrorCode.PROTOCOL_ERROR);
  });

  it("ping/pong/ack/child_exit 基础类型校验", () => {
    assertProtocolError(() => validatePayload("ping", {}), ProtocolErrorCode.PROTOCOL_ERROR);
    assertProtocolError(() => validatePayload("pong", { timestamp: 1 }), ProtocolErrorCode.PROTOCOL_ERROR);
    assertProtocolError(
      () => validatePayload("ack", { id: "a", ok: "yes" }),
      ProtocolErrorCode.PROTOCOL_ERROR,
    );
    assert.doesNotThrow(() => validatePayload("child_exit", { pid: 0, code: null, signal: null }));
    assertProtocolError(() => validatePayload("child_exit", { pid: -1, code: null, signal: null }), ProtocolErrorCode.PROTOCOL_ERROR);
  });
});

describe("2A: validateWorkerReport", () => {
  it("缺 kind → 抛 PROTOCOL_ERROR", () => {
    assertProtocolError(
      () => validateWorkerReport({ summary: "ok" }),
      ProtocolErrorCode.PROTOCOL_ERROR,
    );
  });

  it("validation.outcome 非法 → 抛 PROTOCOL_ERROR", () => {
    assertProtocolError(
      () =>
        validateWorkerReport({
          kind: "result",
          summary: "ok",
          validation: [{ command: "npm test", outcome: "weird" }],
        }),
      ProtocolErrorCode.PROTOCOL_ERROR,
    );
  });

  it("summary 超 8 KiB → 抛 PAYLOAD_TOO_LARGE", () => {
    assertProtocolError(
      () => validateWorkerReport({ kind: "result", summary: "x".repeat(MAX_REPORT_SUMMARY_SIZE + 1) }),
      ProtocolErrorCode.PAYLOAD_TOO_LARGE,
    );
  });

  it("整体超 64 KiB → 抛 PAYLOAD_TOO_LARGE", () => {
    assertProtocolError(
      () =>
        validateWorkerReport({
          kind: "result",
          summary: "ok",
          changedFiles: Array.from({ length: 70 }, (_, i) => `file-${i}.ts`.padEnd(1000, "x")),
        }),
      ProtocolErrorCode.PAYLOAD_TOO_LARGE,
    );
  });

  it("changedFiles 超过 256 项 → 抛 PAYLOAD_TOO_LARGE", () => {
    assertProtocolError(
      () =>
        validateWorkerReport({
          kind: "result",
          summary: "ok",
          changedFiles: Array.from({ length: 257 }, (_, i) => `f${i}.ts`),
        }),
      ProtocolErrorCode.PAYLOAD_TOO_LARGE,
    );
  });

  it("合法 report 原样返回", () => {
    const report = {
      kind: "result",
      summary: "完成",
      changedFiles: ["a.ts"],
      validation: [{ command: "npm test", outcome: "passed", note: "ok" }],
      unresolved: ["遗留问题"],
    };
    const validated = validateWorkerReport(report);
    assert.deepStrictEqual(validated, report);
    // 自定义 maxBytes 生效
    assertProtocolError(
      () => validateWorkerReport({ kind: "result", summary: "x".repeat(100) }, { maxBytes: 50 }),
      ProtocolErrorCode.PAYLOAD_TOO_LARGE,
    );
    assert.ok(MAX_REPORT_SIZE === 64 * 1024);
  });
});

describe("2A: 消息类型白名单", () => {
  it("23 个白名单类型均已知，未知类型返回 false", () => {
    assert.strictEqual(MESSAGE_TYPES.length, 23);
    for (const t of MESSAGE_TYPES) {
      assert.strictEqual(isKnownMessageType(t), true, `应为已知类型: ${t}`);
    }
    assert.strictEqual(isKnownMessageType("test_req"), false);
    assert.strictEqual(isKnownMessageType(""), false);
  });
});
