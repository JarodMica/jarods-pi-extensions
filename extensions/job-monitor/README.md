# Job Monitor

A Pi tool for launching long-running commands and returning control to the model when a process exits or reaches a checkpoint. Monitoring is local and consumes no model tokens while the tool is waiting.

## Install

Install this parent repository from its root:

```bash
npm install
pi install .
```

Then restart Pi or run `/reload`.

## Tool

The extension registers `monitor_job` with these actions:

- `run` — launch a command and wait for exit, stall, timeout, cancellation, or checkpoint.
- `start` — launch a command and return its job ID immediately.
- `wait` — wait on an existing job.
- `status` — return its current state and new log output immediately.
- `list` — list recent jobs.
- `stop` — stop the supervisor and its process tree.

For workflows that depend on a long script's result, the model should use `run` instead of `bash`. When the tool returns, the model receives the bounded output delta and can continue the workflow.

Set `checkpointMinutes` to control how often the model gets an update. Set it to `0` to wait until exit, stall, timeout, or cancellation without periodic model calls.

Cancelling an attached wait leaves the underlying job running. Use `stop` to terminate it explicitly.

## Examples

Launch a script and wait until it finishes without periodic model calls:

```json
{
  "action": "run",
  "command": "train-model.bat",
  "checkpointMinutes": 0,
  "timeoutMinutes": 480
}
```

Launch a script and return progress to the model every 20 minutes:

```json
{
  "action": "run",
  "command": "train-model.bat",
  "checkpointMinutes": 20,
  "timeoutMinutes": 480
}
```

If that result says the job is still running, continue with its returned ID:

```json
{
  "action": "wait",
  "jobId": "train-model-20260711T120000Z-ab12"
}
```

Launch without holding the current tool call:

```json
{
  "action": "start",
  "command": "build-all.bat"
}
```

The model can later use `status`, `wait`, or `stop` with the returned `jobId`.

## Configuration

Run:

```text
/monitor-job status
/monitor-job verbose on
/monitor-job verbose off
/monitor-job model provider/model-id
/monitor-job model off
/monitor-job analysis on
/monitor-job analysis off
```

Configuration and job data are stored using Pi's user agent directory:

```text
~/.pi/agent/job-monitor/
├── config.json
└── jobs/
    └── <job-id>/
        ├── launch.json
        ├── metadata.json
        ├── output.log
        ├── result.json
        └── supervisor.log
```

`verbose` defaults to `false`. Normal metadata records only the supervisor PID; child-process lists are not persisted. Stopping a job still targets its process tree.

### Secondary monitoring model

Secondary-model analysis is disabled by default. Configure `analysis.model` with `/monitor-job model ...`, enable it with `/monitor-job analysis on`, and edit `config.json` to choose its trigger:

- `never`
- `on-exit`
- `on-error` (default)
- `on-stall`
- `always`

The secondary call receives only bounded job metadata and recent output. Healthy polling remains deterministic and does not invoke a model.

## Defaults

| Setting | Default |
|---|---:|
| Verbose | `false` |
| Poll interval | 5 seconds |
| Checkpoint | 10 minutes |
| Timeout | 480 minutes |
| Stall threshold | 30 minutes |
| Returned output | 8,000 characters / 100 tail lines |
| Secondary analysis | disabled |

## Behavior and outputs

- `run` and `wait` keep the tool call open but do not invoke a model while waiting.
- Each result includes status, return reason, supervisor PID, elapsed time, exit code, log path, and only the new bounded output since the prior check.
- A checkpoint returns control to the model so it can inspect progress and call `wait` again when later work still depends on the job.
- The detached supervisor allows a launched process to continue if Pi exits.
- A later Pi session can inspect persisted job metadata and results.
- If the supervisor disappears without writing a result, status becomes `unknown` rather than assuming success.
- On Windows, stopping uses `taskkill /T`; forced termination is opt-in.

## Troubleshooting

### The tool is missing after cloning

From the repository root, run:

```bash
npm install
pi install .
```

Then restart Pi or run `/reload`. The root package discovers `./extensions`, and `extensions/job-monitor/package.json` registers `./index.ts`.

### A job says `unknown`

The persisted supervisor PID is no longer alive and no final `result.json` was written. Inspect `output.log` and `supervisor.log`; the monitor intentionally does not assume that the command succeeded.

### Waiting returned `cancelled`

Cancelling the tool wait does not terminate the underlying process. Call `monitor_job` with `action: "wait"` to resume monitoring or `action: "stop"` to terminate its process tree.

### Output is truncated

Normal results return only the latest configured lines and characters. Open the reported `output.log` path for complete output, or increase `tailLines` and `maxResultCharacters` in `config.json`.
