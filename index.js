// ===========================================================================
// index.js - titik masuk aplikasi. Hanya menyalakan semua bagian.
// Logika ada di folder src/ (lihat README.md untuk peta file).
// ===========================================================================
const { servers, monitor } = require('./src/config');
require('./src/telegram/bot'); // menyalakan koneksi Telegram
const { registerCommands } = require('./src/telegram/commands');
const { runHealthChecks } = require('./src/monitor/health');
const { runResourceChecks } = require('./src/monitor/resources');
const { startBackupScheduler } = require('./src/backup/scheduler');
const { scheduleText } = require('./src/backup/schedule');

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message));

// 1. Perintah Telegram (/status, /backup, /help)
registerCommands();

// 2. Cek server hidup/mati (ping + API)
runHealthChecks();
setInterval(runHealthChecks, monitor.checkIntervalSec * 1000);

// 3. Cek resource (suhu/CPU/RAM/disk), mulai 10 detik setelah start
setTimeout(() => {
  runResourceChecks();
  setInterval(runResourceChecks, monitor.metricsIntervalSec * 1000);
}, 10000);

// 4. Backup mingguan otomatis
startBackupScheduler();

console.log(
  `Monitoring ${servers.length} server Proxmox aktif ` +
    `(ping/API tiap ${monitor.checkIntervalSec}s, resource tiap ${monitor.metricsIntervalSec}s, ` +
    `backup ${scheduleText()})...`
);
