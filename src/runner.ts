#!/usr/bin/env node

import {
	startNode,
	startCollator,
	generateChainSpec,
	generateChainSpecRaw,
	giveKeyToCollator,
	exportGenesisWasm,
	exportGenesisState,
	startSimpleCollator,
	getParachainIdFromSpec,
	killProcess,
} from "./spawn";
import { 
	connect, 
	setBalance,
	upgradeRelayRuntime,
	upgradeParachainRuntime,
	getRelayInfo,
	getSpecVersion,
	getCodeValidationDelay,
} from "./rpc";
import { checkConfig } from "./check";
import {
	clearAuthorities,
	addAuthority,
	changeGenesisConfig,
	addGenesisParachain,
	addGenesisHrmpChannel,
	addBootNodes,
} from "./spec";
import { parachainAccount } from "./parachain";
import { ApiPromise } from "@polkadot/api";
import { randomAsHex } from "@polkadot/util-crypto";

import { resolve } from "path";
import fs from "fs";
import type {
	LaunchConfig,
	ResolvedParachainConfig,
	ResolvedSimpleParachainConfig,
	HrmpChannelsConfig,
	ResolvedLaunchConfig,
	UpgradableRelayChainConfig,
	UpgradableResolvedParachainConfig,
	KeyedParachainNodeConfig,
} from "./types";
import { keys as libp2pKeys } from "libp2p-crypto";
import { hexAddPrefix, hexStripPrefix, hexToU8a } from "@polkadot/util";
import PeerId from "peer-id";

function loadTypeDef(types: string | object): object {
	if (typeof types === "string") {
		// Treat types as a json file path
		try {
			const rawdata = fs.readFileSync(types, { encoding: "utf-8" });
			return JSON.parse(rawdata);
		} catch {
			console.error("failed to load parachain typedef file");
			process.exit(1);
		}
	} else {
		return types;
	}
}

function delay(ms: number) {
	return new Promise( resolve => setTimeout(resolve, ms) );
}

// keep track of registered parachains
let registeredParachains: { [key: string]: boolean } = {};

export async function run(config_dir: string, rawConfig: LaunchConfig): Promise<ResolvedLaunchConfig|null> {
	// We need to reset that variable when running a new network
	registeredParachains = {};
	// Verify that the `config.json` has all the expected properties.
	if (!checkConfig(rawConfig)) {
		return null;
	}
	const config = await resolveParachainId(config_dir, rawConfig);
	var bootnodes = await generateNodeKeys(config);

	const relay_chain_bin = resolve(config_dir, config.relaychain.bin);
	if (!fs.existsSync(relay_chain_bin)) {
		console.error("Relay chain binary does not exist: ", relay_chain_bin);
		process.exit();
	}
	const chain = config.relaychain.chain;
	await generateChainSpec(relay_chain_bin, chain);
	// -- Start Chain Spec Modify --
	clearAuthorities(`${chain}.json`);
	for (const node of config.relaychain.nodes) {
		await addAuthority(`${chain}.json`, node.name);
	}
	if (config.relaychain.genesis) {
		await changeGenesisConfig(`${chain}.json`, config.relaychain.genesis);
	}
	await addParachainsToGenesis(
		config_dir,
		`${chain}.json`,
		config.parachains,
		config.simpleParachains
	);
	if (config.hrmpChannels) {
		await addHrmpChannelsToGenesis(`${chain}.json`, config.hrmpChannels);
	}
	addBootNodes(`${chain}.json`, bootnodes);
	// -- End Chain Spec Modify --
	await generateChainSpecRaw(relay_chain_bin, chain);
	const spec = resolve(`${chain}-raw.json`);

	// First we launch each of the validators for the relay chain.
	for (const node of config.relaychain.nodes) {
		const { name, wsPort, rpcPort, port, flags, basePath, nodeKey } = node;
		console.log(
			`Starting Relaychain Node ${name}... wsPort: ${wsPort} rpcPort: ${rpcPort} port: ${port} nodeKey: ${nodeKey}`
		);
		// We spawn a `child_process` starting a node, and then wait until we
		// able to connect to it using PolkadotJS in order to know its running.
		startNode(
			relay_chain_bin,
			name,
			wsPort,
			rpcPort,
			port,
			nodeKey!, // by the time the control flow gets here it should be assigned.
			spec,
			flags,
			basePath
		);
	}

	// Connect to the first relay chain node to submit the extrinsic.
	let relayChainApi: ApiPromise = await connect(
		config.relaychain.nodes[0].wsPort,
		loadTypeDef(config.types)
	);

	// Then launch each parachain
	for (const parachain of config.parachains) {
		const { resolvedId, balance, chain: paraChain } = parachain;

		const bin = resolve(config_dir, parachain.bin);
		if (!fs.existsSync(bin)) {
			console.error("Parachain binary does not exist: ", bin);
			process.exit();
		}
		let account = parachainAccount(resolvedId);

		for (const node of parachain.nodes) {
			const { wsPort, port, flags, name, basePath, rpcPort } = node;
			console.log(
				`Starting a Collator for parachain ${resolvedId}: ${account}, Collator port : ${port} wsPort : ${wsPort} rpcPort : ${rpcPort}`
			);
			await startCollator(bin, wsPort, rpcPort, port, {
				name,
				spec,
				flags,
				chain: paraChain,
				basePath,
				onlyOneParachainNode: config.parachains.length === 1,
			});
		}

		// Allow time for the TX to complete, avoiding nonce issues.
		// TODO: Handle nonce directly instead of this.
		if (balance) {
			await setBalance(relayChainApi, account, balance, config.finalization);
		}
	}

	// Then launch each simple parachain (e.g. an adder-collator)
	if (config.simpleParachains) {
		for (const simpleParachain of config.simpleParachains) {
			const { id, resolvedId, port, balance } = simpleParachain;
			const bin = resolve(config_dir, simpleParachain.bin);
			if (!fs.existsSync(bin)) {
				console.error("Simple parachain binary does not exist: ", bin);
				process.exit();
			}

			let account = parachainAccount(resolvedId);
			console.log(`Starting Parachain ${resolvedId}: ${account}`);
			const skipIdArg = !id;
			await startSimpleCollator(bin, resolvedId, spec, port, skipIdArg);

			// Allow time for the TX to complete, avoiding nonce issues.
			// TODO: Handle nonce directly instead of this.
			if (balance) {
				await setBalance(relayChainApi, account, balance, config.finalization);
			}
		}
	}

	// We don't need the PolkadotJs API anymore
	await relayChainApi.disconnect();

	console.log("🚀 POLKADOT LAUNCH COMPLETE 🚀");

	return config;
}

const parachain_block_time = 12000;

export async function runThenTryUpgrade(config_dir: string, rawConfig: LaunchConfig) {
	// Check the config for existence and the required arguments
	if (!checkConfig(rawConfig, config_dir, true)) {
		return;
	}

	let config = await resolveParachainId(config_dir, rawConfig);
	
	// Generate chain specs for parachains that do not have them specified
	for (let parachain of config.parachains) {
		const { resolvedId, chain: parachainSpec } = parachain;

		if (!parachainSpec) {
			await generateChainSpecRaw(parachain.bin, "", resolvedId);
			parachain.chain = `${resolvedId}-raw.json`;
		} else {
			if (!fs.existsSync(resolve(config_dir, parachainSpec))) {
				console.error(`⚠ The specified chain spec file for parachain ${resolvedId} does not exist: ${parachainSpec}`);
				return false;
			}
		}
	}

	const relay_chain = config.relaychain as UpgradableRelayChainConfig;
	const upgraded_relay_chain_bin = resolve(config_dir, relay_chain.upgradeBin);
	const upgraded_relay_chain_wasm = resolve(config_dir, relay_chain.upgradeWasm);

	// Actually launch the nodes and get the resolved config. Since the config has been already checked, it must exist
	config = (await run(config_dir, rawConfig))!;
	
	// Send a specified keys to parachain nodes in case the parachain requires it
	for (let parachain of config.parachains) {
		for (let node of parachain.nodes) {
			await applyAuraKey(node as KeyedParachainNodeConfig, config_dir);
		}
	}

	console.log("\nNow preparing for runtime upgrade testing..."); // 🧶 

	const chain = config.relaychain.chain;
	const spec = resolve(`${chain}-raw.json`);

	let relay_chain_api: ApiPromise = await connect(
		config.relaychain.nodes[0].wsPort,
		loadTypeDef(config.types)
	);
	await getCodeValidationDelay(relay_chain_api);

	const { specVersion: relay_old_version, epochLength, blockTime } = await getRelayInfo(relay_chain_api);
	const epoch_time = epochLength * blockTime;

	await relay_chain_api.disconnect();
	// Prettify the output, otherwise potential warnings may spill over the next few lines
	await waitForExtraOutput();
	
	let node_count = 0;
	// Stop the relay nodes one by one with a delay equal to or higher than the epoch time
	for (const node of config.relaychain.nodes) {
		node_count++;
		console.log(`\n🚦 Starting timeout for the epoch change (node ${node_count}/${config.relaychain.nodes.length})...`);
		await waitWithTimer(epoch_time);
		
		const { name, wsPort, rpcPort, port, flags, basePath, nodeKey } = node;

		console.log("Stopping the next relay node...");
		killProcess(node.name);

		console.log(
			`Starting Relaychain Node ${name}... wsPort: ${wsPort} rpcPort: ${rpcPort} port: ${port} nodeKey: ${nodeKey}`
		);
		startNode(
			upgraded_relay_chain_bin,
			name,
			wsPort,
			rpcPort,
			port,
			nodeKey!, // by the time the control flow gets here it should be assigned.
			spec,
			flags,
			basePath
		);
	}

	console.log("\nAll relay nodes restarted with the new binaries.");

	const parachains_info: { [id: string]: { first_node: number, old_version: number, has_updated: boolean } } = {};
	// Then restart each parachain
	for (const parachain of config.parachains) {
		const { resolvedId, chain: parachainSpec } = parachain;
		const bin = resolve(config_dir, (parachain as UpgradableResolvedParachainConfig).upgradeBin);
		
		if (parachain.nodes.length > 0) {
			let parachain_api: ApiPromise = await connect(
				parachain.nodes[0].wsPort,
				loadTypeDef(config.types)
			);

			parachains_info[resolvedId] = {
				first_node: parachain.nodes[0].wsPort,
				old_version: await getSpecVersion(parachain_api),
				has_updated: false,
			};

			await parachain_api.disconnect();
			// Prettify the output, otherwise potential warnings may spill over the next few lines
			await waitForExtraOutput();
		}

		// Stop and restart each node
		for (const node of parachain.nodes) {
			const { wsPort, port, flags, name, basePath, rpcPort } = node;

			console.log("\nStopping the next collator node...");
			killProcess(node.wsPort);

			console.log(
				`Starting a Collator for parachain ${resolvedId}: Collator port : ${port} wsPort : ${wsPort} rpcPort : ${rpcPort}`
			);
			await startCollator(bin, wsPort, rpcPort, port, {
				name,
				spec,
				flags,
				chain: parachainSpec,
				basePath,
				onlyOneParachainNode: config.parachains.length === 1,
			});

			console.log("🚥 Waiting for the node to be brought up...");
			await waitWithTimer(parachain_block_time);

			await applyAuraKey(node as KeyedParachainNodeConfig, config_dir);
		}
	}

	console.log("\nAll collators restarted with the new binaries."); 

	// Simple parachains are not tested.

	let relay_upgrade_failed, parachains_upgrade_failed = false;

	console.log("\n🚦 Starting timeout for the next epoch before uprgading the relay runtime code...");
	await waitWithTimer(epoch_time);
	
	// Connect to alice on the relay (the first node, assumed to be the superuser) and run a forkless runtime upgrade
	relay_chain_api = await connect(
		config.relaychain.nodes[0].wsPort,
		loadTypeDef(config.types)
	);

	await upgradeRelayRuntime(relay_chain_api, upgraded_relay_chain_wasm, true);

	await relay_chain_api.disconnect();
	await waitForExtraOutput();
	// Re-establish connection to the node (strange behavior otherwise) and get the renewed relay info
	relay_chain_api = await connect(
		config.relaychain.nodes[0].wsPort,
		loadTypeDef(config.types)
	);
	
	let { 
		specVersion: relay_new_version, 
		epochLength: new_epoch_length, 
		blockTime: new_relay_block_time 
	} = await getRelayInfo(relay_chain_api);

	await relay_chain_api.disconnect();
	await waitForExtraOutput();
	// Re-establish connection to the node (strange behavior otherwise) and get the runtime upgrade validation delay for parachains
	relay_chain_api = await connect(
		config.relaychain.nodes[0].wsPort,
		loadTypeDef(config.types)
	);
	
	const code_validation_delay = Math.ceil(new_relay_block_time * (await getCodeValidationDelay(relay_chain_api)));// + parachain_block_time;

	await relay_chain_api.disconnect();
	await waitForExtraOutput();

	if (relay_old_version != relay_new_version) {
		console.log(`\n\🛰️ The relay has successfully upgraded from version ${relay_old_version} to ${relay_new_version}!`);
	} else {
		console.error(`\nThe relay failed to upgrade from version ${relay_old_version}!`);
		relay_upgrade_failed = true;
	}

	console.log("\n🚥 Starting timeout for the next epoch before uprgading the parachains code...");
	await waitWithTimer(new_epoch_length * new_relay_block_time);

	// For each parachain, connect, authorize and upgrade its runtime
	for (const parachain of config.parachains) {
		const { upgradeWasm: wasm, resolvedId } = parachain as UpgradableResolvedParachainConfig;
		
		if (parachains_info[resolvedId]) {
			let parachain_api: ApiPromise = await connect(
				parachains_info[resolvedId].first_node,
				loadTypeDef(config.types)
			);
			await upgradeParachainRuntime(parachain_api, wasm, true);
			await parachain_api.disconnect();
			await waitForExtraOutput();
		}
	}

	// Ping the the chains for the runtime upgrade after the minimal time and then every few blocks
	parachains_upgrade_failed = true;
	let first_pass = true;
	for (let try_n = 0; try_n < 3 && parachains_upgrade_failed; try_n++) {
		if (first_pass) {
			console.log("\n🚥 Waiting for the minimum code validation delay to verify that the parachain upgrades are successful...");
			await waitWithTimer(code_validation_delay);
			first_pass = false;
		} else {
			console.log("\n🚥 Waiting for a few blocks more to verify that the parachain upgrades are successful...");
			await waitWithTimer(parachain_block_time * 3);
		}
		parachains_upgrade_failed = false;
		// For each parachain, re-connect and verify that the runtime upgrade is successful
		for (const parachain of config.parachains) {
			const { resolvedId } = parachain as UpgradableResolvedParachainConfig;
			if (parachains_info[resolvedId].has_updated) continue;
			
			if (parachains_info[resolvedId]) {
				let parachain_api: ApiPromise = await connect(
					parachains_info[resolvedId].first_node,
					loadTypeDef(config.types)
				);

				const spec_version = await getSpecVersion(parachain_api);
				console.log(spec_version);

				await parachain_api.disconnect();
				await waitForExtraOutput();

				if (spec_version != parachains_info[resolvedId].old_version) {
					console.log(`\n\🛰️ Parachain ${resolvedId} has successfully upgraded from `
					+ `version ${parachains_info[resolvedId].old_version} to ${spec_version}!`);
					parachains_info[resolvedId].has_updated = true;
				} else {
					console.error(`\nThe parachain ${resolvedId} failed to upgrade from version ${parachains_info[resolvedId].old_version}!`);
					//process.exit();
					parachains_upgrade_failed = true;
				}
			}
		}
	}

	if (parachains_upgrade_failed || relay_upgrade_failed) {
		console.log("\n🚧 POLKADOT RUNTIME UPGRADE TESTING FAILED 🚧");
	} else {
		console.log("\n🛸 POLKADOT RUNTIME UPGRADE TESTING COMPLETE 🛸");
	}
}

// In case of asynchronous output, wait for a fraction of a second to let it print
async function waitForExtraOutput() {
	return delay(250);
}

// Display the time left before proceeding
async function waitWithTimer(time: number) {
	let secondsTotal = Math.ceil(time / 1000);
	for (let i = secondsTotal; i > 0; i--) {
		// could also introduce hours, but wth
		const seconds = i % 60;
		process.stdout.write(`Time left: ${Math.floor(i / 60)}:${seconds < 10 ? '0' + seconds : seconds}`);
		await delay(1000);
		process.stdout.clearLine(0);
		process.stdout.cursorTo(0);
	}
}

// Check and insert a node's Aura key if present
async function applyAuraKey(node: KeyedParachainNodeConfig, config_dir: string) {
	const { rpcPort, auraKey } = node as KeyedParachainNodeConfig;
	if (auraKey) {
		const key = resolve(config_dir, auraKey);
		if (!fs.existsSync(key)) {
			console.error(`⚠ The specified Aura key does not exist: ${auraKey}`);
		} else if (!rpcPort) {
			console.error(`⚠ The RPC port has not been specified whereas the Aura key exists: ${auraKey}`);
		} else {
			await giveKeyToCollator(rpcPort, key);
		}
	}
}

interface GenesisParachain {
	isSimple: boolean;
	resolvedId: string;
	chain?: string;
	bin: string;
}

async function addParachainsToGenesis(
	config_dir: string,
	spec: string,
	parachains: ResolvedParachainConfig[],
	simpleParachains: ResolvedSimpleParachainConfig[]
) {
	console.log("\n⛓ Adding Genesis Parachains");

	// Collect all paras into a single list
	let x: GenesisParachain[] = parachains.map((p) => {
		return { isSimple: false, ...p };
	});
	let y: GenesisParachain[] = simpleParachains.map((p) => {
		return { isSimple: true, ...p };
	});
	let paras = x.concat(y);

	for (const parachain of paras) {
		const { resolvedId, chain } = parachain;
		const bin = resolve(config_dir, parachain.bin);
		if (!fs.existsSync(bin)) {
			console.error("Parachain binary does not exist: ", bin);
			process.exit();
		}
		// If it isn't registered yet, register the parachain in genesis
		if (!registeredParachains[resolvedId]) {
			// Get the information required to register the parachain in genesis.
			let genesisState: string;
			let genesisWasm: string;
			try {
				genesisState = await exportGenesisState(bin, chain);
				genesisWasm = await exportGenesisWasm(bin, chain);
			} catch (err) {
				console.error(err);
				process.exit(1);
			}

			await addGenesisParachain(
				spec,
				resolvedId,
				genesisState,
				genesisWasm,
				true
			);
			registeredParachains[resolvedId] = true;
		}
	}
}

async function addHrmpChannelsToGenesis(
	spec: string,
	hrmpChannels: HrmpChannelsConfig[]
) {
	console.log("⛓ Adding Genesis HRMP Channels");
	for (const hrmpChannel of hrmpChannels) {
		await addGenesisHrmpChannel(spec, hrmpChannel);
	}
}

// Resolves parachain id from chain spec if not specified
async function resolveParachainId(
	config_dir: string,
	config: LaunchConfig
): Promise<ResolvedLaunchConfig> {
	console.log(`\n🧹 Resolving parachain id...`);
	const resolvedConfig = config as ResolvedLaunchConfig;
	for (const parachain of resolvedConfig.parachains) {
		if (parachain.resolvedId) {
			continue;
		} else if (parachain.id) {
			parachain.resolvedId = parachain.id;
		} else {
			const bin = resolve(config_dir, parachain.bin);
			const paraId = await getParachainIdFromSpec(bin, parachain.chain);
			console.log(`  ✓ Read parachain id for ${parachain.bin}: ${paraId}`);
			parachain.resolvedId = paraId.toString();
		}
	}
	for (const parachain of resolvedConfig.simpleParachains) {
		parachain.resolvedId = parachain.id;
	}
	return resolvedConfig;
}

async function generateNodeKeys(
	config: ResolvedLaunchConfig
): Promise<string[]> {
	var bootnodes = [];
	for (const node of config.relaychain.nodes) {
		if (!node.nodeKey) {
			node.nodeKey = hexStripPrefix(randomAsHex(32));
		}

		let pair = await libp2pKeys.generateKeyPairFromSeed(
			"Ed25519",
			hexToU8a(hexAddPrefix(node.nodeKey!)),
			1024
		);
		let peerId: PeerId = await PeerId.createFromPrivKey(pair.bytes);
		bootnodes.push(
			`/ip4/127.0.0.1/tcp/${node.port}/p2p/${peerId.toB58String()}`
		);
	}

	return bootnodes;
}
