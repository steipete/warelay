#!/usr/bin/env node
import("../dist/index.js").then((mod) => {
	if (mod?.program?.parseAsync) {
		mod.program.parseAsync(process.argv);
	}
});
