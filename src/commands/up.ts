import type { CliDeps, RuntimeEnv } from "../index.js";
import { waitForever as defaultWaitForever } from "../index.js";

export async function upCommand(
	opts: { port: string; path: string; verbose?: boolean; yes?: boolean },
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
	await deps.ensureBinary("tailscale", undefined, runtime);
	await deps.ensureFunnel(port, undefined, runtime);
	const host = await deps.getTailnetHostname();
	const publicUrl = `https://${host}${opts.path}`;
	runtime.log(`🌐 Public webhook URL (via Funnel): ${publicUrl}`);

	const server = await deps.startWebhook(
		port,
		opts.path,
		undefined,
		Boolean(opts.verbose),
		runtime,
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
