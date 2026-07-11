import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

const payloadPath = process.argv[2];
if (!payloadPath) throw new Error("Missing supervisor payload path");
const payload = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(payloadPath, "utf8")));
const { jobId, command, cwd, logPath, resultPath } = payload;
mkdirSync(dirname(logPath), { recursive: true });

const log = (text) => appendFileSync(logPath, text, "utf8");
const writeResult = (result) => {
  const temp = `${resultPath}.tmp`;
  writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  renameSync(temp, resultPath);
};

log(`[job-monitor] ${new Date().toISOString()} starting ${command}\n`);
let child;
try {
  child = spawn(command, {
    cwd,
    shell: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  log(`[job-monitor] launch failed: ${message}\n`);
  writeResult({ jobId, status: "failed", exitCode: null, finishedAt: Date.now(), error: message });
  process.exitCode = 1;
}

if (child) {
  child.stdout.on("data", (chunk) => log(chunk.toString()));
  child.stderr.on("data", (chunk) => log(chunk.toString()));
  child.on("error", (error) => log(`[job-monitor] process error: ${error.message}\n`));
  child.on("close", (code, signal) => {
    const status = code === 0 ? "completed" : "failed";
    log(`\n[job-monitor] ${new Date().toISOString()} ${status}; exit=${String(code)} signal=${String(signal)}\n`);
    writeResult({ jobId, status, exitCode: code, signal, finishedAt: Date.now() });
    process.exitCode = code ?? 1;
  });
}
