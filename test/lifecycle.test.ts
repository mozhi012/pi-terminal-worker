import { describe, it } from "node:test";
import * as assert from "node:assert";
import {
  SessionGenerationManager,
  CleanupRegistry,
} from "../dist/lifecycle.js";

describe("Lifecycle and Generation Tests", () => {
  it("SessionGenerationManager 正确维护会话代际并防止失效回调", () => {
    const genMgr = new SessionGenerationManager();
    assert.strictEqual(genMgr.generation, 0);

    const gen1 = genMgr.nextGeneration();
    assert.strictEqual(gen1, 1);
    assert.strictEqual(genMgr.isValid(gen1), true);

    const gen2 = genMgr.nextGeneration();
    assert.strictEqual(gen2, 2);
    assert.strictEqual(genMgr.isValid(gen1), false);
    assert.strictEqual(genMgr.isValid(gen2), true);
  });

  it("CleanupRegistry 能幂等执行全部资源释放逻辑", async () => {
    const registry = new CleanupRegistry();
    let cleanedA = 0;
    let cleanedB = 0;

    registry.register(() => {
      cleanedA++;
    });
    registry.register(async () => {
      cleanedB++;
    });

    await registry.disposeAll();
    assert.strictEqual(cleanedA, 1);
    assert.strictEqual(cleanedB, 1);

    // 重复调用不重复执行
    await registry.disposeAll();
    assert.strictEqual(cleanedA, 1);
    assert.strictEqual(cleanedB, 1);
  });
});
