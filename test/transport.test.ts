import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  JsonlConnection,
  getPipePath,
} from "../dist/transport.js";
import {
  type Envelope,
  type AckPayload,
  ProtocolErrorCode,
} from "../dist/protocol.js";

describe("Transport and IPC Tests", () => {
  it("在双向连接中成功发送请求并接收 ACK 应答", async () => {
    const pipeId = "test-ipc-" + crypto.randomUUID().slice(0, 8);
    const pipePath = getPipePath(pipeId);

    const server = net.createServer((socket) => {
      const serverConn = new JsonlConnection(socket, "controller");
      serverConn.on("message", (env: Envelope) => {
        if (env.type === "test_req") {
          serverConn.sendEnvelope({
            version: 1,
            controllerId: env.controllerId,
            workerId: env.workerId,
            id: crypto.randomUUID(),
            replyTo: env.id,
            seq: serverConn.nextSeq,
            type: "ack",
            payload: { id: env.id, ok: true },
          });
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(pipePath, resolve));

    const clientSocket = net.createConnection(pipePath);
    const clientConn = new JsonlConnection(clientSocket, "worker");

    const reqEnvelope: Envelope = {
      version: 1,
      controllerId: "ctrl-1",
      workerId: "work-1",
      id: crypto.randomUUID(),
      seq: clientConn.nextSeq,
      type: "test_req",
      payload: { hello: "world" },
    };

    const ack = await clientConn.sendRequest(reqEnvelope, 2000);
    assert.strictEqual(ack.ok, true);
    assert.strictEqual(ack.id, reqEnvelope.id);

    clientConn.destroy();
    server.close();
  });

  it("当请求超时时应正确抛出超时错误", async () => {
    const pipeId = "test-timeout-" + crypto.randomUUID().slice(0, 8);
    const pipePath = getPipePath(pipeId);

    const server = net.createServer((_socket) => {
      // 故意不回复 ACK
    });

    await new Promise<void>((resolve) => server.listen(pipePath, resolve));

    const clientSocket = net.createConnection(pipePath);
    const clientConn = new JsonlConnection(clientSocket, "worker");

    const reqEnvelope: Envelope = {
      version: 1,
      controllerId: "ctrl-1",
      workerId: "work-1",
      id: crypto.randomUUID(),
      seq: clientConn.nextSeq,
      type: "silent_req",
      payload: {},
    };

    await assert.rejects(
      async () => {
        await clientConn.sendRequest(reqEnvelope, 100);
      },
      (err: Error) => {
        return err.message.includes(ProtocolErrorCode.TIMEOUT);
      },
    );

    clientConn.destroy();
    server.close();
  });

  it("请求去重机制：相同 ID 相同内容返回缓存；相同 ID 不同内容抛出错误", () => {
    const dummySocket = new net.Socket();
    const conn = new JsonlConnection(dummySocket, "controller");

    const reqId = "req-fixed-100";
    const payloadA = { task: "fix bug 1" };
    const payloadB = { task: "fix bug 2" };

    // 第一次检查，缓存中不存在
    const check1 = conn.checkDedup(reqId, payloadA);
    assert.strictEqual(check1, null);

    // 记录 ACK
    const ack: AckPayload = { id: reqId, ok: true };
    conn.recordDedup(reqId, payloadA, ack);

    // 再次以相同内容查询，应返回缓存
    const check2 = conn.checkDedup(reqId, payloadA);
    assert.notStrictEqual(check2, null);
    assert.strictEqual(check2!.ack.ok, true);

    // 以不同内容查询相同 ID，应报错
    assert.throws(() => {
      conn.checkDedup(reqId, payloadB);
    }, (err: Error) => err.message.includes(ProtocolErrorCode.DUPLICATE_REQUEST_MISMATCH));

    conn.destroy();
  });
});
