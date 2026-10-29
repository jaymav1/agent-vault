// Agent Vault alerts: a Telegram bot ANYONE can use. Each user links their own owner wallet(s) to their own chat.
// Vault activity is public on-chain data, so watching an address needs no login; the bot only reads events and never holds keys or funds.
//   needs: VAULT, TOKEN, BOT_TOKEN, WATCH_DB (default /data/alerts.json, put a Volume at /data)
import fs from 'fs';
import path from 'path';
import { Telegraf } from 'telegraf';
import { ethers } from 'ethers';
import { env, rpc, vaultAt, reason, explorer, usdc, preflight } from './lib.js';

await preflight(['VAULT', 'TOKEN', 'BOT_TOKEN']);
const FILE = env.WATCH_DB || '/data/alerts.json';
try { fs.accessSync(path.dirname(path.resolve(FILE)), fs.constants.W_OK); }
catch { console.error('❌ WATCH_DB folder is not writable: ' + FILE + ' (on Railway, add a Volume mounted at /data)'); process.exit(1); }

const MAX_PER_CHAT = 5, MAX_TOTAL = 5000, CATCHUP_BLOCKS = 50000, CHUNK = 1999, PER_CHAT_PER_POLL = 10;
let db;
try { db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {}; }
catch { console.error('❌ Cannot read ' + FILE + ' (corrupt?). Move it aside and restart.'); process.exit(1); }
db.subs ||= {};            // chatId -> [owner address, ...]
db.from ||= 0;             // next block to scan (kept across restarts so no event is missed)
const save = () => { fs.writeFileSync(FILE + '.tmp', JSON.stringify(db)); fs.renameSync(FILE + '.tmp', FILE); };
const total = () => Object.values(db.subs).reduce((n, a) => n + a.length, 0);

const vault = vaultAt(rpc);
const bot = new Telegraf(env.BOT_TOKEN);
bot.catch((e) => console.error('bot error', e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection', e?.message || e));
const priv = (ctx) => ctx.chat?.type === 'private' || (ctx.reply('Please use me in a private chat (open my profile and tap Send message).').catch(() => {}), false);
const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

bot.start((ctx) => ctx.reply(
  'Agent Vault alerts 🔔\n\nGet a message whenever an AI agent spends from your vault, is blocked by your limits, or is revoked.\n\n' +
  '/watch 0xYourOwnerWallet - start alerts for that vault owner\n/list - what you are watching\n/unwatch 0xAddress (or /unwatch all)\n\n' +
  'This bot only reads public blockchain data. It never asks for keys and cannot move funds. Alerts take up to a minute. Up to ' + MAX_PER_CHAT + ' wallets per chat.'));

bot.command('watch', (ctx) => {
  if (!priv(ctx)) return;
  const a = (ctx.message.text.split(/\s+/)[1] || '').trim();
  if (!ethers.isAddress(a)) return ctx.reply('Send your owner wallet address like this:\n/watch 0x1234…\n(the wallet that deposited into the vault)');
  const addr = ethers.getAddress(a.toLowerCase()), id = String(ctx.chat.id);
  const mine = (db.subs[id] ||= []);
  if (mine.includes(addr)) return ctx.reply('Already watching ' + addr);
  if (mine.length >= MAX_PER_CHAT) return ctx.reply(`Limit reached (${MAX_PER_CHAT}). Use /unwatch first.`);
  if (total() >= MAX_TOTAL) return ctx.reply('The service is full right now. Please try again later.');
  mine.push(addr); save();
  return ctx.reply('✅ Watching vault activity for\n' + addr + '\nYou will get a message when an agent pays, is blocked, or is revoked.');
});

bot.command('list', (ctx) => {
  if (!priv(ctx)) return;
  const mine = db.subs[String(ctx.chat.id)] || [];
  return ctx.reply(mine.length ? 'Watching:\n' + mine.join('\n') : 'Not watching anything yet. Use /watch 0xYourOwnerWallet');
});

bot.command('unwatch', (ctx) => {
  if (!priv(ctx)) return;
  const a = (ctx.message.text.split(/\s+/)[1] || '').trim(), id = String(ctx.chat.id), mine = db.subs[id] || [];
  if (a.toLowerCase() === 'all') { delete db.subs[id]; save(); return ctx.reply('Stopped all alerts for this chat.'); }
  if (!ethers.isAddress(a)) return ctx.reply('Use /unwatch 0xAddress, or /unwatch all');
  const addr = ethers.getAddress(a.toLowerCase());
  if (!mine.includes(addr)) return ctx.reply('You were not watching that address.');
  db.subs[id] = mine.filter((x) => x !== addr); if (!db.subs[id].length) delete db.subs[id]; save();
  return ctx.reply('Stopped alerts for ' + addr);
});

// who is watching this owner?
const watchers = (owner) => Object.entries(db.subs).filter(([, a]) => a.includes(owner)).map(([id]) => id);
async function tell(chat, text) {
  try { await bot.telegram.sendMessage(chat, text, { link_preview_options: { is_disabled: true } }); }
  catch (e) {
    if (e.response?.error_code === 403 || e.response?.error_code === 400 && /chat not found/i.test(e.description || '')) { delete db.subs[chat]; save(); } // user blocked the bot: drop them
    else if (e.response?.error_code === 429) { await new Promise((r) => setTimeout(r, (e.response.parameters?.retry_after || 3) * 1000)); await tell(chat, text).catch(() => {}); }
    else console.error('send failed', chat, e.message);
  }
}

const describe = (p, txHash) => {
  const n = p.name, a = p.args, link = explorer(txHash);
  if (n === 'Spent') return [a.owner, `✅ Agent ${short(a.agent)} paid ${usdc(a.amount)} USDC to ${short(a.payee)}\n${link}`];
  if (n === 'Blocked') return [a.owner, `🚫 BLOCKED: agent ${short(a.agent)} tried ${usdc(a.amount)} USDC to ${short(a.payee)}\nReason: ${reason(a.code)}\n${link}`];
  if (n === 'Revoked') return [a.owner, `🛑 Agent ${short(a.agent)} was revoked\n${link}`];
  if (n === 'Withdrawn') return [a.owner, `↩️ ${usdc(a.amount)} USDC withdrawn from the vault\n${link}`];
  return null;
};

let busy = false;
async function poll() {
  if (busy) return; busy = true;
  const sent = {}, skipped = {};
  try {
    const head = await rpc.getBlockNumber();
    if (!db.from) { db.from = head + 1; save(); }
    if (head - db.from > CATCHUP_BLOCKS) { console.error('skipping old blocks:', db.from, '->', head - CATCHUP_BLOCKS); db.from = head - CATCHUP_BLOCKS; }
    while (db.from <= head) {
      const to = Math.min(db.from + CHUNK, head);
      if (total() > 0) {
        const logs = await rpc.getLogs({ address: env.VAULT, fromBlock: db.from, toBlock: to }); // every vault event in the range, one request
        for (const l of logs) {
          if (db.curBlock === l.blockNumber && l.index <= db.curIdx) continue; // already delivered before a restart
          let p; try { p = vault.interface.parseLog(l); } catch { continue; }
          const d = p && describe(p, l.transactionHash);
          if (d) {
            const owner = ethers.getAddress(d[0]);
            for (const chat of watchers(owner)) {
              sent[chat] = (sent[chat] || 0) + 1;
              if (sent[chat] <= PER_CHAT_PER_POLL) await tell(chat, d[1]); else skipped[chat] = (skipped[chat] || 0) + 1;
            }
          }
          db.curBlock = l.blockNumber; db.curIdx = l.index; save();
        }
      }
      db.from = to + 1; save();  // advance only after the whole chunk was handled
    }
  } catch (e) { console.error('poll:', e.shortMessage || e.message); }
  for (const [chat, n] of Object.entries(skipped)) await tell(chat, `…and ${n} more events (limit per minute). Check the vault console for the full list.`);
  busy = false;
}
const timer = setInterval(poll, 30000);
bot.launch({ dropPendingUpdates: true }).catch((e) => { console.error('bot failed to start (bad BOT_TOKEN, or another copy is running):', e.message); process.exit(1); });
console.log('Agent Vault alerts bot running');
poll();
const stop = async (sig) => { clearInterval(timer); try { bot.stop(sig); } catch { /* not started */ } for (let i = 0; i < 20 && busy; i++) await new Promise((r) => setTimeout(r, 500)); process.exit(0); };
process.once('SIGTERM', () => stop('SIGTERM')); process.once('SIGINT', () => stop('SIGINT'));
