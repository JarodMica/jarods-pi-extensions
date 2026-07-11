import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CONFIG_PATH, loadConfig, saveConfig, type AnalysisTrigger, type JobMonitorConfig } from "./config.ts";
import { formatDuration, isPidAlive, readLogDelta, startJob, stopJobTree, updateLogState, waitForJob } from "./manager.ts";
import { listJobs, loadJob, refreshJob, saveJob, type JobRecord } from "./store.ts";

const Action = StringEnum(["run", "start", "wait", "status", "list", "stop"] as const);

const Parameters = Type.Object({
  action: Action,
  command: Type.Optional(Type.String({ description: "Shell command or batch script to launch (run/start only)" })),
  jobId: Type.Optional(Type.String({ description: "Monitored job ID (wait/status/stop)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory; defaults to Pi's current cwd" })),
  checkpointMinutes: Type.Optional(Type.Number({ description: "Minutes before returning a progress checkpoint. Use 0 to wait until exit/stall/timeout." })),
  timeoutMinutes: Type.Optional(Type.Number({ description: "Maximum total runtime in minutes. Use 0 for no timeout." })),
  force: Type.Optional(Type.Boolean({ description: "Force process-tree termination for stop" })),
  analyze: Type.Optional(Type.Boolean({ description: "Override configured secondary-model analysis for this result" })),
});

type WaitReason = "exit" | "checkpoint" | "stall" | "timeout" | "cancelled";

type MonitorParams = {
  action: "run" | "start" | "wait" | "status" | "list" | "stop";
  command?: string;
  jobId?: string;
  cwd?: string;
  checkpointMinutes?: number;
  timeoutMinutes?: number;
  force?: boolean;
  analyze?: boolean;
};

function requireJob(jobId: string | undefined): JobRecord {
  if (!jobId) throw new Error("jobId is required for this action");
  const job = loadJob(jobId);
  if (!job) throw new Error(`Unknown monitored job: ${jobId}`);
  return job;
}

function shouldAnalyze(config: JobMonitorConfig, reason: WaitReason, job: JobRecord, override?: boolean): boolean {
  if (override === false) return false;
  if (override === true) return Boolean(config.analysis.model);
  if (!config.analysis.enabled || !config.analysis.model) return false;
  const trigger: AnalysisTrigger = config.analysis.trigger;
  if (trigger === "always") return true;
  if (trigger === "on-exit") return reason === "exit";
  if (trigger === "on-error") return reason === "timeout" || reason === "stall" || job.status === "failed" || job.status === "unknown";
  if (trigger === "on-stall") return reason === "stall";
  return false;
}

function formatJobLine(job: JobRecord): string {
  const elapsed = formatDuration((job.finishedAt ?? Date.now()) - job.startedAt);
  return `${job.jobId}  ${job.status}  PID ${job.supervisorPid ?? "?"}  ${elapsed}  ${job.command}`;
}

function makePiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) return { command: process.execPath, args: [currentScript, ...args] };
  return { command: "pi", args };
}

export default function jobMonitorExtension(pi: ExtensionAPI) {
  let config = loadConfig();

  async function analyzeResult(job: JobRecord, reason: WaitReason, output: string, signal?: AbortSignal): Promise<string | null> {
    const model = config.analysis.model;
    if (!model) return null;
    const clipped = output.slice(-config.analysis.maxInputCharacters);
    const prompt = [
      "Analyze this monitored job update. Be concise and do not run tools.",
      "State whether it is progressing, completed, failed, stalled, or needs intervention, and give the next recommended action.",
      `Job: ${job.jobId}`,
      `Command: ${job.command}`,
      `Status: ${job.status}`,
      `Monitor reason: ${reason}`,
      `Exit code: ${String(job.exitCode ?? "unknown")}`,
      "Output:",
      clipped || "(no new output)",
    ].join("\n");
    const invocation = makePiInvocation([
      "--mode", "text", "-p", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-tools",
      "--model", model, "--thinking", config.analysis.thinkingLevel, prompt,
    ]);
    try {
      const result = await pi.exec(invocation.command, invocation.args, {
        signal,
        timeout: config.analysis.timeoutSeconds * 1000,
      });
      if (result.code !== 0) return `Secondary monitor model failed: ${(result.stderr || result.stdout).trim()}`;
      return result.stdout.trim() || null;
    } catch (error) {
      return `Secondary monitor model failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function buildResult(jobInput: JobRecord, reason: WaitReason, analyzeOverride?: boolean, signal?: AbortSignal) {
    let job = refreshJob(jobInput, isPidAlive);
    if (reason === "timeout" && ["starting", "running"].includes(job.status)) {
      const stopped = stopJobTree(job, false);
      job = { ...job, status: "timed_out", finishedAt: Date.now() };
      saveJob(job);
      if (config.verbose && !stopped.ok) console.error(`[job-monitor] timeout stop failed: ${stopped.message}`);
    }

    const delta = readLogDelta(job, config, true);
    job = updateLogState(job, delta.nextOffset);
    const analysis = shouldAnalyze(config, reason, job, analyzeOverride)
      ? await analyzeResult(job, reason, delta.text, signal)
      : null;
    const elapsed = formatDuration((job.finishedAt ?? Date.now()) - job.startedAt);
    const lines = [
      `Job ${job.jobId}: ${job.status}`,
      `Reason: ${reason}`,
      `PID: ${job.supervisorPid ?? "unknown"}`,
      `Elapsed: ${elapsed}`,
      `Exit code: ${job.exitCode ?? "unknown"}`,
      `Log: ${job.logPath}`,
    ];
    if (reason === "checkpoint") lines.push("The job is still running. Call monitor_job with action=wait to continue monitoring.");
    if (reason === "cancelled") lines.push("Monitoring wait was cancelled; the job was left running.");
    if (delta.text.trim()) lines.push("", "New output:", delta.text.trim());
    if (delta.omitted > 0) lines.push(`[${delta.omitted} output characters omitted; inspect the full log if needed.]`);
    if (analysis) lines.push("", "Secondary monitor analysis:", analysis);
    if (config.verbose) lines.push("", `Metadata: ${job.metadataPath}`, `Result: ${job.resultPath}`);
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      details: { job, reason, analysis, omittedCharacters: delta.omitted },
    };
  }

  async function waitAndReport(job: JobRecord, analyzeOverride: boolean | undefined, signal: AbortSignal | undefined, onUpdate: any) {
    const effective = job.checkpointMinutes === 0 ? { ...job, checkpointMinutes: Number.MAX_SAFE_INTEGER / 60_000 } : job;
    const result = await waitForJob(effective, config, signal, (current, elapsed) => {
      onUpdate?.({
        content: [{ type: "text", text: `Monitoring ${current.jobId} (${current.status}, ${formatDuration(elapsed)})` }],
        details: { job: current, reason: "waiting" },
      });
    });
    return buildResult(result.job, result.reason, analyzeOverride, signal);
  }

  (pi.registerTool as (tool: unknown) => unknown)({
    name: "monitor_job",
    label: "Monitor Job",
    description: "Launch and monitor long-running local commands or batch scripts. Use action=run instead of bash when later work depends on the command's eventual output. run/wait consumes no model tokens while waiting and returns when the process exits, stalls, times out, is cancelled, or reaches a requested checkpoint. Output is persisted and only a bounded delta is returned.",
    promptSnippet: "Launch, wait on, inspect, or stop long-running local jobs",
    promptGuidelines: [
      "Use monitor_job with action=run for long-running scripts whose eventual output determines subsequent work; after it returns, analyze the result and continue the requested workflow when appropriate.",
      "Use monitor_job action=wait again when a running job returns a checkpoint and further work depends on its completion.",
    ],
    parameters: Parameters,
    async execute(_toolCallId: string, params: MonitorParams, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
      config = loadConfig();
      switch (params.action) {
        case "run": {
          if (!params.command?.trim()) throw new Error("command is required for action=run");
          const job = startJob(params.command.trim(), resolve(ctx.cwd, params.cwd ?? "."), config, params);
          return waitAndReport(job, params.analyze, signal, onUpdate);
        }
        case "start": {
          if (!params.command?.trim()) throw new Error("command is required for action=start");
          const job = startJob(params.command.trim(), resolve(ctx.cwd, params.cwd ?? "."), config, params);
          return {
            content: [{ type: "text", text: `Started monitored job ${job.jobId}\nPID: ${job.supervisorPid}\nLog: ${job.logPath}\nUse monitor_job action=wait with this jobId to resume when it changes.` }],
            details: { job },
          };
        }
        case "wait":
          return waitAndReport(requireJob(params.jobId), params.analyze, signal, onUpdate);
        case "status":
          return buildResult(refreshJob(requireJob(params.jobId), isPidAlive), "checkpoint", params.analyze, signal);
        case "list": {
          const jobs = listJobs().map((job) => refreshJob(job, isPidAlive));
          const text = jobs.length ? jobs.slice(0, 30).map(formatJobLine).join("\n") : "No monitored jobs found.";
          return { content: [{ type: "text", text }], details: { jobs } };
        }
        case "stop": {
          let job = refreshJob(requireJob(params.jobId), isPidAlive);
          const result = stopJobTree(job, params.force ?? false);
          if (result.ok) {
            job = { ...job, status: "stopped", finishedAt: Date.now() };
            saveJob(job);
          }
          return { content: [{ type: "text", text: `${result.ok ? "Stopped" : "Could not stop"} ${job.jobId}: ${result.message}` }], details: { job, result } };
        }
        default:
          throw new Error(`Unknown monitor_job action: ${String((params as { action?: unknown }).action)}`);
      }
    },
    renderCall(args: MonitorParams, theme: any, context: any) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold("monitor_job ")) + theme.fg("accent", args.action) + (args.jobId ? theme.fg("muted", ` ${args.jobId}`) : ""));
      return text;
    },
    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any, context: any) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const raw = result.content.find((item: { type?: string; text?: string }) => item.type === "text")?.text ?? "";
      const lines = raw.split("\n");
      text.setText((expanded ? lines : lines.slice(0, 8)).map((line: string) => theme.fg("toolOutput", line)).join("\n"));
      return text;
    },
  });

  pi.registerCommand("monitor-job", {
    description: "Show or configure the long-running job monitor",
    handler: async (args, ctx) => {
      config = loadConfig();
      const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const value = rest.join(" ");
      if (!action || action === "status") {
        const running = listJobs().filter((job) => ["starting", "running"].includes(refreshJob(job, isPidAlive).status)).length;
        ctx.ui.notify(`Job monitor: ${running} running · verbose ${config.verbose ? "on" : "off"} · analysis ${config.analysis.enabled ? "on" : "off"}\nConfig: ${CONFIG_PATH}`, "info");
        return;
      }
      if (action === "verbose" && (value === "on" || value === "off")) config.verbose = value === "on";
      else if (action === "analysis" && (value === "on" || value === "off")) config.analysis.enabled = value === "on";
      else if (action === "model") config.analysis.model = value && value !== "off" ? value : null;
      else {
        ctx.ui.notify("Usage: /monitor-job [status | verbose on|off | analysis on|off | model <provider/model|off>]", "warning");
        return;
      }
      saveConfig(config);
      ctx.ui.notify(`Saved job monitor configuration to ${CONFIG_PATH}`, "info");
    },
  });
}
