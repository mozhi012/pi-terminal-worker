/** 与 supervisor 入口分离的纯校验和可注入父进程监测，便于无终端验证。 */
export function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor) || descriptor.version !== 1) {
    throw new Error("描述符格式不符合规范");
  }
  for (const field of ["controllerId", "workerId", "pipePath", "bootstrapToken"]) {
    if (typeof descriptor[field] !== "string") throw new Error(`描述符字段非法: ${field}`);
  }
  if (descriptor.role !== undefined && descriptor.role !== "worker" && descriptor.role !== "lead") {
    throw new Error("描述符 role 必须是 worker 或 lead");
  }
  if (descriptor.ownerPid !== undefined && (!Number.isSafeInteger(descriptor.ownerPid) || descriptor.ownerPid <= 0)) {
    throw new Error("描述符 ownerPid 必须是正整数");
  }
  return descriptor;
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // 权限不足并不意味着进程已死；只在明确不存在时执行级联终止。
    return error?.code !== "ESRCH";
  }
}

/** 仅带 ownerPid 的 L2 启用；stop 幂等，owner 消失后最多通知一次。 */
export function monitorOwner(ownerPid, onOwnerLost, {
  isAlive = isProcessAlive,
  schedule = setInterval,
  cancel = clearInterval,
  intervalMs = 4000,
} = {}) {
  if (ownerPid === undefined) return () => {};
  let stopped = false;
  const timer = schedule(() => {
    if (stopped || isAlive(ownerPid)) return;
    stop();
    onOwnerLost();
  }, intervalMs);
  timer.unref?.();
  function stop() {
    if (stopped) return;
    stopped = true;
    cancel(timer);
  }
  return stop;
}
