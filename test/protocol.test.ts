import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  validateEnvelope,
  MAX_FRAME_SIZE,
  ProtocolErrorCode,
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
