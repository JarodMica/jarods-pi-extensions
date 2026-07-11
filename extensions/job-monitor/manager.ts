import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JobMonitorConfig } from "./config.ts";
import { makeJobId, pathsFor, refreshJob, saveJob, type JobRecord } from "./store.ts";

const SUPERVISOR_PATH = join(dirname(fileURLToPath(import.meta.url)), "supervisor.mjs");

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function startJob(command: string, cwd: string, config: JobMonitorConfig, options: {
  checkpointMinutes?: number;
  timeoutMinutes?: number;
} = {}): JobRecord {
  const jobId = makeJobId(command);
  const paths = pathsFor(jobId);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.logPath, "", "utf8");

  const now = Date.now();
  let job: JobRecord = {
    jobId,
    command,
    cwd: resolve(cwd),
    startedAt: now,
    status: "starting",
    logPath: paths.logPath,
    metadataPath: paths.metadataPath,
    resultPath: paths.resultPath,
    lastReadOffset: 0,
    lastOutputAt: now,
    timeoutMinutes: Math.max(0, options.timeoutMinutes ?? config.defaultTimeoutMinutes),
    checkpointMinutes: Math.max(0.1, options.checkpointMinutes ?? config.defaultCheckpointMinutes),
  };
  saveJob(job);

  const payloadPath = join(paths.dir, "launch.json");
  writeFileSync(payloadPath, `${JSON.stringify({ jobId, command, cwd: job.cwd, logPath: paths.logPath, resultPath: paths.resultPath }, null, 2)}\n`, "utf8");

  const outFd = openSync(join(paths.dir, "supervisor.log"), "a");
  let supervisor: ChildProcess;
  try {
    supervisor = spawn(process.execPath, [SUPERVISOR_PATH, payloadPath], {
      cwd: job.cwd,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", outFd, outFd],
    });
  } finally {
    closeSync(outFd);
  }
  supervisor.unref();
  if (!supervisor.pid) throw new Error("Supervisor started without a PID");

  job = { ...job, supervisorPid: supervisor.pid, status: "running" };
  saveJob(job);
  return job;
}

export function readLogDelta(job: JobRecord, config: JobMonitorConfig, consume = true): { text: string; nextOffset: number; omitted: number } {
  if (!existsSync(job.logPath)) return { text: "", nextOffset: job.lastReadOffset, omitted: 0 };
  const data = readFileSync(job.logPath);
  const start = Math.min(job.lastReadOffset, data.length);
  const delta = data.subarray(start).toString("utf8");
  const lines = delta.replace(/\r\n/g, "\n").split("\n");
  const selected = lines.slice(-config.tailLines).join("\n");
  let text = selected;
  if (text.length > config.maxResultCharacters) text = text.slice(-config.maxResultCharacters);
  const omitted = Math.max(0, delta.length - text.length);
  const nextOffset = consume ? data.length : job.lastReadOffset;
  return { text, nextOffset, omitted };
}

export function updateLogState(job: JobRecord, nextOffset: number): JobRecord {
  const modified = existsSync(job.logPath) ? statSync(job.logPath).mtimeMs : job.lastOutputAt;
  const next = { ...job, lastReadOffset: nextOffset, lastOutputAt: Math.max(job.lastOutputAt, modified) };
  saveJob(next);
  return next;
}

export function stopJobTree(job: JobRecord, force = false): { ok: boolean; message: string } {
  if (!job.supervisorPid || !isPidAlive(job.supervisorPid)) return { ok: false, message: "Supervisor is not running." };
  if (process.platform === "win32") {
    const args = ["/PID", String(job.supervisorPid), "/T"];
    if (force) args.push("/F");
    const result = spawnSync("taskkill", args, { encoding: "utf8", windowsHide: true });
    return { ok: result.status === 0, message: (result.stdout || result.stderr || `taskkill exit ${result.status}`).trim() };
  }
  try {
    process.kill(-job.supervisorPid, force ? "SIGKILL" : "SIGTERM");
    return { ok: true, message: `Sent ${force ? "SIGKILL" : "SIGTERM"} to process group.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export async function waitForJob(
  initial: JobRecord,
  config: JobMonitorConfig,
  signal: AbortSignal | undefined,
  onProgress?: (job: JobRecord, elapsedMs: number) => void,
): Promise<{ job: JobRecord; reason: "exit" | "checkpoint" | "stall" | "timeout" | "cancelled" }> {
  const startedWaiting = Date.now();
  const checkpointMs = initial.checkpointMinutes * 60_000;
  const timeoutAt = initial.timeoutMinutes > 0 ? initial.startedAt + initial.timeoutMinutes * 60_000 : Number.POSITIVE_INFINITY;

  while (true) {
    let job = refreshJob(initial, isPidAlive);
    const elapsed = Date.now() - job.startedAt;
    onProgress?.(job, elapsed);
    if (!["starting", "running"].includes(job.status)) return { job, reason: "exit" };
    if (signal?.aborted) return { job, reason: "cancelled" };
    if (Date.now() >= timeoutAt) return { job, reason: "timeout" };
    if (config.stallMinutes > 0 && Date.now() - job.lastOutputAt >= config.stallMinutes * 60_000) return { job, reason: "stall" };
    if (Date.now() - startedWaiting >= checkpointMs) return { job, reason: "checkpoint" };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(500, config.pollSeconds * 1000)));
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return [hours ? `${hours}h` : "", minutes || hours ? `${minutes}m` : "", `${remaining}s`].filter(Boolean).join(" ");
}
