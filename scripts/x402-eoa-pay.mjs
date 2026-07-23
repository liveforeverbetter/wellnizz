// One-off: pay an x402-gated health-api endpoint directly from the local
// polygon-agent builder EOA (0x5Ced…), signing the EIP-3009 authorization
// ourselves so funds come from the EOA and never a smart/OMS wallet.
//
//   node scripts/x402-eoa-pay.mjs <eip155:8453|eip155:137>
//
// The private key is decrypted from ~/.polygon-agent/builder.json in memory
// and never written or logged.
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { privateKeyToAccount } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import { x402HTTPClient } from '@x402/core/http';
import { registerExactEvmScheme } from '@x402/evm/exact/client';

const TARGET = process.argv[2];
if (!/^eip155:(8453|137)$/.test(TARGET ?? '')) {
  console.error('usage: x402-eoa-pay.mjs <eip155:8453|eip155:137>');
  process.exit(2);
}
const RPC = { 8453: 'https://mainnet.base.org', 137: 'https://polygon-bor-rpc.publicnode.com' };
const chainId = Number(TARGET.split(':')[1]);
const URL = 'https://api.foreverbetter.xyz/providers?modalities=biomarkers,genetics&region=US';

function loadAccount() {
  const home = os.homedir();
  const key = readFileSync(`${home}/.polygon-agent/.encryption-key`); // 32 raw bytes
  const b = JSON.parse(readFileSync(`${home}/.polygon-agent/builder.json`, 'utf8'));
  const p = b.privateKey;
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(p.iv, 'hex'));
  d.setAuthTag(Buffer.from(p.authTag, 'hex'));
  const pk = Buffer.concat([d.update(Buffer.from(p.encrypted, 'hex')), d.final()]).toString('utf8').trim();
  const account = privateKeyToAccount(pk);
  if (account.address.toLowerCase() !== b.eoaAddress.toLowerCase()) {
    throw new Error('decrypted key does not match builder eoaAddress');
  }
  return account;
}

const account = loadAccount();
console.log('payer EOA:', account.address, '| target:', TARGET);

const client = new x402Client();
registerExactEvmScheme(client, {
  signer: account,
  networks: [TARGET],
  paymentRequirementsSelector: (_v, reqs) => {
    const pick = reqs.find((r) => r.network === TARGET);
    if (!pick) throw new Error(`no payment requirement for ${TARGET}`);
    return pick;
  },
  schemeOptions: { [chainId]: { rpcUrl: RPC[chainId] } },
});
const http = new x402HTTPClient(client);

// 1) trigger the 402
const res1 = await fetch(URL, { method: 'GET' });
const body1 = await res1.clone().json().catch(() => undefined);
console.log('initial status:', res1.status);
const paymentRequired = http.getPaymentRequiredResponse((n) => res1.headers.get(n), body1);

// 2) sign the payment for the chosen network
const payload = await http.createPaymentPayload(paymentRequired);
const payHeaders = http.encodePaymentSignatureHeader(payload);

// 3) retry with the signature; facilitator settles on-chain from the EOA
const res2 = await fetch(URL, { method: 'GET', headers: payHeaders });
const parsed = await http.processResponse(res2);

console.log('paid status:', parsed.status, '| paymentStatus:', parsed.paymentStatus);
console.log('settlement:', JSON.stringify(parsed.header, null, 2));
const bodyText = typeof parsed.body === 'string' ? parsed.body : JSON.stringify(parsed.body);
console.log('body (first 300):', (bodyText ?? '').slice(0, 300));
