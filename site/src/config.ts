// Canonical testnet deployment, from deployments/sepolia.json and deployments/hedera-testnet.json.

export type Net = "sepolia" | "hedera";

export interface NetInfo {
  id: Net;
  name: string;
  caip2: string;
  /** JSON-RPC endpoints with browser CORS, tried in order. */
  rpc: string[];
  explorerName: string;
  addressUrl: (a: string) => string;
  txUrl: (h: string) => string;
  /** First block worth scanning for logs (just before the deployment). */
  fromBlock: bigint;
  native: string;
}

export const MIRROR = "https://testnet.mirrornode.hedera.com";

export const NETS: Record<Net, NetInfo> = {
  sepolia: {
    id: "sepolia",
    name: "Ethereum Sepolia",
    caip2: "eip155:11155111",
    rpc: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"],
    explorerName: "Etherscan",
    addressUrl: (a) => `https://sepolia.etherscan.io/address/${a}`,
    txUrl: (h) => `https://sepolia.etherscan.io/tx/${h}`,
    fromBlock: 11_821_000n,
    native: "ETH",
  },
  hedera: {
    id: "hedera",
    name: "Hedera testnet",
    caip2: "eip155:296",
    rpc: ["https://testnet.hashio.io/api"],
    explorerName: "HashScan",
    addressUrl: (a) => `https://hashscan.io/testnet/contract/${a}`,
    txUrl: (h) => `https://hashscan.io/testnet/transaction/${h}`,
    fromBlock: 41_216_700n,
    native: "HBAR",
  },
};

export type Hex = `0x${string}`;

export interface ContractRow {
  name: string;
  group: "CLPR" | "CLPRouter" | "Library" | "Testnet fixture" | "Settle on Hedera";
  what: string;
  sepolia?: Hex;
  hedera?: Hex;
  /** Runtime code hash recorded at deployment, if any (same on both networks unless noted). */
  codeHash?: Hex;
  /** Replaced by a later deployment; kept in the table for the record. */
  superseded?: string;
}

export const SERVICE: Hex = "0xa6db474e3047c3d43b10a4ff7abad547d89982b9";
export const ROUTER: Record<Net, Hex> = {
  sepolia: "0x3Ec8a28f6AD20FE1070819f56B29be120700A653",
  hedera: "0xF398F961088af7aF74bff8fc409a535023913E5F",
};
/** The live Channel (v2, staged committee rotation). */
export const CHANNEL_ID: Hex = "0x6446fdeff8622cb949ba6207af6365225abc937950ab2f955de664a19b0ec05d";
/** The first Channel: the delivered route ran over it; superseded by v2. */
export const CHANNEL_V1_ID: Hex = "0x8a15fe9f8ea6a20841a9983e2e6176b4bcf1e01530348632d9488be92a4145e0";
export const ROUTE_ID: Hex = "0x03c51452a41f4867d5bd8f5774baa110";
export const ROUTE_SEND_TX: Hex = "0x8a08f19922f6a265f2900b218db01510c4dc21e50ed80b68ae8756faddff0d6c";
export const ROUTE_DELIVER_TX: Hex = "0x1249ca9040fb4c1f02e99ee656823393b223bf9f2bcba9d2a6cdb36344e1989b";
export const ROUTE_APP: Hex = "0xDbB0EbcBf8fa0cE4886fbe8Ae0C24C6D68B8bC69";

// Settle on Hedera v2 (on the v2 Channel).
export const ORDER_BOOK: Hex = "0x28c14e4BAd929e27902149674CCe79b34E5b8B1f";
export const SETTLE_DEPOSIT: Hex = "0x86ED95936E516742cC4d54657f66831775282875";
export const SETTLE_DELIVERY: Hex = "0xf3c36ceDD119a0BfEdfA9F61C82A4F289046CB24";
export const SETTLE_CLPR_CONNECTOR: Hex = "0x7DBAA36A39765668d7aB18AA08Db0a7Fe1Da7227";
export const TEST_CONNECTOR: Hex = "0x316323692104293b58366e6Bc66a796B919108E7";
export const SEPOLIA_LEDGER_LABEL = "eip155:11155111";

export const CONTRACTS: ContractRow[] = [
  {
    name: "ClprService",
    group: "CLPR",
    what: "Reference CLPR Service (LF Decentralized Trust), same address on both networks",
    sepolia: SERVICE,
    hedera: SERVICE,
  },
  {
    name: "ClprRouter",
    group: "CLPRouter",
    what: "Canonical Router: immutable, no admin key, no pause",
    sepolia: ROUTER.sepolia,
    hedera: ROUTER.hedera,
  },
  {
    name: "ProviderRegistry",
    group: "CLPRouter",
    what: "Certifications, disabled routes, blacklist; TEST committee, k = 3 of 5",
    sepolia: "0x6D8a65a9E85C423ACe3E0C4074508a9AcD63958c",
    hedera: "0x6D8a65a9E85C423ACe3E0C4074508a9AcD63958c",
    codeHash: "0x805c0f114a736adfce9ae7a265410d19b5418a7f5e921d4594cfb5aabeeea8de",
  },
  {
    name: "QuarantineVault",
    group: "CLPRouter",
    what: "Locked vault for a blacklisted account's routed funds",
    sepolia: "0x6f7756640C2cf1db14d2789F33966D0eB0960b4a",
    hedera: "0x6f7756640C2cf1db14d2789F33966D0eB0960b4a",
    codeHash: "0x3221cbd7011d85ae125019c242d3fb4e900fcec753d2795b773daf0bfb0cd207",
  },
  {
    name: "ClprRouterDeployer",
    group: "CLPRouter",
    what: "CREATE2 deployer of the canonical Router",
    sepolia: "0xAb349c0D13f1d46ca5e16C3c1bf7211abBf9b29E",
    hedera: "0xAb349c0D13f1d46ca5e16C3c1bf7211abBf9b29E",
    codeHash: "0x41640fa4649ea78236c5bc0a9412a23a49bf44de302138ff7298858ea020e6c0",
  },
  { name: "RouteCodec", group: "Library", what: "Envelope codec", sepolia: "0xF51eD266068C956D7fCDB2a21B89a1ECd68d7b62", hedera: "0xF51eD266068C956D7fCDB2a21B89a1ECd68d7b62" },
  { name: "RouteLogic", group: "Library", what: "Hop checks and forwarding", sepolia: "0x2Ca8e2aFeAAea07b9FD5Df60d44D0606169a8d50", hedera: "0x2Ca8e2aFeAAea07b9FD5Df60d44D0606169a8d50" },
  { name: "RouteOrigin", group: "Library", what: "Send and escrow", sepolia: "0x295C624f75D1DA951e3aDF6d6580160810f17e17", hedera: "0x295C624f75D1DA951e3aDF6d6580160810f17e17" },
  { name: "RouteReceipts", group: "Library", what: "End-to-end receipts", sepolia: "0xd7A3F6FB49d171f755043EcCb01bcd4e69B02a38", hedera: "0xd7A3F6FB49d171f755043EcCb01bcd4e69B02a38" },
  { name: "RouteSettlement", group: "Library", what: "Settle, refund, quarantine", sepolia: "0xc6ab1ED6A833Df9fBfe213f6e52aecA6734632A4", hedera: "0xc6ab1ED6A833Df9fBfe213f6e52aecA6734632A4" },
  { name: "TestnetConnector", group: "Testnet fixture", what: "CLPR connector that pays for message execution", sepolia: "0xe8cb0088BBDf16F256F854485B34117412992816", hedera: "0xe8cb0088BBDf16F256F854485B34117412992816" },
  { name: "TestnetRouteApp", group: "Testnet fixture", what: "Destination application of the delivered route", hedera: ROUTE_APP },
  {
    name: "SettleOrderBook",
    group: "Settle on Hedera",
    what: "Connectors, bonds, orders and defaults, on Hedera (v2 Channel)",
    hedera: ORDER_BOOK,
    codeHash: "0x389003716fdc11417120e86c5a4f2c54e49a5d998cd5851520a5f45818fe1b53",
  },
  {
    name: "SettleDeposit",
    group: "Settle on Hedera",
    what: "User pays the Connector; DEPOSIT message to Hedera (v2 Channel)",
    sepolia: SETTLE_DEPOSIT,
    codeHash: "0x8a1a87a0e7dd0d59b28c6ed26d40cb7002b5b2ebb7d36060ba5cd6c83c4718f5",
  },
  {
    name: "SettleDelivery",
    group: "Settle on Hedera",
    what: "Connector pays the recipient; DELIVERY message to Hedera (v2 Channel)",
    sepolia: SETTLE_DELIVERY,
    codeHash: "0x6ebee98d32aee3697d38b263f43a802d9c7893f207ba2735cc298d805e3003fa",
  },
  {
    name: "SettleTestnetConnector",
    group: "Settle on Hedera",
    what: "CLPR connector for the settle messages, registered on the v2 Channel on both networks",
    sepolia: SETTLE_CLPR_CONNECTOR,
    hedera: SETTLE_CLPR_CONNECTOR,
    codeHash: "0x040f62c382b642ee7ba033a343c2fbb54647b3852fb2cd6994fe55e40a0cb5b6",
  },
  {
    name: "SettleOrderBook (v1)",
    group: "Settle on Hedera",
    what: "First order book, on the first Channel",
    hedera: "0xB7C875E6EB4a9D470BBccFecbA6256342676e895",
    codeHash: "0x1a382720c65a2d5a77f408a9faad7a0857563e41b7fb23713416bf2df92ebbef",
    superseded: "by the v2 order book",
  },
  {
    name: "SettleDeposit (v1)",
    group: "Settle on Hedera",
    what: "First deposit contract, bound to the first Channel",
    sepolia: "0x249f83524D0827840237e751981B804D99bB5bD6",
    codeHash: "0x7461d565a907debe07979ee687fc423ac0fe499d6212f6072103d677af5f3990",
    superseded: "by the v2 deposit contract",
  },
  {
    name: "SettleDelivery (v1)",
    group: "Settle on Hedera",
    what: "First delivery contract, bound to the first Channel",
    sepolia: "0x5e7dbA624AFbcb13693BB17d9021Be16Da96cDB8",
    codeHash: "0x8678fc33053cb8f618bfbee69eb554afe2cacf1d829089c2529709a7ff61ad74",
    superseded: "by the v2 delivery contract",
  },
  {
    name: "SettleTestnetConnector (v1)",
    group: "Settle on Hedera",
    what: "First settle CLPR connector, Hedera only",
    hedera: "0x187Ec9e724615974F5bdbf63eA4E181B9B2381F4",
    codeHash: "0x040f62c382b642ee7ba033a343c2fbb54647b3852fb2cd6994fe55e40a0cb5b6",
    superseded: "by the v2 settle CLPR connector",
  },
];
