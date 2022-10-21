import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/api";
import { KeyringPair } from "@polkadot/keyring/types";
import { cryptoWaitReady, blake2AsHex } from "@polkadot/util-crypto";
import fs from "fs";
import filterConsole from "filter-console";

// Hide some warning messages that are coming from Polkadot JS API.
// TODO: Make configurable.
filterConsole([
	`code: '1006' reason: 'connection failed'`,
	`Unhandled promise rejections`,
	`UnhandledPromiseRejectionWarning:`,
	`Unknown types found`,
]);

// Connect to a local Substrate node. This function wont resolve until connected.
// TODO: Add a timeout where we know something went wrong so we don't wait forever.
export async function connect(port: number, types: any) {
	const provider = new WsProvider("ws://127.0.0.1:" + port);
	const api = await ApiPromise.create({
		provider,
		types,
		throwOnConnect: false,
	});
	return api;
}

// Get the genesis header of a node. Used for registering a parachain on the relay chain.
export async function getHeader(api: ApiPromise) {
	let genesis_hash = await api.rpc.chain.getBlockHash(0);
	let genesis_header = await api.rpc.chain.getHeader(genesis_hash);
	return genesis_header.toHex();
}

// Submit an extrinsic to the relay chain to register a parachain.
// Uses the Alice account which is known to be Sudo for the relay chain.
export async function registerParachain(
	api: ApiPromise,
	id: string,
	wasm: string,
	header: string,
	finalization: boolean = false
) {
	await cryptoWaitReady();

	const alice = privateKey("//Alice");

	let paraGenesisArgs = {
		genesis_head: header,
		validation_code: wasm,
		parachain: true,
	};
	let genesis = api.createType("ParaGenesisArgs", paraGenesisArgs);

	console.log(`--- Submitting extrinsic to register parachain ${id}. ---`);
	await executeTransaction(api, alice, api.tx.sudo.sudo(api.tx.parasSudoWrapper.sudoScheduleParaInitialize(id, genesis)), finalization);
}

// Set the balance of an account on the relay chain.
export async function setBalance(
	api: ApiPromise,
	who: string,
	value: string,
	finalization: boolean = false
) {
	await cryptoWaitReady();

	const alice = privateKey('//Alice');

	console.log(`--- Submitting extrinsic to set balance of ${who} to ${value}. ---`);
	await executeTransaction(api, alice, api.tx.sudo.sudo(api.tx.balances.setBalance(who, value, 0)), finalization);
}

// Set the balance of an account on the relay chain.
export async function executeTransaction(
	api: ApiPromise,
	sender: KeyringPair,
	tx: any,
	finalization: boolean = false
) {
	return new Promise<void>(async (resolvePromise, reject) => {
		await cryptoWaitReady();

		const nonce = Number((await api.query.system.account(sender.address) as any).nonce);

		const unsub = await tx
			.signAndSend(sender, { nonce: nonce, era: 0 }, (result: any) => {
				console.log(`Current status is ${result.status}`);
				if (result.status.isInBlock) {
					console.log(
						`Transaction included at blockHash ${result.status.asInBlock}`
					);
					if (finalization) {
						console.log("Waiting for finalization...");
					} else {
						unsub();
						resolvePromise();
					}
				} else if (result.status.isFinalized) {
					console.log(
						`Transaction finalized at blockHash ${result.status.asFinalized}`
					);
					unsub();
					resolvePromise();
				} else if (result.isError) {
					console.log(`Transaction Error`);
					reject(`Transaction Error`);
				}
			});
	});
}

export function privateKey(seed: string): KeyringPair {
	const keyring = new Keyring({ type: "sr25519" });
	const user = keyring.addFromUri(seed);
	return user;
}

// Perform a forkless runtime upgrade on the relay
export async function upgradeRelayRuntime(
	api: ApiPromise,
	wasm: string,
	finalization: boolean = false,
	old_tag?: string,
	new_tag?: string,
) {
	await cryptoWaitReady();

	const alice = privateKey("//Alice");

	const code = fs.readFileSync(wasm).toString('hex');

	console.log(`--- Upgrading the relay chain runtime from ${old_tag ? old_tag : wasm} ${new_tag ? `to ${new_tag}` : ""}. ---`);
	await executeTransaction(api, alice, api.tx.sudo.sudoUncheckedWeight(api.tx.system.setCode(`0x${code}`), 0));
}

// Perform a forkless runtime upgrade on a parachain
export async function upgradeParachainRuntime(
	api: ApiPromise,
	wasm: string,
	finalization: boolean = true,
	old_tag?: string,
	new_tag?: string,
) {
	const code = fs.readFileSync(wasm);
	const codeHash = blake2AsHex(code); // 256

	await cryptoWaitReady();

	const alice = privateKey("//Alice");

	console.log(`--- Authorizing the parachain runtime upgrade from ${old_tag ? old_tag : wasm} ${new_tag ? `to ${new_tag}` : ""}. ---`);
	await executeTransaction(api, alice, api.tx.sudo
		.sudoUncheckedWeight(api.tx.parachainSystem.authorizeUpgrade(codeHash), 0), finalization);

	console.log(`--- Upgrading the parachain runtime. ---`);
	await executeTransaction(api, alice, api.tx.sudo
		.sudoUncheckedWeight(api.tx.parachainSystem.enactAuthorizedUpgrade(`0x${code.toString('hex')}`), 0));
}

export interface RelayInfo {
	specVersion: number,
	epochLength: number,
	blockTime: number,
}

export async function getSpecVersion(
	api: ApiPromise,
): Promise<number> {
	return (api.consts.system.version as any).specVersion.toNumber();
}

export async function getRelayInfo(
	api: ApiPromise,
): Promise<RelayInfo> {
	const info = {
		specVersion: (api.consts.system.version as any).specVersion.toNumber(),
		epochLength: (api.consts.babe.epochDuration as any).toNumber(),
		blockTime: (api.consts.babe.expectedBlockTime as any).toNumber(),
	};
	return info;
}

export async function getCodeValidationDelay(
	api: ApiPromise,
): Promise<number> {
	const { validationUpgradeDelay, minimumValidationUpgradeDelay } = (await api.query.configuration.activeConfig()).toJSON() as any;
	let delay = 0;
	if (validationUpgradeDelay !== undefined) {
		delay = validationUpgradeDelay;
		if (minimumValidationUpgradeDelay !== undefined) {
			delay = Math.max(delay, minimumValidationUpgradeDelay);
		}
	}
	return delay;
}

export async function sendHrmpMessage(
	api: ApiPromise,
	recipient: string,
	data: string,
	finalization: boolean = false
) {
	await cryptoWaitReady();

	const alice = privateKey("//Alice");

	let hrmpMessage = {
		recipient: recipient,
		data: data,
	};
	let message = api.createType("OutboundHrmpMessage", hrmpMessage);

	console.log(`--- Sending a message to ${recipient}. ---`);
	await executeTransaction(api, alice, api.tx.sudo
		.sudo(api.tx.messageBroker.sudoSendHrmpMessage(message)), finalization);
}
