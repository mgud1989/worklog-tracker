import { loadAndValidateEnv, loadMcpConfig } from "./config.js";
import { TogglTempoAdapter } from "./toggl-tempo-adapter.js";
import type { SmartTimerControlInput } from "./types.js";

const USAGE = `Usage:
  node dist/cli.js timer start --description "PROJ-123 working" [--project NAME] [--tags tag1,tag2]
  node dist/cli.js timer stop`;

function parseArgs(argv: string[]): SmartTimerControlInput {
  // argv: [node, script, "timer", action, ...flags]
  const args = argv.slice(2);

  if (args[0] !== "timer") {
    process.stderr.write(`Unknown command: ${args[0] ?? "(none)"}\n\n${USAGE}\n`);
    process.exit(1);
  }

  const action = args[1];
  if (action !== "start" && action !== "stop") {
    process.stderr.write(`Unknown action: ${action ?? "(none)"}\n\n${USAGE}\n`);
    process.exit(1);
  }

  const input: SmartTimerControlInput = { action };
  const flags = args.slice(2);

  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    const value = flags[i + 1];

    if (flag === "--description" && value) {
      input.description = value;
      i++;
    } else if (flag === "--project" && value) {
      input.project = value;
      i++;
    } else if (flag === "--tags" && value) {
      input.tags = value.split(",").map((t) => t.trim());
      i++;
    } else {
      process.stderr.write(`Unknown flag: ${flag}\n\n${USAGE}\n`);
      process.exit(1);
    }
  }

  if (action === "start" && !input.description) {
    process.stderr.write(`--description is required for timer start\n\n${USAGE}\n`);
    process.exit(1);
  }

  return input;
}

async function main() {
  const input = parseArgs(process.argv);

  const appConfig = loadMcpConfig(process.env.MCP_CONFIG_PATH);
  const env = loadAndValidateEnv();
  const adapter = await TogglTempoAdapter.create(env.togglApiToken, appConfig);

  const result = await adapter.smartTimerControl(input);

  if (input.action === "start") {
    process.stdout.write(`Timer started: ${input.description}\n`);
  } else {
    process.stdout.write("Timer stopped\n");
  }

  // Print Toggl response as JSON for scripts that need the entry ID
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
