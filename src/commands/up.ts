import type { CliDeps } from "../cli/deps.js";
import type { RuntimeEnv } from "../runtime.js";
import { waitForever as defaultWaitForever } from "../cli/wait.js";
import { retryAsync } from "../infra/retry.js";

export async function upCommand(
	opts: { port: string; path: string; verbose?: boolean; yes?: boolean; dryRun?: boolean },
	deps: CliDeps,
	runtime: RuntimeEnv,
	waiter: typeof defaultWaitForever = defaultWaitForever,
) {
	const port = Number.parseInt(opts.port, 10);
	if (Number.isNaN(port) || port <= 0 || port >= 65536) {
		throw new Error("Port must be between 1 and 65535");
	}

	await deps.ensurePortAvailable(port);
	const env = deps.readEnv(runtime);
	if (opts.dryRun) {
		runtime.log(`[dry-run] would enable funnel on port ${port}`);
		runtime.log(`[dry-run] would start webhook at path ${opts.path}`);
		runtime.log(`[dry-run] would update Twilio sender webhook`);
		const publicUrl = `https://dry-run${opts.path}`;
		return { server: undefined, publicUrl, senderSid: undefined, waiter };
	}
	await deps.ensureBinary("tailscale", undefined, runtime);
	await retryAsync(() => deps.ensureFunnel(port, undefined, runtime), 3, 500);
	const host = await deps.getTailnetHostname();
	const publicUrl = `https://${host}${opts.path}`;
	runtime.log(`🌐 Public webhook URL (via Funnel): ${publicUrl}`);

	const server = await retryAsync(
		() =>
			deps.startWebhook(
				port,
				opts.path,
				undefined,
				Boolean(opts.verbose),
				runtime,
			),
		3,
		300,
	);

	if (!deps.createClient) {
		throw new Error("Twilio client dependency missing");
	}
	const twilioClient = deps.createClient(env);
	const senderSid = await deps.findWhatsappSenderSid(
		twilioClient,
		env.whatsappFrom,
		env.whatsappSenderSid,
		runtime,
	);
	await deps.updateWebhook(twilioClient, senderSid, publicUrl, "POST", runtime);

	runtime.log(
		"\nSetup complete. Leave this process running to keep the webhook online. Ctrl+C to stop.",
	);

	return { server, publicUrl, senderSid, waiter };
}
