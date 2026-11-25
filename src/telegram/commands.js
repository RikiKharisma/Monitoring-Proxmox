// ===========================================================================
// commands.js - semua perintah Telegram: /status, /backup, /help, tombol Refresh
// Mau tambah perintah baru? Tambahkan bot.onText(...) di dalam registerCommands().
// ===========================================================================
const { thresholds } = require('../config');
const { bot, isAllowed } = require('./bot');
const { buildStatusMessage, refreshKeyboard } = require('./status');
const { runBackupAll } = require('../backup/runner');
const { state: backupState } = require('../backup/state');
const { scheduleText } = require('../backup/schedule');
const { esc } = require('../utils/format');

function registerCommands() {
  // Daftar menu perintah yang muncul di Telegram
  bot
    .setMyCommands([
      { command: 'status', description: 'Lihat status lengkap server' },
      { command: 'backup', description: 'Jalankan backup VM & LXC sekarang' },
      { command: 'help', description: 'Bantuan' }
    ])
    .catch(() => {});

  // /status (juga /start dan /cek)
  bot.onText(/^\/(start|cek|status)(@\w+)?$/i, async (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
    try {
      const text = await buildStatusMessage();
      await bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML', reply_markup: refreshKeyboard });
    } catch (e) {
      console.error('[status]', e.message);
      bot
        .sendMessage(msg.chat.id, `❌ Gagal mengambil status: ${esc(e.message)}`, { parse_mode: 'HTML' })
        .catch(() => {});
    }
  });

  // /backup -> langsung backup semua server
  bot.onText(/^\/backup(@\w+)?$/i, (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    if (backupState.running) {
      return bot.sendMessage(msg.chat.id, '⏳ Backup sedang berjalan, tunggu sampai selesai.').catch(() => {});
    }
    // tidak di-await: backup bisa berjam-jam, hasil dikirim lewat notifikasi
    runBackupAll('manual');
  });

  // /help
  bot.onText(/^\/help(@\w+)?$/i, (msg) => {
    if (!isAllowed(msg.chat.id)) return;
    bot.sendMessage(
      msg.chat.id,
      [
        `🤖 <b>Proxmox Monitor Bot</b>`,
        ``,
        `/status – status lengkap (suhu, CPU, RAM, disk, VM)`,
        `/backup – backup semua VM &amp; LXC sekarang`,
        ``,
        `Backup otomatis: ${scheduleText()}`,
        ``,
        `Notifikasi otomatis:`,
        `🔴 Server down / 🟢 pulih`,
        `⚠️ Suhu CPU ≥ ${thresholds.tempWarn}°C`,
        `⚠️ CPU ≥ ${thresholds.cpuWarn}% · RAM ≥ ${thresholds.ramWarn}% · Disk ≥ ${thresholds.diskWarn}%`
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  });

  // Tombol Refresh: edit pesan yang sama
  bot.on('callback_query', async (q) => {
    if (!q.message || !isAllowed(q.message.chat.id)) {
      return bot.answerCallbackQuery(q.id).catch(() => {});
    }
    if (q.data !== 'refresh_status') return bot.answerCallbackQuery(q.id).catch(() => {});
    bot.answerCallbackQuery(q.id, { text: 'Memperbarui…' }).catch(() => {});
    try {
      const text = await buildStatusMessage();
      await bot.editMessageText(text, {
        chat_id: q.message.chat.id,
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
