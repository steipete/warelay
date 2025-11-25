import { Command } from "commander";

import { setVerbose, setYes, danger, info, warn } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { sendCommand } from "../commands/send.js";
import { statusCommand } from "../commands/status.js";
import { upCommand } from "../commands/up.js";
import { webhookCommand } from "../commands/webhook.js";
import { loginWeb, monitorWebProvider } from "../provider-web.js";
import { pickProvider } from "../provider-web.js";
import type { Provider } from "../utils.js";
import { createDefaultDeps, logWebSelfId, logTwilioFrom, monitorTwilio } from "./deps.js";
import { ensureTwilioEnv } from "../env.js";

export function buildProgram() {
	const program = new Command();

	program
		.name("warelay")
		.description("WhatsApp relay CLI (Twilio or WhatsApp Web session)")
		.version("1.0.0");

	program
		.command("web:login")
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
		.command("login")
		.description("Alias for web:login (personal WhatsApp Web QR link)")
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
	.option("-w, --wait <seconds>", "Wait for delivery status (0 to skip)", "20")
	.option("-p, --poll <seconds>", "Polling interval while waiting", "2")
	.option("--provider <provider>", "Provider: twilio | web", "twilio")
	.option("--dry-run", "Print payload and skip sending", false)
	.option("--json", "Output result as JSON", false)
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
		.addHelpText(
			"after",
			`
Examples:
  warelay status                            # last 20 msgs in past 4h
  warelay status --limit 5 --lookback 30    # last 5 msgs in past 30m
  warelay status --json --limit 50          # machine-readable output`,
		)
		.action(async (opts) => {
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
			"Run a local webhook server for inbound WhatsApp (works with Tailscale/port forward)",
		)
		.option("-p, --port <port>", "Port to listen on", "42873")
		.option("-r, --reply <text>", "Optional auto-reply text")
		.option("--path <path>", "Webhook path", "/webhook/whatsapp")
		.option("--verbose", "Log inbound and auto-replies", false)
		.option("-y, --yes", "Auto-confirm prompts when possible", false)
		.option("--dry-run", "Print planned actions without starting server", false)
		.addHelpText(
			"after",
			`
Examples:
  warelay webhook                       # listen on 42873
  warelay webhook --port 45000          # pick a high, less-colliding port
  warelay webhook --reply "Got it!"     # static auto-reply; otherwise use config file

With Tailscale:
  tailscale serve tcp 42873 127.0.0.1:42873
  (then set Twilio webhook URL to your tailnet IP:42873/webhook/whatsapp)`,
		)
		// istanbul ignore next
		.action(async (opts) => {
			setVerbose(Boolean(opts.verbose));
			setYes(Boolean(opts.yes));
			const deps = createDefaultDeps();
			try {
				const server = await webhookCommand(opts, deps, defaultRuntime);
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
		.command("up")
		.description(
			"Bring up webhook + Tailscale Funnel + Twilio callback (default webhook mode)",
		)
		.option("-p, --port <port>", "Port to listen on", "42873")
		.option("--path <path>", "Webhook path", "/webhook/whatsapp")
		.option("--verbose", "Verbose logging during setup/webhook", false)
		.option("-y, --yes", "Auto-confirm prompts when possible", false)
		.option("--dry-run", "Print planned actions without touching network", false)
		// istanbul ignore next
		.action(async (opts) => {
			setVerbose(Boolean(opts.verbose));
			setYes(Boolean(opts.yes));
			const deps = createDefaultDeps();
			try {
				const { server } = await upCommand(opts, deps, defaultRuntime);
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

	return program;
}
