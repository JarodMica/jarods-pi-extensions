import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type AnalysisTrigger = "never" | "on-exit" | "on-error" | "on-stall" | "always";

export interface JobMonitorConfig {
  verbose: boolean;
  pollSeconds: number;
  defaultCheckpointMinutes: number;
  defaultTimeoutMinutes: number;
  stallMinutes: number;
  maxResultCharacters: number;
  tailLines: number;
  analysis: {
    enabled: boolean;
    model: string | null;
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    trigger: AnalysisTrigger;
    timeoutSeconds: number;
    maxInputCharacters: number;
  };
}

export const ROOT_DIR = join(getAgentDir(), "job-monitor");
export const JOBS_DIR = join(ROOT_DIR, "jobs");
export const CONFIG_PATH = join(ROOT_DIR, "config.json");

export function defaultConfig(): JobMonitorConfig {
  return {
    verbose: false,
    pollSeconds: 5,
    defaultCheckpointMinutes: 10,
    defaultTimeoutMinutes: 480,
    stallMinutes: 30,
    maxResultCharacters: 8000,
    tailLines: 100,
    analysis: {
      enabled: false,
      model: null,
      thinkingLevel: "off",
      trigger: "on-error",
      timeoutSeconds: 90,
      maxInputCharacters: 12000,
    },
  };
}

export function ensureStorage(): void {
  mkdirSync(JOBS_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) saveConfig(defaultConfig());
}

export function loadConfig(): JobMonitorConfig {
  ensureStorage();
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<JobMonitorConfig>;
    const defaults = defaultConfig();
    return {
      ...defaults,
      ...raw,
      analysis: { ...defaults.analysis, ...(raw.analysis ?? {}) },
    };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(config: JobMonitorConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
