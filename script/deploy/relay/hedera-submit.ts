// SPDX-License-Identifier: MIT
// Submit one large EVM transaction to Hedera testnet through the Hedera SDK instead of the JSON-RPC relay.
//
// Why: the relay offers a fixed maximum transaction fee (12.75 HBAR on testnet.hashio.io). A jumbo transaction's
// byte fees come out of that same budget before gas is bought, so the 67 KB EthMainnetVerifier bootstrap config
// (completeChannel) fails with INSUFFICIENT_GAS through the relay at any gas limit. Here the transaction is signed
// as a normal legacy EIP-155 transaction (same key, same nonce rules) and wrapped in an EthereumTransaction whose
// payer (the key's own Hedera account) sets a higher max transaction fee; EthereumFlow moves the call data to a
// file when it is too large for a single transaction.
//
//   npx tsx relay/hedera-submit.ts --to 0x.. --data-file calldata.hex --gas 6000000 [--max-fee-hbar 40]
import {readFileSync} from "node:fs";
import {AccountId, Client, EthereumFlow, Hbar, PrivateKey} from "@hashgraph/sdk";
import {createWalletClient, http, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {arg, client, env} from "./common.js";

async function main(): Promise<void> {
    const to = arg("to") as Hex;
    const data = readFileSync(arg("data-file"), "utf8").trim() as Hex;
    const gas = BigInt(arg("gas"));
    const maxFee = Number(arg("max-fee-hbar", "40"));
    const rpc = env("HEDERA_TESTNET_RPC_URL");
    const mirror = env("HEDERA_TESTNET_MIRROR_URL");
    const pk = env("CLPR_TESTNET_PRIVATE_KEY") as Hex;
    const account = privateKeyToAccount(pk.startsWith("0x") ? pk : (`0x${pk}` as Hex));

    const acct = (await (await fetch(`${mirror}/api/v1/accounts/${account.address}`)).json()) as {account: string};
    const pub = client(rpc);
    const nonce = await pub.getTransactionCount({address: account.address});
    const gasPrice = await pub.getGasPrice(); // floor at eth_gasPrice (weibars)
    const wallet = createWalletClient({account, transport: http(rpc)});
    const raw = await wallet.signTransaction({
        type: "legacy", chain: {id: 296} as never, to, data, gas, gasPrice, nonce, value: 0n
    } as never);

    const sdk = Client.forTestnet().setOperator(
        AccountId.fromString(acct.account), PrivateKey.fromStringECDSA(pk.replace(/^0x/, ""))
    );
    // The SDK checks the fee with Long.toInt(): keep it below 2^31 tinybars (21.47 HBAR).
    sdk.setDefaultMaxTransactionFee(new Hbar(Math.min(maxFee, 21)));
    const resp = await new EthereumFlow()
        .setEthereumData(Buffer.from(raw.slice(2), "hex"))
        .setMaxGasAllowance(new Hbar(maxFee))
        .execute(sdk);
    const rec = await resp.getRecord(sdk);
    const hash = "0x" + Buffer.from(rec.ethereumHash ?? new Uint8Array()).toString("hex");
    console.log(`HEDERA_SDK_TX ${resp.transactionId.toString()} status ${rec.receipt.status.toString()} ` +
        `fee ${rec.transactionFee.toString()} ethHash ${hash} nonce ${nonce} gas ${gas} gasPrice ${gasPrice}`);
    sdk.close();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
