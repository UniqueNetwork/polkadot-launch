import { 
	LaunchConfig,
	UpgradableRelayChainConfig,
	UpgradableResolvedParachainConfig 
} from "./types";
import fs from "fs";
import { resolve } from "path";

// This function checks that the `config.json` file has all the expected properties.
// It displays a unique error message and returns `false` for any detected issues.
export function checkConfig(config: LaunchConfig, config_dir?: string, isTestingUpgrade?: boolean) {
	if (!config) {
		console.error("⚠ Missing config");
		return false;
	}

	if (!config.relaychain) {
		console.error("⚠ Missing `relaychain` object");
		return false;
	}

	if (!config.relaychain.bin) {
		console.error("⚠ Missing `relaychain.bin`");
		return false;
	}

	if (!config.relaychain.chain) {
		console.error("⚠ Missing `relaychain.chain`");
		return false;
	}

	if (config.relaychain.nodes.length == 0) {
		console.error("⚠ No relaychain nodes defined");
		return false;
	}

	for (const node of config.relaychain.nodes) {
		if (node.flags && node.flags.constructor !== Array) {
			console.error("⚠ Relay chain flags should be an array.");
			return false;
		}
	}

	if (!config.parachains) {
		console.error("⚠ Missing `parachains` object");
		return false;
	}

	if (config.parachains.length >= config.relaychain.nodes.length) {
		console.error(
			"⚠ Must have the same or greater number of relaychain nodes than parachains."
		);
		return false;
	}

	for (let parachain of config.parachains) {
		if (!parachain.nodes) {
			console.error("⚠ Missing parachain nodes");
			return false;
		}
	}

	for (let parachain of config.parachains) {
		for (let node of parachain.nodes) {
			if (node.flags && node.flags.constructor !== Array) {
				console.error("⚠ Parachain flags should be an array.");
				return false;
			}
		}
	}

	if (isTestingUpgrade) {
		if (!config_dir) {
			return false;
		}

		const relay_chain = config.relaychain as UpgradableRelayChainConfig;
		if (!relay_chain.upgradeBin) {
			console.error(`⚠ Missing the 'upgradeBin' argument for the relay chain. `
			+ `Please provide the path to the modified binary.`);
			return false;
		}
		const upgraded_relay_chain_bin = resolve(config_dir, relay_chain.upgradeBin);
		if (!fs.existsSync(upgraded_relay_chain_bin)) {
			console.error("⚠ Upgraded relay chain binary does not exist: ", upgraded_relay_chain_bin);
			return false;
		}

		if (!relay_chain.upgradeWasm) {
			console.error(`⚠ Missing the 'upgradeWasm' argument for the relay chain `
			+ `Please provide the path to the modified WASM code.`);
			return false;
		}
		const upgraded_relay_chain_wasm = resolve(config_dir, relay_chain.upgradeWasm);
		if (!fs.existsSync(upgraded_relay_chain_wasm)) {
			console.error("⚠ Upgraded relay chain WASM code does not exist: ", upgraded_relay_chain_wasm);
			return false;
		}

		/*if (!relay_chain.epochTime) {
			console.error(`Config file is missing its 'epochTime' argument for the relay chain! `
			+ `Please provide the time it would take for the chain's epochs to change.`);
			process.exit();
		}*/

		for (const parachain of config.parachains) {
			const { id, upgradeBin, upgradeWasm } = parachain as UpgradableResolvedParachainConfig;

			if (!upgradeBin) {
				console.error(`⚠ Missing the 'upgradeBin' argument for the parachain ${id}. `
				+ `Please provide the path to the modified binary.`);
				return false;
			}
			const bin = resolve(config_dir, upgradeBin);
			if (!fs.existsSync(bin)) {
				console.error("⚠ Upgraded parachain binary does not exist: ", bin);
				return false;
			}

			if (!upgradeWasm) {
				console.error(`⚠ Missing the 'upgradeWasm' argument for the parachain ${id}! `
				+ `Please provide the path to the modified binary.`);
				return false;
			}
			const wasm = resolve(config_dir, upgradeWasm);
			if (!fs.existsSync(wasm)) {
				console.error("⚠ Upgraded parachain WASM code does not exist: ", wasm);
				return false;
			}
		}
	}

	// Allow the config to not contain `simpleParachains`
	if (!config.simpleParachains) {
		config.simpleParachains = [];
	}

	return true;
}
