// ===========================================================================
// scheduler.js - tiap menit cek: sudah waktunya backup mingguan belum?
// ===========================================================================
const { backup } = require('../config');
const { state, load, save } = require('./state');
const { scheduleSlot } = require('./schedule');
const { runFullBackup } = require('./runner');

function checkBackupSchedule() {
  if (!backup.enabled || state.running) return;

  const slot = scheduleSlot();
  if (state.lastRun >= slot.getTime()) return; // jadwal ini sudah dijalankan

  const lateMs = Date.now() - slot.getTime();
  if (lateMs > backup.catchupHours * 3600 * 1000) {
    // jadwal terlewat terlalu lama (bot mati) -> lewati, tunggu jadwal berikutnya
    state.lastRun = slot.getTime();
    save();
    return;
  }
  runFullBackup('scheduled');
}

function startBackupScheduler() {
  if (!load()) {
    state.lastRun = Date.now(); // pertama kali jalan: jangan langsung backup
    save();
  }
  setInterval(checkBackupSchedule, 60 * 1000);
}

module.exports = { startBackupScheduler };
