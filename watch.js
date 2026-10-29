// Optional: Telegram alerts to the vault owner whenever their agent spends or gets blocked.
//   needs: VAULT, TOKEN, OWNER, BOT_TOKEN, CHAT_ID  (CHAT_ID: send /start to your bot, then open api.telegram.org/bot<TOKEN>/getUpdates)
import { ethers } from 'ethers';
import { env, rpc, vaultAt, reason, explorer, usdc, preflight } from './lib.js';

await preflight(['VAULT', 'TOKEN', 'OWNER', 'BOT_TOKEN', 'CHAT_ID']);
const vault = vaultAt(rpc), owner = ethers.getAddress(env.OWNER);
const tell = async (text) => { const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.CHAT_ID, text }) }); if (!r.ok) throw new Error('telegram ' + r.status); };
let from = (await rpc.getBlockNumber()) + 1, busy = false;
console.log('watching vault activity for', owner, 'from block', from);
setInterval(async () => {
  if (busy) return; busy = true;
  try {
    const head = await rpc.getBlockNumber();
    while (from <= head) { // scan in small chunks (public RPCs cap the log range); advance only after a chunk is fully reported
      const to = Math.min(from + 1999, head);
      const [spent, blocked] = await Promise.all([vault.queryFilter(vault.filters.Spent(owner), from, to), vault.queryFilter(vault.filters.Blocked(owner), from, to)]);
      for (const e of spent) await tell(`✅ Agent ${e.args.agent.slice(0, 8)}… paid ${usdc(e.args.amount)} USDC to ${e.args.payee.slice(0, 8)}…\n${explorer(e.transactionHash)}`);
      for (const e of blocked) await tell(`🚫 BLOCKED: agent ${e.args.agent.slice(0, 8)}… tried ${usdc(e.args.amount)} USDC to ${e.args.payee.slice(0, 8)}…\nReason: ${reason(e.args.code)}\n${explorer(e.transactionHash)}`);
      from = to + 1;
    }
  } catch (e) { console.error('watch:', e.shortMessage || e.message); } finally { busy = false; }
}, 30000);
