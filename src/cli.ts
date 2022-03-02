#!/usr/bin/env node

import { killAll } from "./spawn";
import { resolve, dirname } from "path";
import fs from "fs";
import { LaunchConfig } from "./types";
import { run, runThenTryUpgrade } from "./runner";

// Special care is needed to handle paths to various files (binaries, spec, config, etc...)
// The user passes the path to `config.json`, and we use that as the starting point for any other
// relative path. So the `config.json` file is what we will be our starting point.
const { argv } = require("yargs")
	.options({
		'test-upgrade': {
			alias: 'upgrade',
			type: 'boolean',
			describe: 'Whether we should test upgrading the runtimes with additional binaries designated in the config.',
			default: false
		},
		'timeout': {
			alias: 't',
			type: 'number',
			describe: 'Timeout for when an epoch expires (in ms). Used for runtime upgrade testing. \
			1 hour by default, but different relay chains might have different epoch lengths.',
			default: 4200000
		}
	})

const config_file = argv._[0] ? argv._[0] : null;
if (!config_file) {
	console.error("Missing config file argument...");
	process.exit();
}
let config_path = resolve(process.cwd(), config_file);
let config_dir = dirname(config_path);
if (!fs.existsSync(config_path)) {
	console.error("Config file does not exist: ", config_path);
	process.exit();
}
let config: LaunchConfig = require(config_path);

// Kill all processes when exiting.
process.on("exit", function () {
	killAll();
});

// Handle ctrl+c to trigger `exit`.
process.on("SIGINT", function () {
	process.exit(2);
});

if (argv.upgrade)
	runThenTryUpgrade(config_dir, config, argv.t);
else
	run(config_dir, config);
