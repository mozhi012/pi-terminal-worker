/**
 * pi-terminal-worker supervisor bootstrap
 * 随包发布的固定 ES 模块，运行在独立终端窗口中，作为子进程的 supervisor。
 */

import * as net from "node:net";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

function parseArgs() {
  const args = process.argv.slice(2);
  let descriptorB64 = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--descriptor" && i + 1 < args.length) {
      descriptorB64 = args[i + 1];
      break;
    }
  }
  if (!descriptorB64) {
    console.error("[bootstrap] 错误: 缺少 --descriptor 参数");
    process.exit(1);
  }

  try {
    const json = Buffer.from(descriptorB64, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch (err) {
    console.error("[bootstrap] 描述符解析失败:", err.message);
    process.exit(1);
  }
}

const descriptor = parseArgs();
const { controllerId, workerId, pipePath, bootstrapToken } = descriptor;

let socket = null;
let seq = 0;
let childProcess = null;
let isExiting = false;

function sendEnvelope(type, payload, replyTo) {
  if (!socket || socket.destroyed) return;
  const env = {
    version: 1,
    controllerId,
    workerId,
    id: crypto.randomUUID(),
    replyTo,
    seq: ++seq,
    type,
    payload,
  };
  socket.write(JSON.stringify(env) + "\n", "utf8");
}

function sendAck(replyTo, ok, error, code) {
  sendEnvelope("ack", { id: replyTo, ok, error, code }, replyTo);
}

function terminateChild(force) {
  if (!childProcess || childProcess.killed) return;
  if (force && process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(childProcess.pid)], {
        stdio: "ignore",
      });
    } catch {
      childProcess.kill("SIGKILL");
    }
  } else {
    childProcess.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

function handleEnvelope(envelope) {
  const { id, type, payload } = envelope;

  if (type === "hello_ok") {
    // 握手完成，等待 controller 发送 launch 指令
    return;
  }

  if (type === "ping") {
    sendEnvelope("pong", { timestamp: Date.now(), replyTimestamp: payload.timestamp }, id);
    return;
  }

  if (type === "launch") {
    try {
      const { cwd, nodePath, piCliPath, workerToken, workerPipePath } = payload;
      
      childProcess = spawn(nodePath, [piCliPath], {
        cwd,
        stdio: "inherit",
        shell: false,
        env: {
          ...process.env,
          PI_TERMINAL_WORKER_ROLE: "worker",
          PI_TERMINAL_WORKER_CONTROLLER_ID: controllerId,
          PI_TERMINAL_WORKER_WORKER_ID: workerId,
          PI_TERMINAL_WORKER_PIPE_PATH: workerPipePath,
          PI_TERMINAL_WORKER_TOKEN: workerToken,
        },
      });

      sendAck(id, true);

      childProcess.on("error", (err) => {
        sendEnvelope("launch_failed", { error: err.message });
      });

      childProcess.on("spawn", () => {
        sendEnvelope("child_spawned", { pid: childProcess.pid });
      });

      childProcess.on("exit", (code, signal) => {
        isExiting = true;
        sendEnvelope("child_exit", {
          pid: childProcess ? childProcess.pid : 0,
          code,
          signal,
        });

        // 留出时间让退出消息刷入管道，然后退出
        setTimeout(() => {
          if (socket) socket.destroy();
          process.exit(code ?? 0);
        }, 300);
      });
    } catch (err) {
      sendAck(id, false, err.message, "LAUNCH_FAILED");
      sendEnvelope("launch_failed", { error: err.message });
    }
    return;
  }

  if (type === "terminate") {
    sendAck(id, true);
    terminateChild(payload && payload.force);
    return;
  }
}

// 连接主控端的命名管道，带短暂重试
let retryCount = 0;
const maxRetries = 15;

function connectToController() {
  socket = net.createConnection(pipePath);

  const decoder = new StringDecoder("utf8");
  let buffer = "";

  socket.on("connect", () => {
    // 发送 hello 进行 supervisor 认证
    sendEnvelope("hello", {
      role: "supervisor",
      token: bootstrapToken,
      controllerId,
      workerId,
    });
  });

  socket.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length === 0) continue;
      try {
        const envelope = JSON.parse(line);
        handleEnvelope(envelope);
      } catch (err) {
        console.error("[bootstrap] 消息解析异常:", err.message);
      }
    }
  });

  socket.on("error", (err) => {
    if (retryCount < maxRetries && !childProcess && !isExiting) {
      retryCount++;
      setTimeout(connectToController, 300);
      return;
    }
    if (!isExiting) {
      console.error("[bootstrap] 管道通信错误:", err.message);
    }
  });

  socket.on("close", () => {
    if (!isExiting && childProcess && !childProcess.killed) {
      // 主控端断开连接，保留当前子进程运行供人工查看，supervisor 结束监听
    }
  });
}

connectToController();
