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
	getGitRepositoryTag,
	runInitializer,
} from "./spawn";
import {
	connect,
	setBalance,
	upgradeRelayRuntime,
	upgradeParachainRuntime,
	getRelayInfo,
	getSpecVersion,
	getCodeValidationDelay,
	executeTransaction,
	privateKey,
} from "./rpc";
import { checkConfig } from "./check";
import {
	clearAuthorities,
	addAuthority,
	changeGenesisConfig,
	addGenesisParachain,
	addGenesisHrmpChannel,
	addBootNodes,
	editSpec,
} from "./spec";
import { parachainAccount } from "./parachain";
import { ApiPromise } from "@polkadot/api";
import { randomAsHex, encodeAddress } from "@polkadot/util-crypto";

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
import { TypeRegistry } from "@polkadot/types";

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
	return new Promise(resolve => setTimeout(resolve, ms));
}

// keep track of registered parachains
let registeredParachains: { [key: string]: boolean } = {};

export async function run(config_dir: string, rawConfig: LaunchConfig): Promise<ResolvedLaunchConfig | null> {
	// We need to reset that variable when running a new network
	registeredParachains = {};
	// Verify that the `config.json` has all the expected properties.
	if (!checkConfig(rawConfig)) {
		return null;
	}
	const config = await resolveParachainSpecs(config_dir, rawConfig);
	var bootnodes = await generateNodeKeys(config);

	const relay_chain_bin = resolve(config_dir, config.relaychain.bin);
	if (!fs.existsSync(relay_chain_bin)) {
		console.error("Relay chain binary does not exist: ", relay_chain_bin);
		process.exit();
	}
	const specName = config.relaychain.chain;
	let specFile = await generateChainSpec(relay_chain_bin, specName, specName);
	// -- Start Chain Spec Modify --
	clearAuthorities(specFile);
	for (const node of config.relaychain.nodes) {
		await addAuthority(specFile, node.name);
	}
	if (config.relaychain.genesis) {
		await changeGenesisConfig(specFile, config.relaychain.genesis);
	}
	await addParachainsToGenesis(
		config_dir,
		specFile,
		config.parachains,
		config.simpleParachains
	);
	if (config.hrmpChannels) {
		await addHrmpChannelsToGenesis(specFile, config.hrmpChannels);
	}
	addBootNodes(specFile, bootnodes);
	if (config.relaychain.chainInitializer) {
		console.log('  Initializing spec');
		specFile = await runInitializer(
			config.relaychain.chainInitializer,
			[
				['spec', specFile],
			],
			`${specName}-processed`,
		);
		console.log(`  ✓ Processed spec for ${config.relaychain.bin}`);
	}
	// -- End Chain Spec Modify --
	let rawSpecFile = await generateChainSpecRaw(relay_chain_bin, specName, specFile);
	if (config.relaychain.chainRawInitializer) {
		console.log('  Initializing raw spec');
		rawSpecFile = await runInitializer(
			config.relaychain.chainRawInitializer,
			[
				['spec', specFile],
				['rawSpec', rawSpecFile],
			],
			`${specName}-processed-raw`,
		);
		console.log(`  ✓ Processed raw spec for ${config.relaychain.bin}`);
	}

	// First we launch each of the validators for the relay chain.
	for (const node of config.relaychain.nodes) {
		const { name, wsPort, rpcPort, port, flags, basePath, nodeKey } = node;
		const address = encodeAddress(hexAddPrefix(nodeKey!)); // by the time the control flow gets here it should be assigned.
		console.log(
			`Starting Relaychain Node ${name}: ${address}, wsPort: ${wsPort} rpcPort: ${rpcPort} port: ${port} nodeKey: ${nodeKey}`
		);
		// We spawn a `child_process` starting a node, and then wait until we
		// able to connect to it using PolkadotJS in order to know its running.
		startNode(
			relay_chain_bin,
			name,
			wsPort,
			rpcPort,
			port,
			nodeKey!,
			rawSpecFile,
			flags,
			basePath
		);
	}

	// Connect to the first relay chain node to submit the extrinsic.
	let relayChainApi: ApiPromise = await connect(
		config.relaychain.nodes[0].wsPort,
		loadTypeDef(config.types)
	);

	const relayRawSpecFile = rawSpecFile;

	// Then launch each parachain
	for (const parachain of config.parachains) {
		const { resolvedId, balance, resolvedSpec } = parachain;
		const name = `para-${resolvedId}`;

		const bin = resolve(config_dir, parachain.bin);
		if (!fs.existsSync(bin)) {
			console.error("Parachain binary does not exist: ", bin);
			process.exit();
		}
		let account = parachainAccount(resolvedId);

		for (const node of parachain.nodes) {
			const { wsPort, port, flags, name, basePath, rpcPort } = node;
			console.log(`Starting a Collator for parachain ${resolvedId}: ${account}, Collator port : ${port} wsPort : ${wsPort} rpcPort : ${rpcPort}`);
			await startCollator(bin, wsPort, rpcPort, port, {
				name,
				relaySpec: relayRawSpecFile,
				spec: resolvedSpec,
				flags,
				basePath,
				onlyOneParachainNode: parachain.nodes.length === 1,
			});
			// Send a specified key to parachain nodes in case the parachain requires it
			await applyAuraKey(node as KeyedParachainNodeConfig, config_dir);
		}

		if (parachain.prepopulated) {
			console.log('Restoring parachain state, using data from first collator');
			let parachainApi: ApiPromise = await connect(
				parachain.nodes[0].wsPort,
				{}
			);
			const block = await parachainApi.rpc.chain.getBlock();
			const head = block.block.header.toHex();
			const code = (await parachainApi.rpc.state.getStorage(':code') as any).toHex();

			const alice = privateKey('//Alice');
			console.log(`--- Submitting extrinsic to force head ---`);
			await executeTransaction(relayChainApi, alice, relayChainApi.tx.sudo.sudo((relayChainApi.tx as any).paras.forceSetCurrentHead(resolvedId, head)), true);
			console.log(`--- Submitting extrinsic to force code ---`);
			await executeTransaction(relayChainApi, alice, relayChainApi.tx.sudo.sudo((relayChainApi.tx as any).paras.forceSetCurrentCode(resolvedId, `0x${code}`)), true);

			await parachainApi.disconnect();
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
			await startSimpleCollator(bin, resolvedId, relayRawSpecFile, port, skipIdArg);

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

export async function runThenTryUpgrade(config_dir: string, raw_config: LaunchConfig, should_wait: boolean) {
	// Check the config for existence and the required arguments
	if (!checkConfig(raw_config, config_dir, true, false)) {
		return;
	}

	let config = await resolveParachainSpecs(config_dir, raw_config);

	// Generate chain specs for parachains that do not have them specified
	for (let parachain of config.parachains) {
		const { resolvedId, chain: parachainSpec } = parachain;

		if (!parachainSpec) {
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

	// Fetch git tags for better recognition. A specific request.
	const relay_old_tag = await getGitRepositoryTag(relay_chain.bin);
	const relay_new_tag = await getGitRepositoryTag(upgraded_relay_chain_bin);

	// Actually launch the nodes and get the resolved config. Since the config has been already checked, it must exist
	config = (await run(config_dir, raw_config))!;

	if (should_wait) {
		const { Confirm } = require('enquirer');
		let is_ready = false;

		const prompt = new Confirm({
			name: 'confirm',
			message: 'Submit to continue, or send a "SIGUSR1" signal (now is a good time to launch any migration tests)...'
		});

		prompt.run().then(() => is_ready = true);

		process.on("SIGUSR1", () => {
			console.log("Signal received!");
			prompt.submit();
			is_ready = true;
		});

		while (!is_ready) {
			await delay(1000);
		}
	}

	console.log("\nNow preparing for runtime upgrade testing..."); // 🧶

	const chain = config.relaychain.chain;
	const spec = resolve(`${chain}-raw.json`);

	// Fetch information on the relay chain specifics
	let relay_chain_api: ApiPromise = await connect(
		config.relaychain.nodes[0].wsPort,
		loadTypeDef(config.types)
	);

	const { specVersion: relay_old_version, epochLength, blockTime } = await getRelayInfo(relay_chain_api);
	const epoch_time = epochLength * blockTime;

	await relay_chain_api.disconnect();
	// Prettify the output, otherwise potential warnings may spill over the next few lines
	await waitForExtraOutput();

	let node_count = 0;
	// Stop the relay nodes one by one with a delay equal to or higher than the epoch time
	for (const node of config.relaychain.nodes) {
		node_count++;
		console.log(`\n🚦 Starting timeout for the epoch change (` +
			(relay_old_tag ? `${relay_old_tag} > ${relay_new_tag}, ` : ``) +
			`node ${node_count}/${config.relaychain.nodes.length})...`);
		await waitWithTimer(epoch_time);

		const { name, wsPort, rpcPort, port, flags, basePath, nodeKey } = node;

		console.log("Stopping the next relay node...");
		killProcess(node.name);

		const address = encodeAddress(hexAddPrefix(nodeKey!));
		console.log(
			`Starting Relaychain Node ${name}: ${address}, wsPort: ${wsPort} rpcPort: ${rpcPort} port: ${port} nodeKey: ${nodeKey}`
		);
		startNode(
			upgraded_relay_chain_bin,
			name,
			wsPort,
			rpcPort,
			port,
			nodeKey!,
			spec,
			flags,
			basePath
		);
	}

	console.log(`\nAll relay nodes restarted with the new binaries${relay_new_tag ? ` (${relay_new_tag})` : ``}.`);

	const parachains_info: {
		[id: string]: {
			first_node: number,
			old_version: number,
			has_updated: boolean,
			old_tag: string,
			new_tag: string,
		}
	} = {};

	// Then restart each parachain
	for (const parachain of config.parachains) {
		const { resolvedId, resolvedSpec, bin: old_bin } = parachain;
		const new_bin = resolve(config_dir, (parachain as UpgradableResolvedParachainConfig).upgradeBin);

		if (parachain.nodes.length > 0) {
			let parachain_api: ApiPromise = await connect(
				parachain.nodes[0].wsPort,
				loadTypeDef(config.types)
			);

			parachains_info[resolvedId] = {
				first_node: parachain.nodes[0].wsPort,
				old_version: await getSpecVersion(parachain_api),
				has_updated: false,
				old_tag: await getGitRepositoryTag(old_bin),
				new_tag: await getGitRepositoryTag(new_bin),
			};

			await parachain_api.disconnect();
			// Prettify the output, otherwise potential warnings may spill over the next few lines
			await waitForExtraOutput();
		}

		// Stop and restart each node
		for (const node of parachain.nodes) {
			const { wsPort, port, flags, name, basePath, rpcPort } = node;
			let account = parachainAccount(resolvedId); // todo

			console.log("\nStopping the next collator node...");
			killProcess(node.wsPort);

			console.log(
				`Starting a Collator for parachain ${resolvedId}: ${account}, Collator port : ${port} wsPort : ${wsPort} rpcPort : ${rpcPort}`
			);
			await startCollator(new_bin, wsPort, rpcPort, port, {
				name,
				relaySpec: spec,
				flags,
				spec: resolvedSpec,
				basePath,
				onlyOneParachainNode: config.parachains.length === 1,
			});

			console.log("🚥 Waiting for the node to be brought up...");
			await waitWithTimer(parachain_block_time);

			// Send specified keys to parachain nodes in case the parachain requires it
			await applyAuraKey(node as KeyedParachainNodeConfig, config_dir);
		}
	}

	console.log("\nAll parachain collators restarted with the new binaries.");

	// Simple parachains are not tested.

	let relay_upgrade_failed, parachains_upgrade_failed = false;

	console.log(`\n🚦 Starting timeout for the next epoch before upgrading the relay runtime code` +
		(relay_old_tag ? ` (${relay_old_tag} > ${relay_new_tag})` : ``) + `...`);
	await waitWithTimer(epoch_time);

	// Connect to alice on the relay (the first node, assumed to be the superuser) and run a forkless runtime upgrade
	relay_chain_api = await connect(
		config.relaychain.nodes[0].wsPort,
		loadTypeDef(config.types)
	);

	await upgradeRelayRuntime(relay_chain_api, upgraded_relay_chain_wasm, true, relay_old_tag, relay_new_tag);

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
		console.log(`\n\🛰️  The relay has successfully upgraded from version ${relay_old_version} to ${relay_new_version}!`);
	} else {
		console.error(`\nThe relay failed to upgrade from version ${relay_old_version}!`);
		relay_upgrade_failed = true;
	}

	console.log("\n🚥 Starting timeout for the next epoch before upgrading the parachains code...");
	await waitWithTimer(new_epoch_length * new_relay_block_time);

	// For each parachain, connect, authorize and upgrade its runtime
	for (const parachain of config.parachains) {
		const { upgradeWasm: wasm, resolvedId } = parachain as UpgradableResolvedParachainConfig;

		if (parachains_info[resolvedId]) {
			let parachain_api: ApiPromise = await connect(
				parachains_info[resolvedId].first_node,
				loadTypeDef(config.types)
			);
			await upgradeParachainRuntime(parachain_api, wasm, true, parachains_info[resolvedId].old_tag, parachains_info[resolvedId].new_tag);
			await parachain_api.disconnect();
			await waitForExtraOutput();
		}
	}

	// Ping the the chains for the runtime upgrade after the minimal time and then every few blocks
	parachains_upgrade_failed = true;
	let first_pass = true;
	for (let try_n = 0; try_n < 3 && parachains_upgrade_failed; try_n++) {
		if (first_pass) {
			console.log("\n🚥 Waiting for the minimum code validation delay before the parachain can upgrade...");
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

				await parachain_api.disconnect();
				await waitForExtraOutput();

				if (spec_version != parachains_info[resolvedId].old_version) {
					console.log(`\n\🛰️  Parachain ${resolvedId} has successfully upgraded from ` +
						`version ${parachains_info[resolvedId].old_version} to ${spec_version}!`);
					parachains_info[resolvedId].has_updated = true;
				} else {
					console.error(`\nParachain ${resolvedId} failed to upgrade from version ${parachains_info[resolvedId].old_version}!`);
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

export async function runThenTryUpgradeParachains(config_dir: string, raw_config: LaunchConfig, should_wait: boolean) {
	// Check the config for existence and the required arguments
	if (!checkConfig(raw_config, config_dir, true, true)) {
		return;
	}

	let config = await resolveParachainSpecs(config_dir, raw_config);

	// Actually launch the nodes and get the resolved config. Since the config has been already checked, it must exist
	config = (await run(config_dir, raw_config))!;

	if (should_wait) {
		const { Confirm } = require('enquirer');
		let is_ready = false;

		const prompt = new Confirm({
			name: 'confirm',
			message: 'Submit to continue, or send a "SIGUSR1" signal (now is a good time to launch any migration tests)...'
		});

		prompt.run().then(() => is_ready = true);

		process.on("SIGUSR1", () => {
			console.log("Signal received!");
			prompt.submit();
			is_ready = true;
		});

		while (!is_ready) {
			await delay(1000);
		}
	}

	console.log("\nNow preparing for runtime upgrade testing..."); // 🧶

	const chain = config.relaychain.chain;
	const spec = resolve(`${chain}-raw.json`);

	// Fetch information on the relay chain specifics
	let relay_chain_api: ApiPromise = await connect(
		config.relaychain.nodes[0].wsPort,
		loadTypeDef(config.types)
	);

	const { epochLength, blockTime } = await getRelayInfo(relay_chain_api);
	const epoch_time = epochLength * blockTime;

	await relay_chain_api.disconnect();
	// Prettify the output, otherwise potential warnings may spill over the next few lines
	await waitForExtraOutput();

	const parachains_info: {
		[id: string]: {
			first_node: number,
			old_version: number,
			has_updated: boolean,
			old_tag: string,
			new_tag: string,
		}
	} = {};


	// Then restart each parachain
	for (const parachain of config.parachains) {
		const { resolvedId, resolvedSpec, bin: old_bin } = parachain;
		const new_bin = resolve(config_dir, (parachain as UpgradableResolvedParachainConfig).upgradeBin);

		if (parachain.nodes.length > 0) {
			let parachain_api: ApiPromise = await connect(
				parachain.nodes[0].wsPort,
				loadTypeDef(config.types)
			);

			parachains_info[resolvedId] = {
				first_node: parachain.nodes[0].wsPort,
				old_version: await getSpecVersion(parachain_api),
				has_updated: false,
				old_tag: await getGitRepositoryTag(old_bin),
				new_tag: await getGitRepositoryTag(new_bin),
			};

			await parachain_api.disconnect();
			// Prettify the output, otherwise potential warnings may spill over the next few lines
			await waitForExtraOutput();
		}

		// Stop and restart each node
		for (const node of parachain.nodes) {
			const { wsPort, port, flags, name, basePath, rpcPort } = node;
			let account = parachainAccount(resolvedId); // todo

			console.log("\nStopping the next collator node...");
			killProcess(node.wsPort);

			console.log(
				`Starting a Collator for parachain ${resolvedId}: ${account}, Collator port : ${port} wsPort : ${wsPort} rpcPort : ${rpcPort}`
			);
			await startCollator(new_bin, wsPort, rpcPort, port, {
				name,
				relaySpec: spec,
				flags,
				spec: resolvedSpec,
				basePath,
				onlyOneParachainNode: config.parachains.length === 1,
			});

			console.log("🚥 Waiting for the node to be brought up...");
			await waitWithTimer(parachain_block_time);

			// Send specified keys to parachain nodes in case the parachain requires it
			await applyAuraKey(node as KeyedParachainNodeConfig, config_dir);
		}
	}

	console.log("\nAll parachain collators restarted with the new binaries.");

	// Simple parachains are not tested.

	let parachains_upgrade_failed = false;
	// Re-establish connection to the node (strange behavior otherwise) and get the runtime upgrade validation delay for parachains
	relay_chain_api = await connect(
		config.relaychain.nodes[0].wsPort,
		loadTypeDef(config.types)
	);

	const code_validation_delay = Math.ceil(blockTime * (await getCodeValidationDelay(relay_chain_api)));// + parachain_block_time;

	await relay_chain_api.disconnect();
	await waitForExtraOutput();

	console.log("\n🚥 Starting timeout for the next epoch before upgrading the parachains code...");
	await waitWithTimer(epoch_time);

	// For each parachain, connect, authorize and upgrade its runtime
	for (const parachain of config.parachains) {
		const { upgradeWasm: wasm, resolvedId } = parachain as UpgradableResolvedParachainConfig;

		if (parachains_info[resolvedId]) {
			let parachain_api: ApiPromise = await connect(
				parachains_info[resolvedId].first_node,
				loadTypeDef(config.types)
			);
			await upgradeParachainRuntime(parachain_api, wasm, true, parachains_info[resolvedId].old_tag, parachains_info[resolvedId].new_tag);
			await parachain_api.disconnect();
			await waitForExtraOutput();
		}
	}

	// Ping the the chains for the runtime upgrade after the minimal time and then every few blocks
	parachains_upgrade_failed = true;
	let first_pass = true;
	for (let try_n = 0; try_n < 3 && parachains_upgrade_failed; try_n++) {
		if (first_pass) {
			console.log("\n🚥 Waiting for the minimum code validation delay before the parachain can upgrade...");
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

				await parachain_api.disconnect();
				await waitForExtraOutput();

				if (spec_version != parachains_info[resolvedId].old_version) {
					console.log(`\n\🛰️  Parachain ${resolvedId} has successfully upgraded from ` +
						`version ${parachains_info[resolvedId].old_version} to ${spec_version}!`);
					parachains_info[resolvedId].has_updated = true;
				} else {
					console.error(`\nParachain ${resolvedId} failed to upgrade from version ${parachains_info[resolvedId].old_version}!`);
					parachains_upgrade_failed = true;
				}
			}
		}
	}

	if (parachains_upgrade_failed) {
		console.log("\n🚧 PARACHAINS' RUNTIME UPGRADE TESTING FAILED 🚧");
	} else {
		console.log("\n🛸 PARACHAINS' RUNTIME UPGRADE TESTING COMPLETE 🛸");
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
		const text = `Time left: ${Math.floor(i / 60)}:${seconds < 10 ? '0' + seconds : seconds}`;
		if (process.stdout.isTTY)
			process.stdout.write(text);
		else if (seconds % 10 == 0)
			console.log(text);
		await delay(1000);
		if (process.stdout.isTTY) {
			process.stdout.clearLine(0);
			process.stdout.cursorTo(0);
		}
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
	resolvedSpec?: string;
	chain?: string;
	bin: string;
	prepopulated?: boolean;
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
		const { resolvedId, resolvedSpec, chain, prepopulated } = parachain;
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
			if (prepopulated) {
				// We will later upload this data to relay
				genesisState = '0x';
				// Polkadot has "empty validation code is not allowed in genesis" check
				genesisWasm = '0x00';
			} else {
				try {
					genesisState = await exportGenesisState(bin, resolvedSpec || chain);
					genesisWasm = await exportGenesisWasm(bin, resolvedSpec || chain);
				} catch (err) {
					console.error(err);
					process.exit(1);
				}
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
async function resolveParachainSpecs(
	config_dir: string,
	config: LaunchConfig
): Promise<ResolvedLaunchConfig> {
	console.log(`\n🧹 Resolving parachain specs...`);
	const resolvedConfig = config as ResolvedLaunchConfig;
	for (const parachain of resolvedConfig.parachains) {
		const { bin, id, chain } = parachain;
		const name = `para-${id || chain || `unnamed-${Date.now()}-$`}`

		let specFile = await generateChainSpec(bin, name, chain);
		if (parachain.chainInitializer) {
			console.log('  Initializing spec');
			specFile = await runInitializer(
				parachain.chainInitializer,
				[
					['spec', specFile],
				],
				`${name}-processed`,
			);
			console.log(`  ✓ Processed spec for ${parachain.bin}`);
		}

		let rawSpecFile = await generateChainSpecRaw(bin, name, specFile);
		await editSpec(rawSpecFile, spec => {
			let registry = new TypeRegistry();
			if ('para_id' in spec)
				spec.para_id = +id!;
			if ('paraId' in spec)
				spec.paraId = +id!;
			const encodedId = registry.createType('u32', +id!).toHex(true);
			// ParachainInfo.ParachainId
			spec.genesis.raw.top['0x0d715f2646c8f85767b5d2764bb2782604a74d81251e398fd8a0a4d55023bb3f'] = encodedId;
		});
		if (parachain.chainRawInitializer) {
			console.log('  Initializing raw spec');
			rawSpecFile = await runInitializer(
				parachain.chainRawInitializer,
				[
					['spec', specFile],
					['rawSpec', rawSpecFile],
				],
				`${name}-processed-raw`,
			);
			console.log(`  ✓ Processed raw spec for ${parachain.bin}`);
		}
		parachain.resolvedSpec = rawSpecFile;

		if (parachain.resolvedId) {
			continue;
		} else if (parachain.id) {
			parachain.resolvedId = parachain.id;
		} else {
			const paraId = await getParachainIdFromSpec(bin, parachain.resolvedSpec);
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
