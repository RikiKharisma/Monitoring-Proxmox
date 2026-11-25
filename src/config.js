// ===========================================================================
// config.js - SEMUA pengaturan ada di sini.
// Nilai dibaca dari file .env (lihat README.md untuk daftar lengkapnya).
// Kalau mau ganti batas suhu, jadwal backup, dll -> cukup edit .env,
// atau ubah nilai default (angka di kanan) di file ini.
// ===========================================================================
require('dotenv').config();
const servers = require('../servers.json');

const env = process.env;

// Ambil angka dari env; kalau kosong pakai nilai default
const num = (value, fallback) =>
  value === undefined || value === '' ? fallback : Number(value);

module.exports = {
  servers,
  timezone: 'Asia/Jakarta',

  telegram: {
    token: env.TELEGRAM_BOT_TOKEN,
    chatId: env.ALLOWED_CHAT_ID // hanya chat ini yang boleh memakai bot
  },

  monitor: {
    checkIntervalSec: num(env.CHECK_INTERVAL_SECONDS, 15), // cek ping + API
    failThreshold: num(env.FAIL_THRESHOLD, 3), // gagal berturut-turut sebelum dianggap DOWN
    metricsIntervalSec: num(env.METRICS_INTERVAL_SECONDS, 60), // cek suhu/CPU/RAM/disk
    resourceConfirm: 3, // cek berturut-turut sebelum alert resource dikirim
    sshKeyPath: env.SSH_KEY_PATH || '/app/ssh/id_ed25519'
  },

  // Batas alert resource
  thresholds: {
    tempWarn: num(env.TEMP_WARN, 70), // °C -> "Hangat"
    tempCrit: num(env.TEMP_CRIT, 85), // °C -> "Panas kritis"
    cpuWarn: num(env.CPU_WARN, 90), // %
    ramWarn: num(env.RAM_WARN, 90), // %
    diskWarn: num(env.DISK_WARN, 90) // %
  },

  backup: {
    enabled: String(env.BACKUP_ENABLED === undefined ? 'true' : env.BACKUP_ENABLED).toLowerCase() === 'true',
    day: num(env.BACKUP_DAY, 0), // 0=Minggu, 1=Senin, ... 6=Sabtu
    hour: num(env.BACKUP_HOUR, 2), // jam 0-23 (waktu Asia/Jakarta)
    minute: num(env.BACKUP_MINUTE, 0),
    mode: env.BACKUP_MODE || 'snapshot', // snapshot | suspend | stop
    compress: env.BACKUP_COMPRESS || 'zstd', // 0 | gzip | lzo | zstd
    keepLast: num(env.BACKUP_KEEP_LAST, 1),
    timeoutHours: num(env.BACKUP_TIMEOUT_HOURS, 12), // batas tunggu 1 job backup
    catchupHours: num(env.BACKUP_CATCHUP_HOURS, 6), // jika bot mati saat jadwal, tetap jalan kalau telat <= x jam
    stateFile: env.BACKUP_STATE_FILE || '/app/data/backup-state.json'
  }
};
