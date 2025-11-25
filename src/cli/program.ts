import chalk from "chalk";
import { Command } from "commander";
import { sendCommand } from "../commands/send.js";
import { statusCommand } from "../commands/status.js";
import { webhookCommand } from "../commands/webhook.js";
import { ensureTwilioEnv } from "../env.js";
import { danger, info, setVerbose, setYes, warn } from "../globals.js";
import { loginWeb, monitorWebProvider, pickProvider } from "../provider-web.js";
import { defaultRuntime } from "../runtime.js";
import type { Provider } from "../utils.js";
import {
	createDefaultDeps,
	logTwilioFrom,
	logWebSelfId,
	monitorTwilio,
} from "./deps.js";
import { spawnRelayTmux } from "./relay_tmux.js";

export function buildProgram() {
	const program = new Command();
	const PROGRAM_VERSION = "0.1.3";
	const TAGLINE =
		"Send, receive, and auto-reply on WhatsApp—Twilio-backed or QR-linked.";

	program
		.name("warelay")
		.description("WhatsApp relay CLI (Twilio or WhatsApp Web session)")
		.version(PROGRAM_VERSION);

	const formatIntroLine = (version: string, rich = true) => {
		const base = `📡 warelay ${version} — ${TAGLINE}`;
		return rich && chalk.level > 0
			? `${chalk.bold.cyan("📡 warelay")} ${chalk.white(version)} ${chalk.gray("—")} ${chalk.green(TAGLINE)}`
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

	if (process.argv.includes("-V") || process.argv.includes("--version")) {
		console.log(formatIntroLine(PROGRAM_VERSION));
		process.exit(0);
	}

	program.addHelpText("beforeAll", `\n${formatIntroLine(PROGRAM_VERSION)}\n`);
	const examples = [
		[
			"warelay login --verbose",
			"Link personal WhatsApp Web and show QR + connection logs.",
		],
		[
			'warelay send --to +15551234567 --message "Hi" --provider web --json',
			"Send via your web session and print JSON result.",
		],
		[
			"warelay relay --provider auto --interval 5 --lookback 15 --verbose",
			"Auto-reply loop: prefer Web when logged in, otherwise Twilio polling.",
		],
		[
			"warelay webhook --ingress tailscale --port 42873 --path /webhook/whatsapp --verbose",
			"Start webhook + Tailscale Funnel and update Twilio callbacks.",
		],
		[
			"warelay status --limit 10 --lookback 60 --json",
			"Show last 10 messages from the past hour as JSON.",
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
		.command("login")
		.description("Link your personal WhatsApp via QR (web provider)")
		.option("--verbose", "Verbose connection logs", false)
		.action(async (opts) => {
			setVerbose(Boolean(opts.verbose));
			try {
				await loginWeb(Boolean(opts.verbose));
			} catch (err) {
				defaultRuntime.error(danger(`Web login failed: ${String(err)}`));
				defaultRuntime.exit(1);
			}
		});

	program
		.command("send")
		.description("Send a WhatsApp message")
		.requiredOption(
			"-t, --to <number>",
			"Recipient number in E.164 (e.g. +15551234567)",
		)
		.requiredOption("-m, --message <text>", "Message body")
		.option(
			"--media <path-or-url>",
			"Attach image (<=5MB). Web: path or URL. Twilio: https URL or local path hosted via webhook/funnel.",
		)
		.option(
			"--serve-media",
			"For Twilio: start a temporary media server if webhook is not running",
			false,
		)
		.option(
			"-w, --wait <seconds>",
			"Wait for delivery status (0 to skip)",
			"20",
		)
		.option("-p, --poll <seconds>", "Polling interval while waiting", "2")
		.option("--provider <provider>", "Provider: twilio | web", "twilio")
		.option("--dry-run", "Print payload and skip sending", false)
		.option("--json", "Output result as JSON", false)
		.option("--verbose", "Verbose logging", false)
		.addHelpText(
			"after",
			`
Examples:
  warelay send --to +15551234567 --message "Hi"                # wait 20s for delivery (default)
  warelay send --to +15551234567 --message "Hi" --wait 0       # fire-and-forget
  warelay send --to +15551234567 --message "Hi" --dry-run      # print payload only
  warelay send --to +15551234567 --message "Hi" --wait 60 --poll 3`,
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
		.command("relay")
		.description("Auto-reply to inbound messages (auto-selects web or twilio)")
		.option("--provider <provider>", "auto | web | twilio", "auto")
		.option("-i, --interval <seconds>", "Polling interval for twilio mode", "5")
		.option(
			"-l, --lookback <minutes>",
			"Initial lookback window for twilio mode",
			"5",
		)
		.option("--verbose", "Verbose logging", false)
		.addHelpText(
			"after",
			`
Examples:
  warelay relay                     # auto: web if logged-in, else twilio poll
  warelay relay --provider web      # force personal web session
  warelay relay --provider twilio   # force twilio poll
  warelay relay --provider twilio --interval 2 --lookback 30
`,
		)
		.action(async (opts) => {
			setVerbose(Boolean(opts.verbose));
			const providerPref = String(opts.provider ?? "auto");
			if (!["auto", "web", "twilio"].includes(providerPref)) {
				defaultRuntime.error("--provider must be auto, web, or twilio");
				defaultRuntime.exit(1);
			}
			const intervalSeconds = Number.parseInt(opts.interval, 10);
			const lookbackMinutes = Number.parseInt(opts.lookback, 10);
			if (Number.isNaN(intervalSeconds) || intervalSeconds <= 0) {
				defaultRuntime.error("Interval must be a positive integer");
				defaultRuntime.exit(1);
			}
			if (Number.isNaN(lookbackMinutes) || lookbackMinutes < 0) {
				defaultRuntime.error("Lookback must be >= 0 minutes");
				defaultRuntime.exit(1);
			}

			const provider = await pickProvider(providerPref as Provider | "auto");

			if (provider === "web") {
				logWebSelfId(defaultRuntime, true);
				try {
					await monitorWebProvider(Boolean(opts.verbose));
					return;
				} catch (err) {
					if (providerPref === "auto") {
						defaultRuntime.error(
							warn("Web session unavailable; falling back to twilio."),
						);
					} else {
						defaultRuntime.error(danger(`Web relay failed: ${String(err)}`));
						defaultRuntime.exit(1);
					}
				}
			}

			ensureTwilioEnv();
			logTwilioFrom();
			await monitorTwilio(intervalSeconds, lookbackMinutes);
		});

	program
		.command("status")
		.description("Show recent WhatsApp messages (sent and received)")
		.option("-l, --limit <count>", "Number of messages to show", "20")
		.option("-b, --lookback <minutes>", "How far back to fetch messages", "240")
		.option("--json", "Output JSON instead of text", false)
		.option("--verbose", "Verbose logging", false)
		.addHelpText(
			"after",
			`
Examples:
  warelay status                            # last 20 msgs in past 4h
  warelay status --limit 5 --lookback 30    # last 5 msgs in past 30m
  warelay status --json --limit 50          # machine-readable output`,
		)
		.action(async (opts) => {
			setVerbose(Boolean(opts.verbose));
			const deps = createDefaultDeps();
			try {
				await statusCommand(opts, deps, defaultRuntime);
			} catch (err) {
				defaultRuntime.error(String(err));
				defaultRuntime.exit(1);
			}
		});

	program
		.command("webhook")
		.description(
			"Run inbound webhook. ingress=tailscale updates Twilio; ingress=none stays local-only.",
		)
		.option("-p, --port <port>", "Port to listen on", "42873")
		.option("-r, --reply <text>", "Optional auto-reply text")
		.option("--path <path>", "Webhook path", "/webhook/whatsapp")
		.option(
			"--ingress <mode>",
			"Ingress: tailscale (funnel + Twilio update) | none (local only)",
			"tailscale",
		)
		.option("--verbose", "Log inbound and auto-replies", false)
		.option("-y, --yes", "Auto-confirm prompts when possible", false)
		.option("--dry-run", "Print planned actions without starting server", false)
		.addHelpText(
			"after",
			`
Examples:
  warelay webhook                       # ingress=tailscale (funnel + Twilio update)
  warelay webhook --ingress none        # local-only server (no funnel / no Twilio update)
  warelay webhook --port 45000          # pick a high, less-colliding port
  warelay webhook --reply "Got it!"     # static auto-reply; otherwise use config file`,
		)
		// istanbul ignore next
		.action(async (opts) => {
			setVerbose(Boolean(opts.verbose));
			setYes(Boolean(opts.yes));
			const deps = createDefaultDeps();
			try {
				const server = await webhookCommand(opts, deps, defaultRuntime);
				if (!server) {
					defaultRuntime.log(
						info("Webhook dry-run complete; no server started."),
					);
					return;
				}
				process.on("SIGINT", () => {
					server.close(() => {
						console.log("\n👋 Webhook stopped");
						defaultRuntime.exit(0);
					});
				});
				await deps.waitForever();
			} catch (err) {
				defaultRuntime.error(String(err));
				defaultRuntime.exit(1);
			}
		});

	program
		.command("relay:tmux")
		.description(
			"Run relay --verbose inside tmux (session warelay-relay), restarting if already running, then attach",
		)
		.action(async () => {
			try {
				const session = await spawnRelayTmux(
					"pnpm warelay relay --verbose",
					true,
				);
				defaultRuntime.log(
					info(
						`tmux session started and attached: ${session} (pane running "pnpm warelay relay --verbose")`,
					),
				);
			} catch (err) {
				defaultRuntime.error(
					danger(`Failed to start relay tmux session: ${String(err)}`),
				);
				defaultRuntime.exit(1);
			}
		});

	program
		.command("relay:tmux:attach")
		.description(
			"Attach to the existing warelay-relay tmux session (no restart)",
		)
		.action(async () => {
			try {
				await spawnRelayTmux("pnpm warelay relay --verbose", true, false);
				defaultRuntime.log(info("Attached to warelay-relay session."));
			} catch (err) {
				defaultRuntime.error(
					danger(`Failed to attach to warelay-relay: ${String(err)}`),
				);
				defaultRuntime.exit(1);
			}
		});

	return program;
}
