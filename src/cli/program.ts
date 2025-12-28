import chalk from "chalk";
import { Command } from "commander";
import { agentCommand } from "../commands/agent.js";
import { doctorCommand } from "../commands/doctor.js";
import { healthCommand } from "../commands/health.js";
import { sendCommand } from "../commands/send.js";
import { sessionsCommand } from "../commands/sessions.js";
import { setupCommand } from "../commands/setup.js";
import { statusCommand } from "../commands/status.js";
import { danger, setVerbose } from "../globals.js";
import { loginWeb, logoutWeb } from "../provider-web.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import { registerBrowserCli } from "./browser-cli.js";
import { registerCanvasCli } from "./canvas-cli.js";
import { registerCronCli } from "./cron-cli.js";
import { createDefaultDeps } from "./deps.js";
import { registerDnsCli } from "./dns-cli.js";
import { registerGatewayCli } from "./gateway-cli.js";
import { registerHooksCli } from "./hooks-cli.js";
import { registerNodesCli } from "./nodes-cli.js";
import { forceFreePort } from "./ports.js";

export { forceFreePort };

export function buildProgram() {
  const program = new Command();
  const PROGRAM_VERSION = VERSION;
  const TAGLINE =
    "Send, receive, and auto-reply on WhatsApp (web) and Telegram (bot).";

  program.name("clawdis").description("").version(PROGRAM_VERSION);

  const formatIntroLine = (version: string, rich = true) => {
    const base = `📡 clawdis ${version} — ${TAGLINE}`;
    return rich && chalk.level > 0
      ? `${chalk.bold.cyan("📡 clawdis")} ${chalk.white(version)} ${chalk.gray("—")} ${chalk.green(TAGLINE)}`
      : base;
  };

  program.configureHelp({
    optionTerm: (option) => chalk.yellow(option.flags),
    subcommandTerm: (cmd) => chalk.green(cmd.name()),
  });

  program.configureOutput({
    writeOut: (str) => {
      const colored = str
        .replace(/^Usage:/gm, chalk.bold.cyan("Usage:"))
        .replace(/^Options:/gm, chalk.bold.cyan("Options:"))
        .replace(/^Commands:/gm, chalk.bold.cyan("Commands:"));
      process.stdout.write(colored);
    },
    writeErr: (str) => process.stderr.write(str),
    outputError: (str, write) => write(chalk.red(str)),
  });

  if (
    process.argv.includes("-V") ||
    process.argv.includes("--version") ||
    process.argv.includes("-v")
  ) {
    console.log(PROGRAM_VERSION);
    process.exit(0);
  }

  program.addHelpText("beforeAll", `\n${formatIntroLine(PROGRAM_VERSION)}\n`);
  const examples = [
    [
      "clawdis login --verbose",
      "Link personal WhatsApp Web and show QR + connection logs.",
    ],
    [
      'clawdis send --to +15555550123 --message "Hi" --json',
      "Send via your web session and print JSON result.",
    ],
    ["clawdis gateway --port 18789", "Run the WebSocket Gateway locally."],
    [
      "clawdis gateway --force",
      "Kill anything bound to the default gateway port, then start it.",
    ],
    ["clawdis gateway ...", "Gateway control via WebSocket."],
    [
      'clawdis agent --to +15555550123 --message "Run summary" --deliver',
      "Talk directly to the agent using the Gateway; optionally send the WhatsApp reply.",
    ],
    [
      'clawdis send --provider telegram --to @mychat --message "Hi"',
      "Send via your Telegram bot.",
    ],
  ] as const;

  const fmtExamples = examples
    .map(([cmd, desc]) => `  ${chalk.green(cmd)}\n    ${chalk.gray(desc)}`)
    .join("\n");

  program.addHelpText(
    "afterAll",
    `\n${chalk.bold.cyan("Examples:")}\n${fmtExamples}\n`,
  );

  program
    .command("setup")
    .description("Initialize ~/.clawdis/clawdis.json and the agent workspace")
    .option(
      "--workspace <dir>",
      "Agent workspace directory (default: ~/clawd; stored as agent.workspace)",
    )
    .action(async (opts) => {
      try {
        await setupCommand(
          { workspace: opts.workspace as string | undefined },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("doctor")
    .description("Check system prerequisites and configuration health")
    .option("--json", "Output result as JSON", false)
    .option("--verbose", "Show version details for each check", false)
    .option("--fix", "Interactively fix detected issues", false)
    .addHelpText(
      "after",
      `
Examples:
  clawdis doctor              # run all prerequisite checks
  clawdis doctor --verbose    # show version info for each check
  clawdis doctor --json       # machine-readable output for CI
  clawdis doctor --fix        # interactively fix detected issues`,
    )
    .action(async (opts) => {
      try {
        await doctorCommand(
          {
            json: Boolean(opts.json),
            verbose: Boolean(opts.verbose),
            fix: Boolean(opts.fix),
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("login")
    .description("Link your personal WhatsApp via QR (web provider)")
    .option("--verbose", "Verbose connection logs", false)
    .option("--provider <provider>", "Provider alias (default: whatsapp)")
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      try {
        const provider = opts.provider ?? "whatsapp";
        await loginWeb(Boolean(opts.verbose), provider);
      } catch (err) {
        defaultRuntime.error(danger(`Web login failed: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("logout")
    .description("Clear cached WhatsApp Web credentials")
    .option("--provider <provider>", "Provider alias (default: whatsapp)")
    .action(async (opts) => {
      try {
        void opts.provider; // placeholder for future multi-provider; currently web only.
        await logoutWeb(defaultRuntime);
      } catch (err) {
        defaultRuntime.error(danger(`Logout failed: ${String(err)}`));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("send")
    .description("Send a message (WhatsApp Web, Telegram bot, or Discord)")
    .requiredOption(
      "-t, --to <number>",
      "Recipient: E.164 for WhatsApp, Telegram chat id/@username, or Discord channel/user",
    )
    .requiredOption("-m, --message <text>", "Message body")
    .option(
      "--media <path-or-url>",
      "Attach media (image/audio/video/document). Accepts local paths or URLs.",
    )
    .option(
      "--provider <provider>",
      "Delivery provider: whatsapp|telegram|discord (default: whatsapp)",
    )
    .option("--dry-run", "Print payload and skip sending", false)
    .option("--json", "Output result as JSON", false)
    .option("--verbose", "Verbose logging", false)
    .addHelpText(
      "after",
      `
Examples:
  clawdis send --to +15555550123 --message "Hi"
  clawdis send --to +15555550123 --message "Hi" --media photo.jpg
  clawdis send --to +15555550123 --message "Hi" --dry-run      # print payload only
  clawdis send --to +15555550123 --message "Hi" --json         # machine-readable result`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const deps = createDefaultDeps();
      try {
        await sendCommand(opts, deps, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("agent")
    .description(
      "Talk directly to the configured agent (no chat send; optional WhatsApp delivery)",
    )
    .requiredOption("-m, --message <text>", "Message body for the agent")
    .option(
      "-t, --to <number>",
      "Recipient number in E.164 used to derive the session key",
    )
    .option("--session-id <id>", "Use an explicit session id")
    .option(
      "--thinking <level>",
      "Thinking level: off | minimal | low | medium | high",
    )
    .option("--verbose <on|off>", "Persist agent verbose level for the session")
    .option(
      "--provider <provider>",
      "Delivery provider: whatsapp|telegram|discord (default: whatsapp)",
    )
    .option(
      "--deliver",
      "Send the agent's reply back to the selected provider (requires --to)",
      false,
    )
    .option("--json", "Output result as JSON", false)
    .option(
      "--timeout <seconds>",
      "Override agent command timeout (seconds, default 600 or config value)",
    )
    .addHelpText(
      "after",
      `
Examples:
  clawdis agent --to +15555550123 --message "status update"
  clawdis agent --session-id 1234 --message "Summarize inbox" --thinking medium
  clawdis agent --to +15555550123 --message "Trace logs" --verbose on --json
  clawdis agent --to +15555550123 --message "Summon reply" --deliver
`,
    )
    .action(async (opts) => {
      const verboseLevel =
        typeof opts.verbose === "string" ? opts.verbose.toLowerCase() : "";
      setVerbose(verboseLevel === "on");
      // Build default deps (keeps parity with other commands; future-proofing).
      void createDefaultDeps();
      try {
        await agentCommand(opts, defaultRuntime);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  registerCanvasCli(program);
  registerGatewayCli(program);
  registerNodesCli(program);
  registerCronCli(program);
  registerDnsCli(program);
  registerHooksCli(program);

  program
    .command("status")
    .description("Show web session health and recent session recipients")
    .option("--json", "Output JSON instead of text", false)
    .option(
      "--deep",
      "Probe providers (WhatsApp Web + Telegram + Discord)",
      false,
    )
    .option("--timeout <ms>", "Probe timeout in milliseconds", "10000")
    .option("--verbose", "Verbose logging", false)
    .addHelpText(
      "after",
      `
Examples:
  clawdis status                   # show linked account + session store summary
  clawdis status --json            # machine-readable output
  clawdis status --deep            # run provider probes (WA + Telegram + Discord)
  clawdis status --deep --timeout 5000 # tighten probe timeout`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const timeout = opts.timeout
        ? Number.parseInt(String(opts.timeout), 10)
        : undefined;
      if (timeout !== undefined && (Number.isNaN(timeout) || timeout <= 0)) {
        defaultRuntime.error(
          "--timeout must be a positive integer (milliseconds)",
        );
        defaultRuntime.exit(1);
        return;
      }
      try {
        await statusCommand(
          {
            json: Boolean(opts.json),
            deep: Boolean(opts.deep),
            timeoutMs: timeout,
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("health")
    .description("Fetch health from the running gateway")
    .option("--json", "Output JSON instead of text", false)
    .option("--timeout <ms>", "Connection timeout in milliseconds", "10000")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      const timeout = opts.timeout
        ? Number.parseInt(String(opts.timeout), 10)
        : undefined;
      if (timeout !== undefined && (Number.isNaN(timeout) || timeout <= 0)) {
        defaultRuntime.error(
          "--timeout must be a positive integer (milliseconds)",
        );
        defaultRuntime.exit(1);
        return;
      }
      try {
        await healthCommand(
          {
            json: Boolean(opts.json),
            timeoutMs: timeout,
          },
          defaultRuntime,
        );
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  program
    .command("sessions")
    .description("List stored conversation sessions")
    .option("--json", "Output as JSON", false)
    .option("--verbose", "Verbose logging", false)
    .option(
      "--store <path>",
      "Path to session store (default: resolved from config)",
    )
    .option(
      "--active <minutes>",
      "Only show sessions updated within the past N minutes",
    )
    .addHelpText(
      "after",
      `
Examples:
  clawdis sessions                 # list all sessions
  clawdis sessions --active 120    # only last 2 hours
  clawdis sessions --json          # machine-readable output
  clawdis sessions --store ./tmp/sessions.json

Shows token usage per session when the agent reports it; set agent.contextTokens to see % of your model window.`,
    )
    .action(async (opts) => {
      setVerbose(Boolean(opts.verbose));
      await sessionsCommand(
        {
          json: Boolean(opts.json),
          store: opts.store as string | undefined,
          active: opts.active as string | undefined,
        },
        defaultRuntime,
      );
    });

  registerBrowserCli(program);

  return program;
}
