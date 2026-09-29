import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as path from "node:path";
import {
  encodeDescriptor,
  decodeDescriptor,
  buildWtArgs,
  buildTerminalLaunch,
  launchWorkerWindow,
  detectTerminalBackend,
  detectTerminalBackends,
  validateAndPrepareLaunch,
  psQuote,
  windowsQuoted,
  assertCmdSafeValues,
  type WorkerDescriptor,
  type LaunchEnvironment,
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

  it("detectTerminalBackend 按 WT → PowerShell → CMD 顺序回退，全部缺失返回 null", () => {
    const all = {
      findWt: () => "wt.exe",
      findPowershell: () => "powershell.exe",
      findCmd: () => "cmd.exe",
    };
    assert.deepStrictEqual(detectTerminalBackend(all), { backend: "wt", command: "wt.exe" });
    assert.deepStrictEqual(detectTerminalBackend({ ...all, findWt: () => null }), {
      backend: "powershell",
      command: "powershell.exe",
    });
    assert.deepStrictEqual(detectTerminalBackend({ ...all, findWt: () => null, findPowershell: () => null }), {
      backend: "cmd",
      command: "cmd.exe",
    });
    assert.strictEqual(detectTerminalBackend({ findWt: () => null, findPowershell: () => null, findCmd: () => null }), null);
  });

  it("detectTerminalBackends 保留所有可用后端供明确 spawn 失败时回退", () => {
    assert.deepStrictEqual(detectTerminalBackends({
      findWt: () => "wt.exe",
      findPowershell: () => "powershell.exe",
      findCmd: () => "cmd.exe",
    }), [
      { backend: "wt", command: "wt.exe" },
      { backend: "powershell", command: "powershell.exe" },
      { backend: "cmd", command: "cmd.exe" },
    ]);
  });
  it("validateAndPrepareLaunch 无任何后端时明确失败，可注入探测选 PowerShell 后端", () => {
    process.env.PI_TEST_MOCK_PLATFORM = "win32";
    const none = { findWt: () => null, findPowershell: () => null, findCmd: () => null };
    assert.throws(
      () => validateAndPrepareLaunch(process.cwd(), none),
      /未找到可用的终端后端/,
    );
    const env = validateAndPrepareLaunch(process.cwd(), {
      findWt: () => null,
      findPowershell: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      findCmd: () => null,
    });
    assert.strictEqual(env.terminal.backend, "powershell");
  });

  it("PowerShell 回退：短命隐藏宿主 Start-Process 新控制台，ArgumentList 做 Windows 引号处理", () => {
    const env: LaunchEnvironment = {
      terminal: { backend: "powershell", command: "powershell.exe" },
      nodePath: "D:\\Program Files\\nodejs\\node.exe",
      piCliPath: "cli.js",
      extensionPath: "ext",
      bootstrapPath: "D:\\My Folder\\bootstrap.mjs",
      cwd: "E:\\web\\工作 目录 50%&x\\子'目录",
    };
    const spec = buildTerminalLaunch(env, "Worker 窗口 & 测试 \"引号\" 换行\n行", "descB64_-=");
    assert.strictEqual(spec.command, "powershell.exe");
    assert.strictEqual(spec.windowsHide, true, "短命宿主必须隐藏");
    assert.strictEqual(spec.windowsVerbatimArguments, undefined);
    const idx = spec.args.indexOf("-EncodedCommand");
    assert.ok(idx > 0);
    const script = Buffer.from(spec.args[idx + 1], "base64").toString("utf16le");
    assert.ok(script.startsWith("Start-Process -FilePath 'D:\\Program Files\\nodejs\\node.exe'"));
    assert.ok(script.includes("-WorkingDirectory 'E:\\web\\工作 目录 50%&x\\子''目录'"));
    assert.ok(script.includes("-WindowStyle Normal -ErrorAction Stop"));
    // ArgumentList 是单引号 PS 字符串，内部是 Windows 引号拼串：路径含空格/中文必须带 \"
    assert.ok(script.includes("-ArgumentList '"));
    assert.ok(script.includes('"D:\\My Folder\\bootstrap.mjs" --descriptor descB64_-='));
    assert.ok(script.includes('--title "Worker 窗口 & 测试 \\"引号\\" 换行 行"'));
  });

  it("CMD 回退：固定 %ENV_*% 命令串 + /s /c + verbatim，值放受控 env 字段", () => {
    const env: LaunchEnvironment = {
      terminal: { backend: "cmd", command: "C:\\Windows\\System32\\cmd.exe" },
      nodePath: "D:\\Program Files\\nodejs\\node.exe",
      piCliPath: "cli.js",
      extensionPath: "ext",
      bootstrapPath: "b.mjs",
      cwd: "E:\\cwd 50%&test",
    };
    const spec = buildTerminalLaunch(env, "Win & Title !x", "descB64");
    assert.deepStrictEqual(spec.args, [
      "/d",
      "/v:off",
      "/s",
      "/c",
      `start "%ENV_TITLE%" /D "%ENV_CWD%" "%ENV_NODE%" "%ENV_BOOT%" --descriptor %ENV_DESC%`,
    ]);
    assert.strictEqual(spec.windowsVerbatimArguments, true);
    assert.deepStrictEqual(spec.extraEnv, {
      ENV_TITLE: "Win & Title !x",
      ENV_CWD: "E:\\cwd 50%&test",
      ENV_NODE: "D:\\Program Files\\nodejs\\node.exe",
      ENV_BOOT: "b.mjs",
      ENV_DESC: "descB64",
    });
  });

  it("CMD 后端拒绝值中的双引号/CR/LF/NUL，不做 %% 或 ^ 转义", () => {
    const env: LaunchEnvironment = {
      terminal: { backend: "cmd", command: "cmd.exe" },
      nodePath: "node.exe",
      piCliPath: "cli.js",
      extensionPath: "ext",
      bootstrapPath: "b.mjs",
      cwd: "E:\\proj",
    };
    assert.throws(() => buildTerminalLaunch(env, 'Bad "Title"', "d"), /双引号/);
    assert.throws(() => buildTerminalLaunch(env, "Bad\nTitle", "d"), /双引号/);
    assert.throws(() => buildTerminalLaunch(env, "Bad\rTitle", "d"), /双引号/);
    assert.throws(() => buildTerminalLaunch(env, "Bad\0Title", "d"), /双引号/);
    // 原生 & % ! 在引号与单次 env 展开中保留，无需转义
    const spec = buildTerminalLaunch(env, "A & B 50% !x", "d");
    assert.strictEqual(spec.extraEnv!.ENV_TITLE, "A & B 50% !x");
    assert.throws(() => assertCmdSafeValues([["t", 'a"b']]), /双引号/);
    assert.doesNotThrow(() => assertCmdSafeValues([["t", "a & b % c ! d"]]) );
  });

  it("psQuote/windowsQuoted 转义规则", () => {
    assert.strictEqual(psQuote("a'b"), "'a''b'");
    assert.strictEqual(windowsQuoted('a"b c'), '"a\\"b c"');
    assert.strictEqual(windowsQuoted("plain"), '"plain"');
  });

  it("launchWorkerWindow 可注入 spawnFn，不实际开窗，透传 env 与 verbatim/hidden 标志", () => {
    const cmdEnv: LaunchEnvironment = {
      terminal: { backend: "cmd", command: "cmd.exe" },
      nodePath: "node.exe",
      piCliPath: "cli.js",
      extensionPath: "ext",
      bootstrapPath: "b.mjs",
      cwd: "E:\\proj",
    };
    const cmdSpec = buildTerminalLaunch(cmdEnv, "T", "d");
    const calls: Array<{ command: string; args: string[]; options: any }> = [];
    launchWorkerWindow(cmdSpec, {
      spawnFn: (command, args, options) => {
        calls.push({ command, args, options });
        return {} as any;
      },
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].command, "cmd.exe");
    assert.strictEqual(calls[0].options.shell, false);
    assert.strictEqual(calls[0].options.windowsHide, false);
    assert.strictEqual(calls[0].options.windowsVerbatimArguments, true);
    assert.strictEqual(calls[0].options.cwd, "E:\\proj");
    assert.strictEqual(calls[0].options.env.ENV_DESC, "d");
    assert.strictEqual(calls[0].options.env.PATH, process.env.PATH);

    // PS 后端：短命隐藏宿主
    const psEnv: LaunchEnvironment = { ...cmdEnv, terminal: { backend: "powershell", command: "powershell.exe" } };
    const psSpec = buildTerminalLaunch(psEnv, "T", "d");
    launchWorkerWindow(psSpec, {
      spawnFn: (_command, _args, options) => {
        calls.push({ command: "ps", args: [], options });
        return {} as any;
      },
    });
    assert.strictEqual(calls[1].options.windowsHide, true);
    assert.strictEqual(calls[1].options.windowsVerbatimArguments, false);
  });

  it("launchWorkerWindow 无 extraEnv 时不覆盖环境变量", () => {
    const env: LaunchEnvironment = {
      terminal: { backend: "wt", command: "wt.exe" },
      nodePath: "node.exe",
      piCliPath: "cli.js",
      extensionPath: "ext",
      bootstrapPath: "b.mjs",
      cwd: "E:\\proj",
    };
    const spec = buildTerminalLaunch(env, "T", "d");
    const calls: Array<{ options: any }> = [];
    launchWorkerWindow(spec, {
      spawnFn: (_command, _args, options) => {
        calls.push({ options });
        return {} as any;
      },
    });
    assert.strictEqual(calls[0].options.env, undefined);
    assert.strictEqual(calls[0].options.windowsVerbatimArguments, false);
  });
});
