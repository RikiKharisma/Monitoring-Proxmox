const cron = require('node-cron');
const { execFile } = require('child_process');
const path = require('path');

const SSH_KEY_PATH = path.join(__dirname, 'ssh', 'id_ed25519');
let isBackingUp = false;

/**
 * Eksekusi vzdump ke satu node Proxmox via SSH
 * @param {Object} server - Objek node dari servers.json (misal: { name, host, user, port })
 * @param {string} [vmid] - Opsional: ID VM/CT tertentu, kosongkan untuk --all
 */
function runVzdumpOnNode(server, vmid = '') {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const targetFlag = vmid ? `${vmid}` : '--all';
    // Sesuaikan --storage (misal: local, nfs-backup, atau pbs) dan retensi keep-weekly
    const remoteCmd = `vzdump ${targetFlag} --mode snapshot --compress zstd --storage local --prune-backups keep-weekly=4`;

    const sshArgs = [
      '-i', SSH_KEY_PATH,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-p', String(server.port || 22),
      `${server.user || 'root'}@${server.host}`,
      remoteCmd
    ];

    execFile('ssh', sshArgs, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      const durationSec = Math.round((Date.now() - startTime) / 1000);
      if (error) {
        resolve({
          node: server.name || server.host,
          success: false,
          durationSec,
          message: stderr || error.message
        });
      } else {
        // Ambil 5 baris terakhir log vzdump untuk ringkasan
        const summary = stdout.trim().split('\n').slice(-5).join('\n');
        resolve({
          node: server.name || server.host,
          success: true,
          durationSec,
          message: summary
        });
      }
    });
  });
}

/**
 * Jalankan backup untuk semua node atau node tertentu
 */
async function triggerBackup(bot, chatId, servers, triggerLabel = 'Manual', filterNode = '', vmid = '') {
  if (isBackingUp) {
    await bot.sendMessage(chatId, '⚠️ Proses backup masih berjalan. Tunggu hingga selesai sebelum memulai backup baru.');
    return;
  }

  const targetServers = filterNode
    ? servers.filter((s) => (s.name || s.host).toLowerCase() === filterNode.toLowerCase())
    : servers;

  if (targetServers.length === 0) {
    await bot.sendMessage(chatId, `❌ Node \`${filterNode}\` tidak ditemukan di \`servers.json\`.`, { parse_mode: 'Markdown' });
    return;
  }

  isBackingUp = true;
  await bot.sendMessage(
    chatId,
    `⏳ *Memulai Backup Proxmox (${triggerLabel})*\nTarget Node: ${targetServers.map((s) => s.name || s.host).join(', ')}\nTarget VM/CT: ${vmid || 'Semua (--all)'}`,
    { parse_mode: 'Markdown' }
  );

  try {
    for (const server of targetServers) {
      const res = await runVzdumpOnNode(server, vmid);
      const statusIcon = res.success ? '✅' : '❌';
      const report = [
        `${statusIcon} *Backup ${res.node}* (${res.durationSec} detik)`,
        '```',
        res.message.slice(-1500),
        '```'
      ].join('\n');

      await bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
    }
  } finally {
    isBackingUp = false;
  }
}

/**
 * Daftarkan cron mingguan dan handler command /backup ke instance bot
 */
function setupBackupFeature(bot, servers, adminChatId) {
  // Jadwal otomatis: Setiap hari Minggu pukul 02:00 WIB
  cron.schedule(
    '0 2 * * 0',
    () => {
      triggerBackup(bot, adminChatId, servers, 'Auto Mingguan');
    },
    { timezone: 'Asia/Jakarta' }
  );

  // Command manual:
  // /backup                  -> backup semua VM di semua node
  // /backup pve-01           -> backup semua VM di node pve-01
  // /backup pve-01 105       -> backup VMID 105 di node pve-01
  bot.onText(/^\/backup(?:\s+(\S+))?(?:\s+(\d+))?$/, (msg, match) => {
    if (String(msg.chat.id) !== String(adminChatId)) return;

    const filterNode = match[1] || '';
    const vmid = match[2] || '';
    triggerBackup(bot, msg.chat.id, servers, 'Manual /backup', filterNode, vmid);
  });
}

module.exports = { setupBackupFeature };