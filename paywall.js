// Demo paywall: a service that sells on-chain facts and accepts payment ONLY as an AgentVault receipt.
// It holds no private key and keeps NO per-request state: offers are signed with an HMAC, payment is verified by reading the chain.
//   GET /catalog                       -> what is for sale
//   GET /data/token?address=0x...      -> price 0.02 USDC
//   GET /data/wallet?address=0x...     -> price 0.01 USDC
// 1) First call answers HTTP 402 with an offer {vault, payee, amount, ref, nonce, expires}.
// 2) The agent pays: vault.spend(owner, payee, amount, ref).
// 3) The agent retries with header  X-Vault-Payment: base64({"agent","ref","nonce","expires"}).
// The ref is HMAC(secret, resource|amount|expires|nonce), so it only ever unlocks that one resource, and a restart loses nothing.
import http from 'http';
import crypto from 'crypto';
import { ethers } from 'ethers';
import { env, rpc, vaultAt, onchainFacts, preflight } from './lib.js';

await preflight(['VAULT', 'TOKEN', 'PAYEE']);
if (!ethers.isAddress(env.PAYEE)) { console.error('❌ PAYEE is not an address'); process.exit(1); }
const PAYEE = ethers.getAddress(env.PAYEE);
if (!env.PAYWALL_SECRET || env.PAYWALL_SECRET.length < 24) console.warn('⚠️ PAYWALL_SECRET not set (24+ chars): using a random one, so offers stop working after a restart');
const SECRET = env.PAYWALL_SECRET && env.PAYWALL_SECRET.length >= 24 ? env.PAYWALL_SECRET : crypto.randomBytes(32).toString('hex');
const vault = vaultAt(rpc);
const OFFER_LIFE = 24 * 3600; // an offer can be paid and redeemed for a day

const CATALOG = [
  { path: '/data/token', price: ethers.parseUnits('0.02', 6), description: 'Token facts: name, symbol, decimals, supply, owner, contract size (re-fetched from Metis)' },
  { path: '/data/wallet', price: ethers.parseUnits('0.01', 6), description: 'Wallet facts: METIS balance, nonce, whether it is a contract' },
];
const mkRef = (key, amount, expires, nonce) => '0x' + crypto.createHmac('sha256', SECRET).update(`${key}|${amount}|${expires}|${nonce}`).digest('hex');
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/catalog') return send(res, 200, CATALOG.map((c) => ({ path: c.path, priceUsdc: ethers.formatUnits(c.price, 6), description: c.description, payee: PAYEE, vault: env.VAULT })));
    const item = CATALOG.find((c) => c.path === u.pathname);
    const raw = u.searchParams.get('address');
    if (!item) return send(res, 404, { error: 'not found' });
    if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) return send(res, 400, { error: 'address query parameter required (0x + 40 hex characters)' });
    const addr = ethers.getAddress(raw.toLowerCase());
    const key = item.path + '?address=' + addr.toLowerCase();
    const amount = item.price.toString();

    const h = req.headers['x-vault-payment'];
    let pay = null; try { pay = h ? JSON.parse(Buffer.from(h, 'base64').toString('utf8')) : null; } catch { /* treated as no payment */ }

    if (!pay) { // no payment yet: make a signed, stateless offer
      const expires = Math.floor(Date.now() / 1000) + OFFER_LIFE, nonce = crypto.randomBytes(8).toString('hex');
      return send(res, 402, { scheme: 'agent-vault', chainId: 1088, vault: env.VAULT, token: env.TOKEN, payee: PAYEE, amount, amountUsdc: ethers.formatUnits(item.price, 6),
        ref: mkRef(key, amount, expires, nonce), nonce, expires,
        how: 'Call vault.spend(owner, payee, amount, ref) from your agent key, then retry with header X-Vault-Payment = base64({agent, ref, nonce, expires}).' });
    }
    if (!ethers.isAddress(pay.agent) || !/^0x[0-9a-f]{64}$/.test(String(pay.ref)) || Number(pay.expires) < Math.floor(Date.now() / 1000)) return send(res, 402, { error: 'offer expired or malformed: request a new offer' });
    if (mkRef(key, amount, Number(pay.expires), String(pay.nonce)) !== pay.ref) return send(res, 400, { error: 'this ref was not issued for this resource' });

    // Verify the payment on-chain (retry briefly: RPC nodes can lag a block behind the confirmation the agent saw).
    let ok = false;
    for (let i = 0; i < 4 && !ok; i++) {
      const r = await vault.receiptOf(pay.agent, pay.ref);
      ok = r.time > 0n && r.payee.toLowerCase() === PAYEE.toLowerCase() && r.amount >= item.price;
      if (!ok) await sleep(1500);
    }
    if (!ok) return send(res, 402, { error: 'no matching vault receipt yet (wrong payee or amount, or not confirmed). Retry shortly with the same header.', ref: pay.ref });
    const facts = await onchainFacts(addr);
    return send(res, 200, item.path === '/data/wallet' ? { address: facts.address, isContract: facts.isContract, nonce: facts.nonce, metisBalance: facts.metisBalance } : facts);
  } catch (e) { send(res, 500, { error: e.shortMessage || e.message }); }
}).listen(env.PORT || 8080, () => console.log(`Vault paywall on :${env.PORT || 8080}, payee ${PAYEE}`));
