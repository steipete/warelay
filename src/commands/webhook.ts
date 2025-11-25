import type { CliDeps } from "../cli/deps.js";
import { retryAsync } from "../infra/retry.js";
import type { RuntimeEnv } from "../runtime.js";
import { upCommand } from "./up.js";

export async function webhookCommand(
	opts: {
		port: string;
		path: string;
		reply?: string;
		verbose?: boolean;
		yes?: boolean;
		ingress?: "tailscale" | "none";
		dryRun?: boolean;
	},
	deps: CliDeps,
	runtime: RuntimeEnv,
) {
	const port = Number.parseInt(opts.port, 10);
	if (Number.isNaN(port) || port <= 0 || port >= 65536) {
		throw new Error("Port must be between 1 and 65535");
	}

	const ingress = opts.ingress ?? "tailscale";

	// Tailscale ingress: reuse the `up` flow (Funnel + Twilio webhook update).
	if (ingress === "tailscale") {
		const result = await upCommand(
			{
				port: opts.port,
				path: opts.path,
				verbose: opts.verbose,
				yes: opts.yes,
				dryRun: opts.dryRun,
			},
			deps,
			runtime,
		);
		return result.server;
	}

	// Local-only webhook (no ingress / no Twilio update).
	await deps.ensurePortAvailable(port);
	if (opts.reply === "dry-run" || opts.dryRun) {
		runtime.log(
			`[dry-run] would start webhook on port ${port} path ${opts.path}`,
		);
		return undefined;
	}
	const server = await retryAsync(
		() =>
			deps.startWebhook(
				port,
				opts.path,
				opts.reply,
				Boolean(opts.verbose),
				runtime,
			),
		3,
		300,
	);
	return server;
}
