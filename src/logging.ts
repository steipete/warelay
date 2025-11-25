import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import pino, { type Bindings, type LevelWithSilent, type Logger } from "pino";
import { loadConfig, type WarelayConfig } from "./config/config.js";
import { isVerbose } from "./globals.js";

const DEFAULT_LOG_DIR = path.join(os.tmpdir(), "warelay");
export const DEFAULT_LOG_FILE = path.join(DEFAULT_LOG_DIR, "warelay.log");

const ALLOWED_LEVELS: readonly LevelWithSilent[] = [
	"silent",
	"fatal",
	"error",
	"warn",
	"info",
	"debug",
	"trace",
];

export type LoggerSettings = {
	level?: LevelWithSilent;
	file?: string;
};

type ResolvedSettings = {
	level: LevelWithSilent;
	file: string;
};

let cachedLogger: Logger | null = null;
let cachedSettings: ResolvedSettings | null = null;
let overrideSettings: LoggerSettings | null = null;

function normalizeLevel(level?: string): LevelWithSilent {
	if (isVerbose()) return "debug";
	const candidate = level ?? "info";
	return ALLOWED_LEVELS.includes(candidate as LevelWithSilent)
		? (candidate as LevelWithSilent)
		: "info";
}

function resolveSettings(): ResolvedSettings {
	const cfg: WarelayConfig["logging"] | undefined =
		overrideSettings ?? loadConfig().logging;
	const level = normalizeLevel(cfg?.level);
	const file = cfg?.file ?? DEFAULT_LOG_FILE;
	return { level, file };
}

function settingsChanged(a: ResolvedSettings | null, b: ResolvedSettings) {
	if (!a) return true;
	return a.level !== b.level || a.file !== b.file;
}

function buildLogger(settings: ResolvedSettings): Logger {
	fs.mkdirSync(path.dirname(settings.file), { recursive: true });
	const destination = pino.destination({
		dest: settings.file,
		mkdir: true,
		sync: true, // deterministic for tests; log volume is modest.
	});
	return pino(
		{
			level: settings.level,
			base: undefined,
			timestamp: pino.stdTimeFunctions.isoTime,
		},
		destination,
	);
}

export function getLogger(): Logger {
	const settings = resolveSettings();
	if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
		cachedLogger = buildLogger(settings);
		cachedSettings = settings;
	}
	return cachedLogger;
}

export function getChildLogger(
	bindings?: Bindings,
	opts?: { level?: LevelWithSilent },
): Logger {
	return getLogger().child(bindings ?? {}, opts);
}

// Test helpers
export function setLoggerOverride(settings: LoggerSettings | null) {
	overrideSettings = settings;
	cachedLogger = null;
	cachedSettings = null;
}

export function resetLogger() {
	cachedLogger = null;
	cachedSettings = null;
	overrideSettings = null;
}
