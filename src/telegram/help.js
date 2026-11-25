// ===========================================================================
// help.js - tampilan pesan /help. Mau ubah desainnya? Edit file ini.
//
// Tips format Telegram (HTML):
//   <b>tebal</b>  <i>miring</i>  <code>bisa di-tap untuk disalin</code>
//   <pre>teks rata (monospace)</pre>   |   baris kosong = jarak antar bagian
// ===========================================================================
const { servers, thresholds, backup } = require('../config');
const { scheduleSlot, scheduleText } = require('../backup/schedule');
const { esc, fmtDateShort } = require('../utils/format');

const LINE = '━━━━━━━━━━━━━━━━━━';

function buildHelpMessage() {
  // --- Blok backup otomatis (rata dengan <pre>) ---
  const auto = [];
  if (backup.enabled) {
    auto.push(`Jadwal : ${scheduleText()}`);
    auto.push(`Next   : ${fmtDateShort(scheduleSlot(1))}`);
    auto.push(`Simpan : ${backup.keepLast > 0 ? `${backup.keepLast} terbaru per VM` : 'semua (tidak dihapus)'}`);
  } else {
    auto.push('Jadwal : nonaktif');
  }
  auto.push('');
  const pad = Math.max(...servers.map((s) => s.name.length));
  for (const s of servers) {
    auto.push(`${s.name.padEnd(pad)} → ${s.backupStorage || 'local'}`);
  }

  return [
    `🤖 <b>PROXMOX MONITOR BOT</b>`,
    `<i>Pantau &amp; backup server Proxmox dari Telegram</i>`,
    LINE,
    ``,
    `📡 <b>MONITORING</b>`,
    `/status`,
    `└ Suhu, CPU, RAM, disk &amp; daftar VM`,
    ``,
    `💾 <b>BACKUP MANUAL</b>`,
    `/backup`,
    `└ Daftar VM + cara pakai`,
    `<code>/backup vm101</code>`,
    `└ Backup 1 VM/LXC`,
    `<code>/backup vm101 vm102</code>`,
    `└ Beberapa sekaligus`,
    `<code>/backup vm101 dell</code>`,
    `└ Tentukan server (jika ID sama)`,
    `<code>/backup all</code>`,
    `└ Backup semua VM &amp; LXC`,
    ``,
    `⏰ <b>BACKUP OTOMATIS</b>`,
    `<pre>${esc(auto.join('\n'))}</pre>`,
    ``,
    `🔔 <b>NOTIFIKASI OTOMATIS</b>`,
    `🔴 Server down  ·  🟢 pulih kembali`,
    `🌡 Suhu CPU ≥ ${thresholds.tempWarn}°C`,
    `⚙️ CPU ≥ ${thresholds.cpuWarn}%  ·  🧠 RAM ≥ ${thresholds.ramWarn}%  ·  💾 Disk ≥ ${thresholds.diskWarn}%`,
    LINE,
    `💡 <i>Tap perintah berwarna untuk menyalin</i>`
  ].join('\n');
}

// Tombol di bawah pesan /help
const helpKeyboard = {
  inline_keyboard: [
    [
      { text: '📡 Status Server', callback_data: 'cmd_status' },
      { text: '📦 Daftar VM', callback_data: 'cmd_vmlist' }
    ]
  ]
};

module.exports = { buildHelpMessage, helpKeyboard };