// Native shell parsing check. Start-Process is stubbed and CMD start is replaced
// with echo: this script does not open a terminal or launch a Worker.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { buildTerminalLaunch } from '../../src/launcher.ts';

const env = {
  terminal: { backend: 'powershell', command: 'powershell.exe' },
  nodePath: String.raw`D:\Program Files\nodejs\node.exe`,
  piCliPath: 'cli.js', extensionPath: 'ext',
  bootstrapPath: String.raw`E:\中文 & %PATH% !\bootstrap.mjs`,
  cwd: String.raw`E:\目录 & %PATH% !\O'Brien`,
};
const spec = buildTerminalLaunch(env, 'Review & %PATH% !', 'verification_descriptor');
const generated = Buffer.from(spec.args.at(-1), 'base64').toString('utf16le');
const stub = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Start-Process {
  [CmdletBinding()]
  param([string]$FilePath,[string]$WorkingDirectory,[string]$WindowStyle,[string[]]$ArgumentList)
  [pscustomobject]@{file=$FilePath;cwd=$WorkingDirectory;style=$WindowStyle;arguments=$ArgumentList} | ConvertTo-Json -Compress
}
`;
const ps = spawnSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-EncodedCommand',
  Buffer.from(stub + generated, 'utf16le').toString('base64'),
], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
assert.equal(ps.status, 0, ps.stderr);
const parsed = JSON.parse(ps.stdout.replace(/^\uFEFF/, ''));
assert.equal(parsed.file, env.nodePath);
assert.equal(parsed.cwd, env.cwd);
assert.equal(parsed.style, 'Normal');
assert.ok(parsed.arguments[0].includes(env.bootstrapPath));

const cmdSpec = buildTerminalLaunch({
  ...env, terminal: { backend: 'cmd', command: 'cmd.exe' },
}, 'Review & %PATH% !', 'verification_descriptor');
const cmd = spawnSync('cmd.exe', [
  '/u', ...cmdSpec.args.slice(0, -1), cmdSpec.args.at(-1).replace(/^start /, 'echo '),
], {
  env: { ...process.env, ...cmdSpec.extraEnv },
  windowsHide: true, windowsVerbatimArguments: true, timeout: 10000,
});
assert.equal(cmd.status, 0, cmd.stderr?.toString());
const echoed = cmd.stdout.toString('utf16le');
assert.ok(echoed.includes('"Review & %PATH% !"'), echoed);
assert.ok(echoed.includes(env.bootstrapPath), echoed);
assert.ok(echoed.includes(env.cwd), echoed);
console.log('Native PowerShell parameter binding and CMD single expansion passed; no terminal or Worker launched.');
