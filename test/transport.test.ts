import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as net from "node:net";
import * as crypto from "node:crypto";
import {
  JsonlConnection,
  getPipePath,
  AckTimeoutError,
} from "../dist/transport.js";
import {
  type Envelope,
  type AckPayload,
  MAX_SEND_BUFFER_BYTES,
  MAX_DEDUP_CACHE_SIZE,
  MAX_CONTROL_DEDUP_SIZE,
  ProtocolErrorCode,
} from "../dist/protocol.js";

async function waitFor(cond: () => unknown, timeoutMs = 3000): Promise<unknown> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = cond();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("等待条件超时");
}

describe("Transport and IPC Tests", () => {
  it("在双向连接中成功发送请求并接收 ACK 应答", async () => {
    const pipeId = "test-ipc-" + crypto.randomUUID().slice(0, 8);
    const pipePath = getPipePath(pipeId);

    const server = net.createServer((socket) => {
      const serverConn = new JsonlConnection(socket, "controller");
      serverConn.on("message", (env: Envelope) => {
        if (env.type === "ping") {
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
      type: "ping",
      payload: { timestamp: Date.now() },
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
      type: "ping",
      payload: { timestamp: Date.now() },
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

describe("2A: 传输层故障注入", () => {
  it("无 error 监听时协议违规不产生 uncaughtException，且连接被销毁", async () => {
    const pipePath = getPipePath("test-noerr-" + crypto.randomUUID().slice(0, 8));
    const uncaught: unknown[] = [];
    const handler = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", handler);
    let conn: JsonlConnection | null = null;

    const server = net.createServer((socket) => {
      // 故意不注册 error 监听：未处理的 'error' 事件不得击穿进程
      conn = new JsonlConnection(socket, "controller");
    });
    await new Promise<void>((resolve) => server.listen(pipePath, resolve));

    const client = net.createConnection(pipePath);
    client.on("error", () => {});
    await new Promise<void>((resolve) => client.on("connect", resolve));
    await waitFor(() => conn !== null);

    try {
      client.write("{not json}\n");
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(uncaught.length, 0, "无 error 监听时不得产生 uncaughtException");
      assert.strictEqual(conn!.socket.destroyed, true, "连接应被销毁");
    } finally {
      process.off("uncaughtException", handler);
      client.destroy();
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("异常 JSON 行：连接被销毁、不崩溃、error 事件带 PROTOCOL_ERROR", async () => {
    const pipePath = getPipePath("test-badjson-" + crypto.randomUUID().slice(0, 8));
    const errors: Error[] = [];
    let serverSocket: net.Socket | null = null;

    const server = net.createServer((socket) => {
      serverSocket = socket;
      const conn = new JsonlConnection(socket, "controller");
      conn.on("error", (err: Error) => errors.push(err));
      conn.on("message", () => {
        // 不合法的一行不得进入 message 事件
        assert.fail("异常 JSON 不应触发 message 事件");
      });
    });

    await new Promise<void>((resolve) => server.listen(pipePath, resolve));

    const client = net.createConnection(pipePath);
    await new Promise<void>((resolve) => client.on("connect", resolve));

    client.write("{not json}\n");

    await waitFor(() => errors.length > 0);
    assert.ok(
      errors.some((e) => e.message.includes(ProtocolErrorCode.PROTOCOL_ERROR)),
      "error 事件应携带 PROTOCOL_ERROR",
    );
    await waitFor(() => serverSocket?.destroyed === true);
    assert.strictEqual(serverSocket!.destroyed, true);

    client.destroy();
    server.closeAllConnections?.();
    server.close();
  });

  it("未知消息类型：对端收到 error envelope (replyTo=请求 id) 且连接被销毁", async () => {
    const pipePath = getPipePath("test-unknowntype-" + crypto.randomUUID().slice(0, 8));
    let serverConn: JsonlConnection | null = null;

    const server = net.createServer((socket) => {
      serverConn = new JsonlConnection(socket, "controller");
      serverConn.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(pipePath, resolve));

    const clientConn = new JsonlConnection(net.createConnection(pipePath), "worker");
    const peerMessages: Envelope[] = [];
    clientConn.on("error", () => {});
    clientConn.on("message", (env: Envelope) => peerMessages.push(env));

    await waitFor(() => serverConn && !clientConn.socket.destroyed);

    const reqId = crypto.randomUUID();
    clientConn
      .sendEnvelope({
        version: 1,
        controllerId: "ctrl-1",
        workerId: "work-1",
        id: reqId,
        seq: clientConn.nextSeq,
        type: "test_req",
        payload: { hello: "world" },
      })
      .catch(() => {});

    const errEnv = (await waitFor(() =>
      peerMessages.find((m) => m.type === "error" && m.replyTo === reqId),
    )) as Envelope;
    assert.strictEqual((errEnv.payload as { code: string }).code, ProtocolErrorCode.PROTOCOL_ERROR);

    await waitFor(() => clientConn.socket.destroyed && serverConn!.socket.destroyed);

    clientConn.destroy();
    server.closeAllConnections?.();
    server.close();
  });

  it("非法 payload (activity.state=bogus)：对端收到 error envelope 且连接被销毁", async () => {
    const pipePath = getPipePath("test-badpayload-" + crypto.randomUUID().slice(0, 8));
    let serverConn: JsonlConnection | null = null;

    const server = net.createServer((socket) => {
      serverConn = new JsonlConnection(socket, "controller");
      serverConn.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(pipePath, resolve));

    const clientConn = new JsonlConnection(net.createConnection(pipePath), "worker");
    clientConn.on("error", () => {});
    const peerMessages: Envelope[] = [];
    clientConn.on("message", (env: Envelope) => peerMessages.push(env));

    await waitFor(() => serverConn && !clientConn.socket.destroyed);

    const reqId = crypto.randomUUID();
    clientConn
      .sendEnvelope({
        version: 1,
        controllerId: "ctrl-1",
        workerId: "work-1",
        id: reqId,
        seq: clientConn.nextSeq,
        type: "activity",
        payload: { state: "bogus" },
      })
      .catch(() => {});

    const errEnv = (await waitFor(() =>
      peerMessages.find((m) => m.type === "error" && m.replyTo === reqId),
    )) as Envelope;
    assert.strictEqual((errEnv.payload as { code: string }).code, ProtocolErrorCode.PROTOCOL_ERROR);

    await waitFor(() => clientConn.socket.destroyed && serverConn!.socket.destroyed);

    clientConn.destroy();
    server.closeAllConnections?.();
    server.close();
  });

  it("超大帧：单行 > 1 MiB → 连接被销毁并 emit error", async () => {
    const pipePath = getPipePath("test-bigframe-" + crypto.randomUUID().slice(0, 8));
    const errors: Error[] = [];
    let serverSocket: net.Socket | null = null;

    const server = net.createServer((socket) => {
      serverSocket = socket;
      const conn = new JsonlConnection(socket, "controller");
      conn.on("error", (err: Error) => errors.push(err));
    });
    await new Promise<void>((resolve) => server.listen(pipePath, resolve));

    const client = net.createConnection(pipePath);
    await new Promise<void>((resolve) => client.on("connect", resolve));

    const bigLine = '{"note":"' + "a".repeat(1100 * 1024) + '"}\n';
    client.write(bigLine);

    await waitFor(() => errors.length > 0);
    assert.ok(errors.some((e) => e.message.includes(ProtocolErrorCode.PAYLOAD_TOO_LARGE)));
    await waitFor(() => serverSocket?.destroyed === true);

    client.destroy();
    server.closeAllConnections?.();
    server.close();
  });

  it("超大帧：无换行连续 > 2 MiB → 连接被销毁并 emit error", async () => {
    const pipePath = getPipePath("test-bigbuf-" + crypto.randomUUID().slice(0, 8));
    const errors: Error[] = [];
    let serverSocket: net.Socket | null = null;

    const server = net.createServer((socket) => {
      serverSocket = socket;
      const conn = new JsonlConnection(socket, "controller");
      conn.on("error", (err: Error) => errors.push(err));
    });
    await new Promise<void>((resolve) => server.listen(pipePath, resolve));

    const client = net.createConnection(pipePath);
    await new Promise<void>((resolve) => client.on("connect", resolve));

    client.write("a".repeat(2200 * 1024));

    await waitFor(() => errors.length > 0);
    assert.ok(errors.some((e) => e.message.includes(ProtocolErrorCode.PAYLOAD_TOO_LARGE)));
    await waitFor(() => serverSocket?.destroyed === true);

    client.destroy();
    server.closeAllConnections?.();
    server.close();
  });

  it("背压：并发 200 次 64 KiB sendEnvelope 触发 QUEUE_BYTES_EXCEEDED 且 writableLength 有界", async () => {
    const pipePath = getPipePath("test-backpressure-" + crypto.randomUUID().slice(0, 8));
    let serverSocket: net.Socket | null = null;

    // 对端只连不读
    const server = net.createServer((socket) => {
      serverSocket = socket;
    });
    await new Promise<void>((resolve) => server.listen(pipePath, resolve));

    const clientConn = new JsonlConnection(net.createConnection(pipePath), "worker");
    await waitFor(() => serverSocket && !clientConn.socket.destroyed);

    const chunk = "x".repeat(64 * 1024);
    const writes: Promise<void>[] = [];
    let rejectedQueueFull = 0;

    for (let i = 0; i < 200; i++) {
      const p = clientConn
        .sendEnvelope({
          version: 1,
          controllerId: "ctrl-1",
          workerId: "work-1",
          id: `bp-${i}`,
          seq: clientConn.nextSeq,
          type: "activity",
          payload: { state: "idle", toolName: `${i}-${chunk}` },
        })
        .then(
          () => {},
          (err: any) => {
            if (err?.code === ProtocolErrorCode.QUEUE_BYTES_EXCEEDED) {
              rejectedQueueFull++;
            }
          },
        );
      writes.push(p);
    }

    await waitFor(() => rejectedQueueFull >= 1, 5000);
    assert.ok(rejectedQueueFull >= 1, "至少一个写入应以 QUEUE_BYTES_EXCEEDED reject");
    assert.ok(
      clientConn.socket.writableLength < MAX_SEND_BUFFER_BYTES + 2 * 1024 * 1024,
      `writableLength 应有界，实际 ${clientConn.socket.writableLength}`,
    );

    clientConn.destroy();
    await Promise.allSettled(writes);

    server.closeAllConnections?.();
    server.close();
  });

  it("对端关闭时 writeRaw 以 PEER_DISCONNECTED reject 而不是永久挂起", async () => {
    const pipePath = getPipePath("test-rawclose-" + crypto.randomUUID().slice(0, 8));

    const server = net.createServer((socket) => {
      setTimeout(() => socket.destroy(), 50);
    });
    await new Promise<void>((resolve) => server.listen(pipePath, resolve));

    const conn = new JsonlConnection(net.createConnection(pipePath), "worker");
    conn.on("error", () => {});

    // 等对端关闭传导到本端
    await waitFor(() => conn.socket.readable === false || conn.socket.destroyed, 5000);

    await assert.rejects(
      Promise.race([
        conn.writeRaw("x".repeat(1024)),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("writeRaw 挂起超过 1s")), 1000),
        ),
      ]),
      (err: Error) => err.message.includes(ProtocolErrorCode.PEER_DISCONNECTED),
    );

    conn.destroy();
    server.closeAllConnections?.();
    server.close();
  });

  it("去重容量：普通表 1024 条耗尽后新普通请求抛 DEDUP_FULL，控制表独立且 256 条 FIFO 淘汰", () => {
    const conn = new JsonlConnection(new net.Socket(), "controller");

    // 填满普通表
    for (let i = 0; i < MAX_DEDUP_CACHE_SIZE; i++) {
      conn.recordDedup(`n-${i}`, { i }, { id: `n-${i}`, ok: true });
    }
    assert.strictEqual(conn.getDedupStats().normal, MAX_DEDUP_CACHE_SIZE);

    // 新普通请求被拒绝
    assert.throws(
      () => conn.checkDedup("n-new", { i: 1 }),
      (err: Error) => err.message.includes(ProtocolErrorCode.DEDUP_FULL),
    );

    // 控制请求不受容量影响
    const cPayload = { c: 1 };
    assert.strictEqual(conn.checkDedup("c-new", cPayload, true), null);
    const cAck: AckPayload = { id: "c-new", ok: true };
    conn.recordDedup("c-new", cPayload, cAck, true);
    assert.notStrictEqual(conn.checkDedup("c-new", cPayload, true), null);
    assert.strictEqual(conn.getDedupStats().control, 1);

    // 控制表超过 256 条时最旧控制条目被淘汰 (FIFO)
    for (let i = 0; i < MAX_CONTROL_DEDUP_SIZE; i++) {
      conn.recordDedup(`c-${i}`, { i }, { id: `c-${i}`, ok: true }, true);
    }
    const stats = conn.getDedupStats();
    assert.strictEqual(stats.control, MAX_CONTROL_DEDUP_SIZE);
    assert.strictEqual(stats.normal, MAX_DEDUP_CACHE_SIZE);
    assert.strictEqual(stats.maxControl, MAX_CONTROL_DEDUP_SIZE);
    assert.strictEqual(stats.maxNormal, MAX_DEDUP_CACHE_SIZE);
    // 最旧的控制条目 "c-new" 应被淘汰，最新 "c-255" 保留
    assert.strictEqual(conn.checkDedup("c-new", cPayload, true), null);
    assert.notStrictEqual(conn.checkDedup(`c-${MAX_CONTROL_DEDUP_SIZE - 1}`, { i: MAX_CONTROL_DEDUP_SIZE - 1 }, true), null);

    conn.destroy();
  });

  it("sendRequest 超时 reject AckTimeoutError (deliveryUnknown/requestId/TIMEOUT)", async () => {
    const pipePath = getPipePath("test-acktimeout-" + crypto.randomUUID().slice(0, 8));

    const server = net.createServer((_socket) => {
      // 故意不回复
    });
    await new Promise<void>((resolve) => server.listen(pipePath, resolve));

    const conn = new JsonlConnection(net.createConnection(pipePath), "worker");
    const reqId = crypto.randomUUID();

    await assert.rejects(
      conn.sendRequest(
        {
          version: 1,
          controllerId: "ctrl-1",
          workerId: "work-1",
          id: reqId,
          seq: conn.nextSeq,
          type: "ping",
          payload: { timestamp: Date.now() },
        },
        100,
      ),
      (err: unknown) => {
        assert.ok(err instanceof AckTimeoutError, "应为 AckTimeoutError");
        assert.strictEqual(err.deliveryUnknown, true);
        assert.strictEqual(err.requestId, reqId);
        assert.ok(err.message.includes(ProtocolErrorCode.TIMEOUT));
        assert.ok(err.message.includes("请求超时"));
        return true;
      },
    );

    conn.destroy();
    server.closeAllConnections?.();
    server.close();
  });
});

describe("入站 seq 严格递增校验 (strictProtocol 生产模式)", () => {
  /**
   * 建立严格模式服务端 (controller, enforceInboundSequence=true) + 默认非严格客户端，
   * 客户端显式传 seq 作为发送方。两端均挂 error 监听避免未处理 error。
   */
  async function setupStrictPair() {
    const pipePath = getPipePath("test-strictseq-" + crypto.randomUUID().slice(0, 8));
    let serverConn: JsonlConnection | null = null;
    const serverMessages: Envelope[] = [];

    const server = net.createServer((socket) => {
      serverConn = new JsonlConnection(socket, "controller", true);
      serverConn.on("error", () => {});
      serverConn.on("message", (env: Envelope) => serverMessages.push(env));
    });
    await new Promise<void>((resolve) => server.listen(pipePath, resolve));

    const clientConn = new JsonlConnection(net.createConnection(pipePath), "worker");
    const peerMessages: Envelope[] = [];
    clientConn.on("error", () => {});
    clientConn.on("message", (env: Envelope) => peerMessages.push(env));

    await waitFor(() => serverConn && !clientConn.socket.destroyed);
    return {
      server,
      getServerConn: () => serverConn!,
      serverMessages,
      clientConn,
      peerMessages,
    };
  }

  function sendPing(conn: JsonlConnection, id: string, seq: number): void {
    conn
      .sendEnvelope({
        version: 1,
        controllerId: "ctrl-1",
        workerId: "work-1",
        id,
        seq,
        type: "ping",
        payload: { timestamp: Date.now() },
      })
      .catch(() => {});
  }

  it("重复 seq：第二条被拒，回送 PROTOCOL_ERROR 且连接被销毁", async () => {
    const { server, getServerConn, serverMessages, clientConn, peerMessages } =
      await setupStrictPair();
    try {
      sendPing(clientConn, "strict-dup-1", 1);
      await waitFor(() => serverMessages.length === 1);

      sendPing(clientConn, "strict-dup-2", 1);
      const errEnv = (await waitFor(() =>
        peerMessages.find((m) => m.type === "error" && m.replyTo === "strict-dup-2"),
      )) as Envelope;
      assert.strictEqual((errEnv.payload as { code: string }).code, ProtocolErrorCode.PROTOCOL_ERROR);

      // 第二条不得进入 message 事件
      assert.strictEqual(serverMessages.length, 1, "重复 seq 消息不得被接受");
      await waitFor(() => clientConn.socket.destroyed && getServerConn().socket.destroyed);
      assert.strictEqual(clientConn.socket.destroyed, true);
      assert.strictEqual(getServerConn().socket.destroyed, true);
    } finally {
      clientConn.destroy();
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("倒退 seq：seq=5 接受后 seq=3 被拒，回送 PROTOCOL_ERROR 且连接被销毁", async () => {
    const { server, getServerConn, serverMessages, clientConn, peerMessages } =
      await setupStrictPair();
    try {
      sendPing(clientConn, "strict-back-5", 5);
      await waitFor(() => serverMessages.length === 1);

      sendPing(clientConn, "strict-back-3", 3);
      const errEnv = (await waitFor(() =>
        peerMessages.find((m) => m.type === "error" && m.replyTo === "strict-back-3"),
      )) as Envelope;
      assert.strictEqual((errEnv.payload as { code: string }).code, ProtocolErrorCode.PROTOCOL_ERROR);

      assert.strictEqual(serverMessages.length, 1, "倒退 seq 消息不得被接受");
      await waitFor(() => clientConn.socket.destroyed && getServerConn().socket.destroyed);
      assert.strictEqual(clientConn.socket.destroyed, true);
      assert.strictEqual(getServerConn().socket.destroyed, true);
    } finally {
      clientConn.destroy();
      server.closeAllConnections?.();
      server.close();
    }
  });

  it("跳号允许：seq=1/100/500 三条单调递增消息全部被接受，连接保持存活", async () => {
    const { server, getServerConn, serverMessages, clientConn } = await setupStrictPair();
    try {
      sendPing(clientConn, "strict-gap-1", 1);
      sendPing(clientConn, "strict-gap-100", 100);
      sendPing(clientConn, "strict-gap-500", 500);

      await waitFor(() => serverMessages.length === 3);
      assert.deepStrictEqual(
        serverMessages.map((m) => m.id),
        ["strict-gap-1", "strict-gap-100", "strict-gap-500"],
      );

      // 连接保持存活：无协议失败、socket 未销毁
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(clientConn.socket.destroyed, false, "跳号不得销毁连接");
      assert.strictEqual(getServerConn().socket.destroyed, false, "跳号不得销毁连接");
    } finally {
      clientConn.destroy();
      server.closeAllConnections?.();
      server.close();
    }
  });
});
