// ===========================================================================
// schedule.js - hitung jadwal backup mingguan (hari + jam dari config.js)
// ===========================================================================
const { backup } = require('../config');

const DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

// offsetWeeks = 0 -> jadwal terakhir yang sudah lewat
// offsetWeeks = 1 -> jadwal berikutnya
function scheduleSlot(offsetWeeks = 0) {
  const d = new Date();
  d.setHours(backup.hour, backup.minute, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - backup.day + 7) % 7));
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 7);
  d.setDate(d.getDate() + offsetWeeks * 7);
  return d;
}

// Teks untuk /help, contoh: "tiap Minggu 02:00 WIB"
function scheduleText() {
  if (!backup.enabled) return 'nonaktif';
  const hh = String(backup.hour).padStart(2, '0');
  const mm = String(backup.minute).padStart(2, '0');
  return `tiap ${DAY_NAMES[backup.day]} ${hh}:${mm} WIB`;
}

module.exports = { scheduleSlot, scheduleText };
