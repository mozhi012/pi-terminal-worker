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
  let title = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--descriptor" && i + 1 < args.length) {
      descriptorB64 = args[i + 1];
    } else if (args[i] === "--title" && i + 1 < args.length) {
      title = args[i + 1];
    }
  }
  if (!descriptorB64) {
    console.error("[bootstrap] 错误: 缺少 --descriptor 参数");
    process.exit(1);
  }

  try {
    const json = Buffer.from(descriptorB64, "base64url").toString("utf8");
    return { descriptor: JSON.parse(json), title };
  } catch (err) {
    console.error("[bootstrap] 描述符解析失败:", err.message);
    process.exit(1);
  }
}

const parsed = parseArgs();
const descriptor = parsed.descriptor;
const { controllerId, workerId, pipePath, bootstrapToken } = descriptor;

// PS/CMD 回退后端下由本进程设置新控制台窗口标题 (WT 后端用 --title，不受影响)
if (process.platform === "win32" && parsed.title) {
  try {
    process.title = parsed.title;
  } catch {}
}

let socket = null;
let seq = 0;
let childProcess = null;
let isExiting = false;
/** 是否已完成 hello_ok 认证；未认证前拒绝 launch/terminate */
let authenticated = false;
/** 是否已发起过 launch；用独立布尔避免 spawn 抛错后仍可重复启动 */
let launchRequested = false;

/** 接收缓冲上限：超过即停止累积并销毁连接 (2 MiB) */
const MAX_RECV_BUFFER_BYTES = 2 * 1024 * 1024;

function isNonEmptyString(value, maxLen) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLen;
}

/**
 * 严格校验 launch payload，返回 { ok: true } 或 { ok: false, field }。
 * 缺失/类型错误/超长都视为校验失败。
 */
function validateLaunchPayload(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, field: "payload" };
  }
  for (const field of ["cwd", "nodePath", "piCliPath", "extensionPath", "workerPipePath"]) {
    if (!isNonEmptyString(payload[field], 4096)) {
      return { ok: false, field };
    }
  }
  if (!isNonEmptyString(payload.workerToken, 512)) {
    return { ok: false, field: "workerToken" };
  }
  for (const field of ["provider", "model", "thinkingLevel"]) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    if (!isNonEmptyString(value, 512)) {
      return { ok: false, field };
    }
  }
  return { ok: true };
}

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
    // 握手完成，标记已认证，等待 controller 发送 launch 指令
    authenticated = true;
    return;
  }

  if (type === "ping") {
    sendEnvelope("pong", { timestamp: Date.now(), replyTimestamp: payload.timestamp }, id);
    return;
  }

  if (type === "launch") {
    if (!authenticated) {
      sendAck(id, false, "连接尚未完成认证", "AUTH_FAILED");
      return;
    }
    if (launchRequested) {
      sendAck(id, false, "已存在子进程，拒绝重复 launch", "ALREADY_EXISTS");
      return;
    }
    const validation = validateLaunchPayload(payload);
    if (!validation.ok) {
      const message = `launch payload 校验失败: ${validation.field}`;
      sendAck(id, false, message, "PROTOCOL_ERROR");
      sendEnvelope("launch_failed", { error: message });
      return;
    }
    // 先置位再 spawn：spawn 抛错后也不允许再次 launch，避免重复子进程歧义
    launchRequested = true;
    try {
      const { cwd, nodePath, piCliPath, extensionPath, workerToken, workerPipePath, provider, model, thinkingLevel } = payload;

      // 可选模型参数：不传时保持 Pi 默认设置，不硬编码任何模型
      const cliArgs = [piCliPath, "--no-extensions", "-e", extensionPath];
      if (provider) cliArgs.push("--provider", String(provider));
      if (model) cliArgs.push("--model", String(model));
      if (thinkingLevel) cliArgs.push("--thinking", String(thinkingLevel));

      childProcess = spawn(nodePath, cliArgs, {
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
    if (!authenticated) {
      sendAck(id, false, "连接尚未完成认证", "AUTH_FAILED");
      return;
    }
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
    if (Buffer.byteLength(buffer, "utf8") > MAX_RECV_BUFFER_BYTES) {
      console.error("[bootstrap] 错误: 接收缓冲超过 2 MiB 上限，停止累积并销毁连接");
      try {
        socket.destroy();
      } catch {}
      if (!childProcess) {
        // 无子进程时留着一个没有通信对象的窗口没有意义
        process.exit(1);
      }
      return;
    }
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
