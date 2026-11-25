// ===========================================================================
// metrics.js - ambil data resource: dari API Proxmox + suhu CPU via SSH
// ===========================================================================
const fs = require('fs');
const { execFile } = require('child_process');
const { monitor } = require('../config');
const { pve } = require('../proxmox/api');

// Membaca sensor suhu dari /sys/class/hwmon (tidak butuh lm-sensors)
const TEMP_CMD =
  'for d in /sys/class/hwmon/hwmon*; do n=$(cat $d/name 2>/dev/null); ' +
  'for f in $d/temp*_input; do [ -f "$f" ] && echo "$n $(cat $f 2>/dev/null)"; done; done';

function getCpuTemp(srv) {
  return new Promise((resolve) => {
    if (!fs.existsSync(monitor.sshKeyPath)) {
      return resolve({ ok: false, value: null, error: 'SSH key belum dipasang' });
    }
    const args = [
      '-i', monitor.sshKeyPath,
      '-p', String(srv.sshPort || 22),
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-o', 'ConnectTimeout=5',
      `${srv.sshUser || 'root'}@${srv.ip}`,
      TEMP_CMD
    ];
    execFile('ssh', args, { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, value: null, error: 'SSH gagal' });
      const cpuChips = /coretemp|k10temp|zenpower|cpu_thermal|x86_pkg_temp/i;
      const fallback = /acpitz/i;
      const cpu = [];
      const fb = [];
      for (const line of stdout.split('\n')) {
        const i = line.lastIndexOf(' ');
        if (i < 0) continue;
        const chip = line.slice(0, i).trim();
        const val = parseInt(line.slice(i + 1), 10) / 1000;
        if (!Number.isFinite(val) || val <= 0 || val > 150) continue;
        if (cpuChips.test(chip)) cpu.push(val);
        else if (fallback.test(chip)) fb.push(val);
      }
      const list = cpu.length ? cpu : fb;
      if (!list.length) return resolve({ ok: false, value: null, error: 'sensor tidak ditemukan' });
      resolve({ ok: true, value: Math.max(...list), error: null });
    });
  });
}

// Gabungan: node, VM/LXC, storage, dan suhu
async function getMetrics(srv) {
  const [resources, temp] = await Promise.all([pve(srv, '/cluster/resources'), getCpuTemp(srv)]);
  const nodes = resources.filter((r) => r.type === 'node');
  for (const n of nodes) {
    try {
      n.status = await pve(srv, `/nodes/${n.node}/status`);
    } catch (_) {
      n.status = null;
    }
  }
  return {
    temp,
    nodes,
    guests: resources
      .filter((r) => r.type === 'qemu' || r.type === 'lxc')
      .sort((a, b) => a.vmid - b.vmid),
    storages: resources.filter((r) => r.type === 'storage')
  };
}

module.exports = { getMetrics };
