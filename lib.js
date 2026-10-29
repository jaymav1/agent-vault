// Shared helpers for the Agent Vault tools. Node 20, ethers v6.
import 'dotenv/config';
import { ethers } from 'ethers';

export const env = process.env;
export const rpc = new ethers.JsonRpcProvider(env.RPC_URL || 'https://andromeda.metis.io/?owner=1088', 1088, { staticNetwork: true });
export const ERC20 = ['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)'];
export const VAULT_ABI = [
  'function token() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function policies(address,address) view returns (uint128 perTx,uint128 perDay,uint64 expiry,bool active,uint64 day,uint128 spentToday)',
  'function allowedPayee(address,address,address) view returns (bool)',
  'function check(address owner,address agent,address payee,uint256 amount) view returns (bool ok,uint8 code)',
  'function spend(address owner,address payee,uint256 amount,bytes32 ref) returns (bool)',
  'function receiptOf(address agent,bytes32 ref) view returns (address owner,address payee,uint256 amount,uint64 time)',
  'function spentToday(address owner,address agent) view returns (uint256)',
  'event Spent(address indexed owner,address indexed agent,address indexed payee,uint256 amount,bytes32 ref)',
  'event Blocked(address indexed owner,address indexed agent,address indexed payee,uint256 amount,uint8 code,bytes32 ref)',
];
export const vaultAt = (s) => new ethers.Contract(env.VAULT, VAULT_ABI, s);
export const REASONS = { 0: 'ALLOW', 2: 'policy expired', 3: 'payee not on the allowlist', 4: 'over the per-payment limit', 5: 'over the daily limit',
  6: 'owner balance too low', 7: 'bad request', 8: 'reference already used', 9: 'agent revoked by owner' };
export const reason = (c) => REASONS[Number(c)] || `code ${c}`;
export const explorer = (h) => `https://explorer.metis.io/tx/${h}`;
export const usdc = (v) => ethers.formatUnits(v, 6);

export async function claude(prompt, max = 600) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: env.MODEL || 'claude-sonnet-5-5', max_tokens: max, messages: [{ role: 'user', content: prompt }] }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || 'LLM error');
  return d.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// On-chain facts anyone can re-fetch (what the demo paywall sells).
export async function onchainFacts(addr) {
  addr = ethers.getAddress(addr.toLowerCase());
  const [code, nonce, bal] = await Promise.all([rpc.getCode(addr), rpc.getTransactionCount(addr), rpc.getBalance(addr)]);
  const f = { chain: 'Metis Andromeda (1088)', address: addr, isContract: code !== '0x', codeBytes: (code.length - 2) / 2, nonce, metisBalance: ethers.formatEther(bal) };
  if (f.isContract) {
    const c = new ethers.Contract(addr, ['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function totalSupply() view returns (uint256)', 'function owner() view returns (address)'], rpc);
    try {
      const [name, symbol, decimals, supply] = await Promise.all([c.name(), c.symbol(), c.decimals(), c.totalSupply()]);
      f.token = { name, symbol, decimals: Number(decimals), totalSupply: ethers.formatUnits(supply, decimals), owner: await c.owner().catch(() => null) };
    } catch { /* not a standard ERC-20 */ }
  }
  return f;
}

// Startup self-check. Prints clear problems (useful when deploying from a phone).
export async function preflight(need = ['VAULT', 'TOKEN']) {
  const missing = need.filter((k) => !env[k] || /^0x_|^<|^$/.test(env[k]));
  if (missing.length) { console.error('❌ Missing or placeholder env vars:', missing.join(', ')); process.exit(1); }
  const bad = [];
  try {
    if ((await rpc.getNetwork()).chainId !== 1088n) bad.push('RPC is not Metis Andromeda (chain 1088)');
    if ((await rpc.getCode(env.VAULT)) === '0x') bad.push('VAULT has no contract code at that address (wrong address or wrong network)');
    else if ((await vaultAt(rpc).token()).toLowerCase() !== env.TOKEN.toLowerCase()) bad.push('VAULT was deployed with a different token than TOKEN');
    const dec = Number(await new ethers.Contract(env.TOKEN, ['function decimals() view returns (uint8)'], rpc).decimals());
    if (dec !== 6) bad.push(`TOKEN has ${dec} decimals, this code assumes 6`);
  } catch (e) { bad.push('check failed: ' + (e.shortMessage || e.message)); }
  if (bad.length) { bad.forEach((b) => console.error('❌', b)); process.exit(1); }
  console.log('✅ self-check passed');
}
