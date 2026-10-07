#!/usr/bin/env node
import { main } from './node/cli.js';

process.exitCode = await main(process.argv.slice(2), process.env, {
	out: function(text: string): void {
		process.stdout.write(text);
	},
	error: function(text: string): void {
		process.stderr.write(text);
	}
});
