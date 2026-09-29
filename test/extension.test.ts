/**
 * 生产入口严格协议模式回归测试
 * 验证默认导出与工厂函数使用 STRICT_PROTOCOL=true 创建管理器
 */

import { describe, it } from "node:test";
import * as assert from "node:assert";
import extensionDefault, {
  STRICT_PROTOCOL,
  createControllerManager,
  createWorkerManager,
} from "../dist/extension.js";
import { FakePiAPI } from "./fake-pi.ts";

describe("生产入口严格协议模式", () => {
  it("STRICT_PROTOCOL 固定为 true", () => {
    assert.strictEqual(STRICT_PROTOCOL, true);
  });

  it("createControllerManager / createWorkerManager 以严格模式创建管理器", async () => {
    const pi = new FakePiAPI();
    const controller = createControllerManager(pi as any);
    const worker = createWorkerManager(pi as any);

    assert.strictEqual((controller as any).strictProtocol, true, "Controller 必须开启严格协议");
    assert.strictEqual((worker as any).strictProtocol, true, "Worker 必须开启严格协议");

    await controller.dispose();
  });

  it("默认导出为扩展入口函数", () => {
    assert.strictEqual(typeof extensionDefault, "function");
  });
});
