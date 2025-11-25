import {
	danger,
	info,
	isVerbose,
	logVerbose,
	success,
	warn,
} from "./globals.js";
import { getLogger } from "./logging.js";
import { defaultRuntime, type RuntimeEnv } from "./runtime.js";

export function logInfo(message: string, runtime: RuntimeEnv = defaultRuntime) {
	runtime.log(info(message));
	getLogger().info(message);
}

export function logWarn(message: string, runtime: RuntimeEnv = defaultRuntime) {
	runtime.log(warn(message));
	getLogger().warn(message);
}

export function logSuccess(
	message: string,
	runtime: RuntimeEnv = defaultRuntime,
) {
	runtime.log(success(message));
	getLogger().info(message);
}

export function logError(
	message: string,
	runtime: RuntimeEnv = defaultRuntime,
) {
	runtime.error(danger(message));
	getLogger().error(message);
}

export function logDebug(message: string) {
	// Always emit to file logger (level-filtered); console only when verbose.
	getLogger().debug(message);
	if (isVerbose()) logVerbose(message);
}
