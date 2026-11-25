// ===========================================================================
// format.js - fungsi kecil untuk merapikan teks (tanggal, durasi, bar, dll)
// ===========================================================================
const { timezone, thresholds } = require('../config');

// Escape karakter khusus agar aman dikirim sebagai HTML ke Telegram
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmtDate = (d = new Date()) =>
  d.toLocaleString('id-ID', { timeZone: timezone, hour12: false });

const now = () => fmtDate();

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (d > 0) parts.push(`${d} hari`);
  if (h > 0) parts.push(`${h} jam`);
  if (m > 0) parts.push(`${m} menit`);
  if (d === 0 && h === 0) parts.push(`${s} detik`);
  return parts.join(' ');
}

// Progress bar: ▰▰▰▱▱▱▱▱▱▱
function bar(pct, len = 10) {
  const filled = Math.max(0, Math.min(len, Math.round((pct / 100) * len)));
  return '▰'.repeat(filled) + '▱'.repeat(len - filled);
}

function fmtBytes(b) {
  const gb = b / 1024 ** 3;
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)}T` : `${gb.toFixed(1)}G`;
}

const pct = (used, total) => (total > 0 ? (used / total) * 100 : 0);

function tempLevel(t) {
  if (t >= thresholds.tempCrit) return { icon: '🔥', label: 'PANAS KRITIS' };
  if (t >= thresholds.tempWarn) return { icon: '⚠️', label: 'Hangat' };
  return { icon: '✅', label: 'Normal' };
}

module.exports = { esc, fmtDate, now, formatDuration, bar, fmtBytes, pct, tempLevel };
