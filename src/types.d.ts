export interface CollatorOptions {
	name?: string;
	/**
	 * Path to relay chain raw spec file
	 */
	relaySpec?: string;
	/**
	 * Path to parachain raw spec file
	 */
	spec?: string;
	flags?: string[];
	basePath?: string;
	onlyOneParachainNode?: boolean;
}

export interface LaunchConfig {
	relaychain: RelayChainConfig;
	parachains: ParachainConfig[];
	simpleParachains: SimpleParachainConfig[];
	hrmpChannels: HrmpChannelsConfig[];
	types: any;
	finalization: boolean;
}
export interface ParachainNodeConfig {
	rpcPort?: number;
	wsPort: number;
	port: number;
	basePath?: string;
	name?: string;
	flags: string[];
}
export interface ParachainConfig {
	bin: string;
	id?: string;
	balance: string;
	chain?: string;
	/**
	 * Command to be called to modify built spec
	 *
	 * May be used to add sudoers/other things, not specified
	 * by default chain spec
	 *
	 * `${spec}` placeholder will be replaced by existing spec file path
	 *
	 * Generated spec is read from command stdout
	 */
	chainInitializer?: string[];
	/**
	 * Command to be called to modify built raw spec
	 *
	 * May be used to migrate data from other chain
	 *
	 * `${spec}` placeholder will be replaced by existing spec file path
	 * `${rawSpec}` placeholder will be replaced by existing raw spec file path
	 *
	 * Generated spec is read from command stdout
	 */
	chainRawInitializer?: string[];
	nodes: ParachainNodeConfig[];
}
export interface SimpleParachainConfig {
	bin: string;
	id: string;
	port: string;
	balance: string;
}
export interface HrmpChannelsConfig {
	sender: number;
	recipient: number;
	maxCapacity: number;
	maxMessageSize: number;
}
interface ObjectJSON {
	[key: string]: ObjectJSON | number | string;
}
export interface RelayChainConfig {
	bin: string;
	chain: string;
	nodes: {
		name: string;
		basePath?: string;
		wsPort: number;
		rpcPort?: number;
		nodeKey?: string;
		port: number;
		flags?: string[];
	}[];
	genesis?: JSON | ObjectJSON;
}

export interface ChainSpec {
	name: string;
	id: string;
	chainType: string;
	bootNodes: string[];
	telemetryEndpoints: null;
	protocolId: string;
	properties: null;
	forkBlocks: null;
	badBlocks: null;
	consensusEngine: null;
	lightSyncState: null;
	genesis: {
		runtime: any; // this can change depending on the versions
		raw: {
			top: {
				[key: string]: string;
			};
		};
	};
}

export interface ResolvedParachainConfig extends ParachainConfig {
	resolvedId: string;
	resolvedSpec: string;
}
export interface ResolvedSimpleParachainConfig extends SimpleParachainConfig {
	resolvedId: string;
}
export interface ResolvedLaunchConfig extends LaunchConfig {
	parachains: ResolvedParachainConfig[];
	simpleParachains: ResolvedSimpleParachainConfig[];
}
export interface UpgradableRelayChainConfig extends RelayChainConfig {
	upgradeBin: string;
	upgradeWasm: string;
}
export interface UpgradableResolvedParachainConfig extends ResolvedParachainConfig {
	upgradeBin: string;
	upgradeWasm: string;
}
export interface KeyedParachainNodeConfig extends ParachainNodeConfig {
	auraKey: string;
}
