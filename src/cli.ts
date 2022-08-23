#!/usr/bin/env node

import { killAll } from "./spawn";
import { resolve, dirname } from "path";
import fs from "fs";
import { LaunchConfig } from "./types";
import { run, runThenTryUpgrade, runThenTryUpgradeParachains } from "./runner";

// Special care is needed to handle paths to various files (binaries, spec, config, etc...)
// The user passes the path to `config.json`, and we use that as the starting point for any other
// relative path. So the `config.json` file is what we will be our starting point.
const { argv } = require("yargs")
	.options({
		'test-upgrade': {
			alias: ['upgrade', 'u', 't'],
			type: 'boolean',
			describe: 'Test forkless runtime upgrades.',
		},
		'test-upgrade-parachains': {
			alias: ['upgrade-parachains', 'test-parachains', 'p'],
			type: 'boolean',
			describe: 'Test forkless runtime upgrades for parachains only.',
			conflicts: 'test-upgrade',
		},
		'wait': {
			alias: ['wait-for-input', 'w'],
			type: 'boolean',
			describe: 'Wait for either user input or an external signal if used with runtime upgrade (useful for tests).',
		},
		'nodes-only': {
			alias: ['nodes', 'n'],
			type: 'boolean',
			describe: 'Do not upgrade runtimes if used with upgrade testing, only restart nodes with new binaries.',
		},
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

// Necessary for signal acceptance, as otherwise there would be nothing to grab
process.title = "polkadot-launch";

// Kill all processes when exiting.
process.on("exit", function () {
	killAll();
});

// Handle ctrl+c to trigger `exit`.
process.on("SIGINT", function () {
	process.exit(2);
});

if (argv.upgrade) 
	runThenTryUpgrade(config_dir, config, argv.wait, argv.nodes);
else if (argv.upgradeParachains)
	runThenTryUpgradeParachains(config_dir, config, argv.wait, argv.nodes);
else 
	run(config_dir, config);
