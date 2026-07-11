import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { JOBS_DIR } from "./config.ts";

export type JobStatus = "starting" | "running" | "completed" | "failed" | "stopped" | "timed_out" | "unknown";

export interface JobRecord {
  jobId: string;
  supervisorPid?: number;
  command: string;
  cwd: string;
  startedAt: number;
  finishedAt?: number;
  status: JobStatus;
  exitCode?: number | null;
  signal?: string | null;
  logPath: string;
  metadataPath: string;
  resultPath: string;
  lastReadOffset: number;
  lastOutputAt: number;
  timeoutMinutes: number;
  checkpointMinutes: number;
}

export function jobDir(jobId: string): string {
  return join(JOBS_DIR, jobId);
}

export function pathsFor(jobId: string) {
  const dir = jobDir(jobId);
  return {
    dir,
    metadataPath: join(dir, "metadata.json"),
    logPath: join(dir, "output.log"),
    resultPath: join(dir, "result.json"),
  };
}

export function saveJob(job: JobRecord): void {
  mkdirSync(jobDir(job.jobId), { recursive: true });
  const temp = `${job.metadataPath}.tmp`;
  writeFileSync(temp, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  renameSync(temp, job.metadataPath);
}

export function loadJob(jobId: string): JobRecord | null {
  const path = pathsFor(jobId).metadataPath;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JobRecord;
  } catch {
    return null;
  }
}

export function listJobs(): JobRecord[] {
  if (!existsSync(JOBS_DIR)) return [];
  return readdirSync(JOBS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadJob(entry.name))
    .filter((job): job is JobRecord => job !== null)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function readResult(job: JobRecord): Partial<JobRecord> | null {
  if (!existsSync(job.resultPath)) return null;
  try {
    return JSON.parse(readFileSync(job.resultPath, "utf8")) as Partial<JobRecord>;
  } catch {
    return null;
  }
}

export function refreshJob(job: JobRecord, isPidAlive: (pid: number) => boolean): JobRecord {
  const result = readResult(job);
  if (result) {
    const next = { ...job, ...result } as JobRecord;
    if (JSON.stringify(next) !== JSON.stringify(job)) saveJob(next);
    return next;
  }

  if ((job.status === "starting" || job.status === "running") && job.supervisorPid && !isPidAlive(job.supervisorPid)) {
    const next = { ...job, status: "unknown" as const, finishedAt: Date.now() };
    saveJob(next);
    return next;
  }

  if (existsSync(job.logPath)) {
    const modified = statSync(job.logPath).mtimeMs;
    if (modified > job.lastOutputAt) {
      const next = { ...job, lastOutputAt: modified };
      saveJob(next);
      return next;
    }
  }
  return job;
}

export function makeJobId(command: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const label = basename(command.trim().split(/\s+/)[0] || "job").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 24);
  return `${label || "job"}-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}
