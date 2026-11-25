// ===========================================================================
// commands.js - semua perintah Telegram: /status, /backup, /help, tombol Refresh
// Mau tambah perintah baru? Tambahkan bot.onText(...) di dalam registerCommands().
// ===========================================================================
const { servers } = require('../config');
const { bot, isAllowed } = require('./bot');
const { buildStatusMessage, refreshKeyboard } = require('./status');
const { runBackupJob, runFullBackup } = require('../backup/runner');
const { listGuests, parseBackupArgs, resolveTargets, serverMatches } = require('../backup/guests');
const { state: backupState } = require('../backup/state');
const { buildHelpMessage, helpKeyboard } = require('./help');
const { esc } = require('../utils/format');

const BACKUP_USAGE = [
  `💾 <b>Backup manual</b>`,
  ``,
  `<code>/backup vm101</code> – backup VM/LXC dengan ID 101`,
  `<code>/backup vm101 vm102</code> – beberapa sekaligus`,
  `<code>/backup vm101 dell</code> – tambah nama server jika ID yang sama ada di 2 server`,
  `<code>/backup all</code> – backup SEMUA VM &amp; LXC`
].join('\n');

// Daftar VM & LXC (untuk ditampilkan saat /backup tanpa argumen)
async function buildGuestList() {
  const { guests, problems } = await listGuests();
  const out = [];
  for (const srv of servers) {
    const list = guests.filter((g) => g.srv === srv);
    if (!list.length) continue;
    out.push(`\n🖥 <b>${esc(srv.name)}</b>`);
    for (const g of list.slice(0, 40)) {
      const icon = g.status === 'running' ? '🟢' : '⚫';
      out.push(`${icon} <code>${g.vmid}</code> ${esc(g.name)} <i>(${g.type === 'qemu' ? 'VM' : 'LXC'})</i>`);
    }
  }
  if (problems.length) out.push(`\n⚠️ ${esc(problems.join('; '))}`);
  return out.join('\n');
}

// Kirim pesan status lengkap
async function sendStatus(chatId) {
  bot.sendChatAction(chatId, 'typing').catch(() => {});
  try {
    const text = await buildStatusMessage();
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: refreshKeyboard });
  } catch (e) {
    console.error('[status]', e.message);
    bot.sendMessage(chatId, `❌ Gagal mengambil status: ${esc(e.message)}`, { parse_mode: 'HTML' }).catch(() => {});
  }
}

// Kirim cara pakai /backup + daftar VM (TIDAK membackup apa pun)
async function sendBackupHelp(chatId) {
  bot.sendChatAction(chatId, 'typing').catch(() => {});
  const text = `${BACKUP_USAGE}\n\n📦 <b>Daftar VM &amp; LXC</b>${await buildGuestList()}`;
  bot.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(() => {});
}

function registerCommands() {
  // Daftar menu perintah yang muncul di Telegram
  bot
    .setMyCommands([
      { command: 'status', description: 'Lihat status lengkap server' },
      { command: 'backup', description: 'Backup VM tertentu, contoh: /backup vm101' },
      { command: 'help', description: 'Bantuan' }
    ])
    .catch(() => {});

  // /status (juga /start dan /cek)
  bot.onText(/^\/(start|cek|status)(@\w+)?$/i, (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    sendStatus(msg.chat.id);
  });

  // /backup <id...> [nama server]   |   /backup all   |   /backup (tanpa argumen = bantuan)
  bot.onText(/^\/backup(@\w+)?(\s+.+)?$/i, async (msg, match) => {
    if (!isAllowed(msg.chat.id)) return;
    const chatId = msg.chat.id;
    const reply = (t) => bot.sendMessage(chatId, t, { parse_mode: 'HTML' }).catch(() => {});
    const args = (match[2] || '').trim();

    // Tanpa argumen: JANGAN backup apa pun, tampilkan cara pakai + daftar VM
    if (!args) return sendBackupHelp(chatId);

    if (backupState.running) return reply('⏳ Backup sedang berjalan, tunggu sampai selesai.');

    // /backup all
    if (/^all$/i.test(args)) {
      runFullBackup('manual'); // tidak di-await: bisa berjam-jam, hasil dikirim lewat notifikasi
      return;
    }

    // /backup vm101 ...
    const { vmids, serverFilter } = parseBackupArgs(args);
    if (!vmids.length) return reply(`❓ Format tidak dikenali.\n\n${BACKUP_USAGE}`);
    if (serverFilter && !servers.some((s) => serverMatches(s, serverFilter))) {
      return reply(
        `❓ Server "<b>${esc(serverFilter)}</b>" tidak dikenal.\nServer: ${esc(servers.map((s) => s.name).join(', '))}`
      );
    }

    bot.sendChatAction(chatId, 'typing').catch(() => {});
    const { guests, problems } = await listGuests();
    const { plan, notFound, ambiguous } = resolveTargets(guests, vmids, serverFilter);

    const warn = [];
    if (notFound.length) warn.push(`❌ ID tidak ditemukan: <b>${notFound.join(', ')}</b>`);
    for (const a of ambiguous) {
      warn.push(
        `⚠️ ID <b>${a.id}</b> ada di beberapa server (${esc(a.servers.join(', '))}).\n` +
          `Tambahkan nama server, contoh: <code>/backup vm${a.id} ${esc(a.servers[0].split(' ')[0].toLowerCase())}</code>`
      );
    }
    if (problems.length) warn.push(`⚠️ ${esc(problems.join('; '))}`);

    if (!plan.length) return reply(warn.join('\n\n') || '❌ Tidak ada VM yang cocok.');
    if (warn.length) await reply(`${warn.join('\n\n')}\n\n<i>Yang ditemukan tetap dibackup.</i>`);

    runBackupJob({ trigger: 'manual', plan }); // tidak di-await
  });

  // /help
  bot.onText(/^\/help(@\w+)?$/i, (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    bot.sendMessage(msg.chat.id, buildHelpMessage(), { parse_mode: 'HTML', reply_markup: helpKeyboard });
  });

  // Tombol-tombol inline (Refresh, Status Server, Daftar VM)
  bot.on('callback_query', async (q) => {
    if (!q.message || !isAllowed(q.message.chat.id)) {
      return bot.answerCallbackQuery(q.id).catch(() => {});
    }
    const chatId = q.message.chat.id;

    if (q.data === 'cmd_status') {
      bot.answerCallbackQuery(q.id).catch(() => {});
      return sendStatus(chatId);
    }
    if (q.data === 'cmd_vmlist') {
      bot.answerCallbackQuery(q.id).catch(() => {});
      return sendBackupHelp(chatId);
    }
    if (q.data !== 'refresh_status') return bot.answerCallbackQuery(q.id).catch(() => {});

    bot.answerCallbackQuery(q.id, { text: 'Memperbarui…' }).catch(() => {});
    try {
      const text = await buildStatusMessage();
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: q.message.message_id,
        parse_mode: 'HTML',
        reply_markup: refreshKeyboard
      });
    } catch (e) {
      if (!/not modified/i.test(e.message)) console.error('[refresh]', e.message);
    }
  });
}

module.exports = { registerCommands };