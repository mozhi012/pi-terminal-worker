import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as path from "node:path";
import {
  encodeDescriptor,
  decodeDescriptor,
  buildWtArgs,
  validateAndPrepareLaunch,
  type WorkerDescriptor,
} from "../dist/launcher.js";

describe("Launcher and Descriptor Tests", () => {
  it("WorkerDescriptor 能正确进行 Base64Url 编解码且内容完全一致", () => {
    const desc: WorkerDescriptor = {
      version: 1,
      controllerId: "ctrl-abc-123",
      workerId: "worker-xyz-789",
      pipePath: "\\\\.\\pipe\\pi-terminal-worker-test",
      bootstrapToken: "secret_token_256_bit_random_hex",
    };

    const encoded = encodeDescriptor(desc);
    assert.strictEqual(typeof encoded, "string");
    assert.ok(!encoded.includes("+") && !encoded.includes("/")); // base64url

    const decoded = decodeDescriptor(encoded);
    assert.deepStrictEqual(decoded, desc);
  });

  it("buildWtArgs 组装正确的 Windows Terminal 命令行参数结构", () => {
    const args = buildWtArgs(
      "Worker Terminal",
      "E:\\web\\project",
      "node.exe",
      "bootstrap.mjs",
      "descriptorBase64Url",
    );

    assert.deepStrictEqual(args, [
      "-w",
      "new",
      "new-tab",
      "--title",
      "Worker Terminal",
      "-d",
      "E:\\web\\project",
      "node.exe",
      "bootstrap.mjs",
      "--descriptor",
      "descriptorBase64Url",
    ]);
  });

  it("validateAndPrepareLaunch 严格拒绝不合法的 cwd 路径", () => {
    process.env.PI_TEST_MOCK_PLATFORM = "win32";
    // 相对路径
    assert.throws(
      () => validateAndPrepareLaunch("relative/path"),
      /cwd 必须是绝对路径/,
    );

    // 不存在的目录
    const nonExistentPath = path.resolve(process.cwd(), "non_existent_dir_12345678");
    assert.throws(
      () => validateAndPrepareLaunch(nonExistentPath),
      /指定的 cwd 不存在/,
    );
  });
});
