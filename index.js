require('dotenv').config();
const fs = require('fs');
const https = require('https');
const { execFile } = require('child_process');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const servers = require('./servers.json');

const {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_CHAT_ID,
  CHECK_INTERVAL_SECONDS = 15,
  FAIL_THRESHOLD = 3,
  METRICS_INTERVAL_SECONDS = 60, // interval cek suhu/CPU/RAM/disk
  TEMP_WARN = 70, // °C -> "Hangat"
  TEMP_CRIT = 85, // °C -> "Panas kritis"
  CPU_WARN = 90, // %
  RAM_WARN = 90, // %
  DISK_WARN = 90, // %
  SSH_KEY_PATH = '/app/ssh/id_ed25519'
} = process.env;

const TIMEZONE = 'Asia/Jakarta';
const RESOURCE_CONFIRM = 3; // berapa kali cek berturut-turut sebelum alert resource dikirim

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
bot.on('polling_error', (e) => console.error('[Telegram polling]', e.code || e.message));
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const serverStates = new Map();
servers.forEach((srv) => {
  serverStates.set(srv.name, {
    isDown: false,
    downSince: null,
    failCount: 0,
    lastReason: null,
    lastPingMs: null,
    res: {} // state alert resource: key -> { count, active, label }
  });
});

// ---------------------------------------------------------------------------
// Helpers tampilan
// ---------------------------------------------------------------------------
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const now = () =>
  new Date().toLocaleString('id-ID', { timeZone: TIMEZONE, hour12: false });

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
  if (t >= Number(TEMP_CRIT)) return { icon: '🔥', label: 'PANAS KRITIS' };
  if (t >= Number(TEMP_WARN)) return { icon: '⚠️', label: 'Hangat' };
  return { icon: '✅', label: 'Normal' };
}

async function send(text, opts = {}) {
  try {
    return await bot.sendMessage(ALLOWED_CHAT_ID, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...opts
    });
  } catch (e) {
    console.error('[send]', e.message);
  }
}

// ---------------------------------------------------------------------------
// Pengecekan koneksi (ping + API)
// ---------------------------------------------------------------------------
function checkPing(ip) {
  return new Promise((resolve) => {
    execFile('ping', ['-c', '1', '-W', '2', ip], (error, stdout) => {
      if (error) return resolve({ alive: false, latency: null });
      const m = /time[=<]([\d.]+)/.exec(stdout || '');
      resolve({ alive: true, latency: m ? Math.round(parseFloat(m[1])) : 0 });
    });
  });
}

async function pve(srv, path) {
  const r = await axios.get(`${srv.url}/api2/json${path}`, {
    httpsAgent,
    timeout: 8000,
    headers: { Authorization: `PVEAPIToken=${srv.tokenId}=${srv.tokenSecret}` }
  });
  return r.data.data;
}

async function checkProxmoxApi(srv) {
  try {
    await pve(srv, '/version');
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err.code || err.message };
  }
}

async function checkSingleServer(srv) {
  const state = serverStates.get(srv.name);
  const [pingRes, apiRes] = await Promise.all([checkPing(srv.ip), checkProxmoxApi(srv)]);
  state.lastPingMs = pingRes.latency;

  if (pingRes.alive && apiRes.ok) {
    state.failCount = 0;
    if (state.isDown) {
      const downtimeMs = Date.now() - state.downSince;
      state.isDown = false;
      state.downSince = null;
      state.lastReason = null;

      await send(
        [
          `🟢 <b>SERVER KEMBALI ONLINE</b>`,
          ``,
          `🖥 <b>${esc(srv.name)}</b> · <code>${esc(srv.ip)}</code>`,
          `📶 Ping: ${pingRes.latency} ms`,
          `⏳ Total downtime: <b>${formatDuration(downtimeMs)}</b>`,
          `🕒 Pulih: ${now()}`
        ].join('\n')
      );
    }
    return;
  }

  state.failCount++;
  let reason;
  if (!pingRes.alive && !apiRes.ok) {
    reason = `Host tidak terjangkau (ping timeout & API mati: ${apiRes.error})`;
  } else if (pingRes.alive && !apiRes.ok) {
    reason = `Service Proxmox mati/hang (ping ${pingRes.latency}ms, API error: ${apiRes.error})`;
  } else {
    reason = `Ping diblokir/timeout (API masih responsif)`;
  }
  state.lastReason = reason;
  console.warn(`[${srv.name}] Gagal ${state.failCount}/${FAIL_THRESHOLD} - ${reason}`);

  if (!state.isDown && state.failCount >= Number(FAIL_THRESHOLD)) {
    state.isDown = true;
    state.downSince = Date.now();

    await send(
      [
        `🚨🔴 <b>ALERT: SERVER DOWN!</b> 🔴🚨`,
        ``,
        `🖥 <b>${esc(srv.name)}</b> · <code>${esc(srv.ip)}</code>`,
        `🔎 Diagnosa: ${esc(reason)}`,
        `🕒 Waktu: ${now()}`
      ].join('\n')
    );
  }
}

async function runHealthChecks() {
  await Promise.all(
    servers.map((srv) =>
      checkSingleServer(srv).catch((e) => console.error(`[${srv.name}] check error:`, e.message))
    )
  );
}

// ---------------------------------------------------------------------------
// Metrics: resource via Proxmox API, suhu CPU via SSH (opsional)
// ---------------------------------------------------------------------------
// Membaca sensor suhu dari /sys/class/hwmon (tidak butuh lm-sensors)
const TEMP_CMD =
  'for d in /sys/class/hwmon/hwmon*; do n=$(cat $d/name 2>/dev/null); ' +
  'for f in $d/temp*_input; do [ -f "$f" ] && echo "$n $(cat $f 2>/dev/null)"; done; done';

function getCpuTemp(srv) {
  return new Promise((resolve) => {
    if (!fs.existsSync(SSH_KEY_PATH)) {
      return resolve({ ok: false, value: null, error: 'SSH key belum dipasang' });
    }
    const args = [
      '-i', SSH_KEY_PATH,
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
      let cpu = [];
      let fb = [];
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

// ---------------------------------------------------------------------------
// Render pesan Telegram
// ---------------------------------------------------------------------------
function metricLine(label, p, extra, warnAt) {
  const flag = p >= warnAt ? ' ⚠️' : '';
  return `${label.padEnd(5)} ${bar(p)} ${p.toFixed(0).padStart(3)}%${extra ? '  ' + extra : ''}${flag}`;
}

function renderServer(srv, state, m) {
  const out = [];
  out.push(`🟢 <b>${esc(srv.name)}</b> · <code>${esc(srv.ip)}</code>`);
  out.push(`Online · Ping ${state.lastPingMs !== null ? state.lastPingMs + ' ms' : 'OK'}`);

  if (m.temp.ok) {
    const lv = tempLevel(m.temp.value);
    out.push(`🌡 Suhu CPU: <b>${m.temp.value.toFixed(0)}°C</b> ${lv.icon} ${lv.label}`);
  } else {
    out.push(`🌡 Suhu CPU: <i>tidak tersedia (${esc(m.temp.error)})</i>`);
  }

  if (!m.nodes.length) {
    out.push(`\n⚠️ <i>Data resource kosong. Pastikan API token punya role PVEAuditor.</i>`);
  }

  for (const n of m.nodes) {
    out.push('');
    if (n.status === 'offline' || n.uptime === 0) {
      out.push(`🖥 <b>Node ${esc(n.node)}</b> · 🔴 OFFLINE`);
      continue;
    }
    const up = formatDuration((n.uptime || 0) * 1000);
    out.push(`🖥 <b>Node ${esc(n.node)}</b> · ⏱ ${up}`);
    const info = n.status && n.status.cpuinfo;
    if (info) out.push(`<i>${esc(info.model)} · ${info.cpus} core</i>`);

    const lines = [
      metricLine('CPU', (n.cpu || 0) * 100, '', Number(CPU_WARN)),
      metricLine(
        'RAM', pct(n.mem, n.maxmem),
        `${fmtBytes(n.mem)}/${fmtBytes(n.maxmem)}`, Number(RAM_WARN)
      ),
      metricLine(
        'Disk', pct(n.disk, n.maxdisk),
        `${fmtBytes(n.disk)}/${fmtBytes(n.maxdisk)}`, Number(DISK_WARN)
      )
    ];
    const sw = n.status && n.status.swap;
    if (sw && sw.total > 0) {
      lines.push(metricLine('Swap', pct(sw.used, sw.total), `${fmtBytes(sw.used)}/${fmtBytes(sw.total)}`, 90));
    }
    const la = n.status && n.status.loadavg;
    if (la) lines.push(`Load  ${la.map((x) => Number(x).toFixed(2)).join(' ')}`);
    out.push(`<pre>${esc(lines.join('\n'))}</pre>`);
  }

  if (m.storages.length) {
    const seen = new Set();
    const rows = [];
    for (const s of m.storages) {
      const key = `${s.storage}`;
      if (seen.has(key) || !s.maxdisk) continue;
      seen.add(key);
      const p = pct(s.disk, s.maxdisk);
      rows.push(
        `${s.storage.slice(0, 10).padEnd(10)} ${bar(p, 8)} ${p.toFixed(0).padStart(3)}%` +
          `  ${fmtBytes(s.disk)}/${fmtBytes(s.maxdisk)}${p >= Number(DISK_WARN) ? ' ⚠️' : ''}`
      );
    }
    if (rows.length) {
      out.push(`\n💾 <b>Storage</b>`);
      out.push(`<pre>${esc(rows.slice(0, 6).join('\n'))}</pre>`);
    }
  }

  if (m.guests.length) {
    const running = m.guests.filter((g) => g.status === 'running').length;
    out.push(`\n📦 <b>VM &amp; LXC</b> · ${running}/${m.guests.length} berjalan`);
    const rows = m.guests.slice(0, 15).map((g) => {
      const icon = g.status === 'running' ? '🟢' : '⚫';
      const kind = g.type === 'qemu' ? 'VM' : 'LXC';
      return `${icon} <code>${g.vmid}</code> ${esc(g.name || '-')} <i>(${kind})</i>`;
    });
    out.push(rows.join('\n'));
    if (m.guests.length > 15) out.push(`<i>…dan ${m.guests.length - 15} lainnya</i>`);
  }

  return out.join('\n');
}

function renderDown(srv, state) {
  return [
    `🔴 <b>${esc(srv.name)}</b> · <code>${esc(srv.ip)}</code>`,
    `Status: <b>DOWN</b> sejak ${formatDuration(Date.now() - state.downSince)} lalu`,
    `🔎 ${esc(state.lastReason || '-')}`
  ].join('\n');
}

async function buildStatusMessage() {
  await runHealthChecks();
  const blocks = [];
  for (const srv of servers) {
    const state = serverStates.get(srv.name);
    if (state.isDown) {
      blocks.push(renderDown(srv, state));
      continue;
    }
    try {
      blocks.push(renderServer(srv, state, await getMetrics(srv)));
    } catch (e) {
      blocks.push(
        `🟡 <b>${esc(srv.name)}</b> · <code>${esc(srv.ip)}</code>\n` +
          `Online, tapi gagal ambil data resource: ${esc(e.code || e.message)}`
      );
    }
  }
  const header = `📡 <b>STATUS SERVER PROXMOX</b>\n━━━━━━━━━━━━━━━━━━`;
  const footer = `\n━━━━━━━━━━━━━━━━━━\n🕒 Diperbarui: ${now()}`;
  return `${header}\n\n${blocks.join('\n\n')}${footer}`;
}

const refreshKeyboard = {
  inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'refresh_status' }]]
};

// ---------------------------------------------------------------------------
// Alert resource otomatis (suhu, CPU, RAM, disk)
// ---------------------------------------------------------------------------
function buildConditions(m) {
  const c = [];
  if (m.temp.ok) {
    const v = m.temp.value;
    c.push({
      key: 'temp',
      label: 'Suhu CPU',
      bad: v >= Number(TEMP_WARN),
      text: `${v >= Number(TEMP_CRIT) ? '🔥' : '🌡'} Suhu CPU <b>${v.toFixed(0)}°C</b> (batas ${TEMP_WARN}°C)`
    });
  }
  for (const n of m.nodes) {
    if (n.status === 'offline') continue;
    const cpu = (n.cpu || 0) * 100;
    const ram = pct(n.mem, n.maxmem);
    const disk = pct(n.disk, n.maxdisk);
    c.push({ key: `cpu:${n.node}`, label: `CPU ${n.node}`, bad: cpu >= Number(CPU_WARN),
      text: `⚙️ CPU ${esc(n.node)} <b>${cpu.toFixed(0)}%</b> (batas ${CPU_WARN}%)` });
    c.push({ key: `ram:${n.node}`, label: `RAM ${n.node}`, bad: ram >= Number(RAM_WARN),
      text: `🧠 RAM ${esc(n.node)} <b>${ram.toFixed(0)}%</b> (batas ${RAM_WARN}%)` });
    c.push({ key: `rootfs:${n.node}`, label: `Disk root ${n.node}`, bad: disk >= Number(DISK_WARN),
      text: `💾 Disk root ${esc(n.node)} <b>${disk.toFixed(0)}%</b> (batas ${DISK_WARN}%)` });
  }
  const seen = new Set();
  for (const s of m.storages) {
    if (!s.maxdisk || seen.has(s.storage)) continue;
    seen.add(s.storage);
    const p = pct(s.disk, s.maxdisk);
    c.push({ key: `st:${s.storage}`, label: `Storage ${s.storage}`, bad: p >= Number(DISK_WARN),
      text: `💾 Storage ${esc(s.storage)} <b>${p.toFixed(0)}%</b> (batas ${DISK_WARN}%)` });
  }
  return c;
}

async function checkResources(srv) {
  const state = serverStates.get(srv.name);
  if (state.isDown) return;
  let m;
  try {
    m = await getMetrics(srv);
  } catch (_) {
    return; // kalau API gagal, ditangani oleh logika DOWN
  }

  const alerts = [];
  const recovered = [];
  for (const cond of buildConditions(m)) {
    const e = (state.res[cond.key] = state.res[cond.key] || { count: 0, active: false });
    e.label = cond.label;
    if (cond.bad) {
      e.count++;
      if (e.count >= RESOURCE_CONFIRM && !e.active) {
        e.active = true;
        alerts.push(cond.text);
      }
    } else {
      e.count = 0;
      if (e.active) {
        e.active = false;
        recovered.push(esc(cond.label));
      }
    }
  }

  if (alerts.length) {
    await send(
      [
        `⚠️ <b>PERINGATAN RESOURCE</b>`,
        `🖥 <b>${esc(srv.name)}</b> · <code>${esc(srv.ip)}</code>`,
        ``,
        ...alerts.map((a) => `• ${a}`),
        ``,
        `🕒 ${now()}`
      ].join('\n')
    );
  }
  if (recovered.length) {
    await send(
      [
        `✅ <b>RESOURCE KEMBALI NORMAL</b>`,
        `🖥 <b>${esc(srv.name)}</b>`,
        ``,
        ...recovered.map((r) => `• ${r}`)
      ].join('\n')
    );
  }
}

async function runResourceChecks() {
  await Promise.all(
    servers.map((srv) =>
      checkResources(srv).catch((e) => console.error(`[${srv.name}] resource error:`, e.message))
    )
  );
}

// ---------------------------------------------------------------------------
// Command Telegram
// ---------------------------------------------------------------------------
const isAllowed = (chatId) => String(chatId) === String(ALLOWED_CHAT_ID);

bot.setMyCommands([
  { command: 'status', description: 'Lihat status lengkap server' },
  { command: 'help', description: 'Bantuan' }
]).catch(() => {});

bot.onText(/^\/(start|cek|status)(@\w+)?$/i, async (msg) => {
  if (!isAllowed(msg.chat.id)) return;
  bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
  try {
    const text = await buildStatusMessage();
    await bot.sendMessage(msg.chat.id, text, {
      parse_mode: 'HTML',
      reply_markup: refreshKeyboard
    });
  } catch (e) {
    console.error('[status]', e.message);
    bot.sendMessage(msg.chat.id, `❌ Gagal mengambil status: ${esc(e.message)}`, { parse_mode: 'HTML' }).catch(() => {});
  }
});

bot.onText(/^\/help(@\w+)?$/i, (msg) => {
  if (!isAllowed(msg.chat.id)) return;
  bot.sendMessage(
    msg.chat.id,
    [
      `🤖 <b>Proxmox Monitor Bot</b>`,
      ``,
      `/status – status lengkap (suhu, CPU, RAM, disk, VM)`,
      ``,
      `Notifikasi otomatis:`,
      `🔴 Server down / 🟢 pulih`,
      `⚠️ Suhu CPU ≥ ${TEMP_WARN}°C`,
      `⚠️ CPU ≥ ${CPU_WARN}% · RAM ≥ ${RAM_WARN}% · Disk ≥ ${DISK_WARN}%`
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

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message));

runHealthChecks();
setInterval(runHealthChecks, Number(CHECK_INTERVAL_SECONDS) * 1000);
setTimeout(() => {
  runResourceChecks();
  setInterval(runResourceChecks, Number(METRICS_INTERVAL_SECONDS) * 1000);
}, 10000);

console.log(
  `Monitoring ${servers.length} server Proxmox aktif ` +
    `(ping/API tiap ${CHECK_INTERVAL_SECONDS}s, resource tiap ${METRICS_INTERVAL_SECONDS}s)...`
);
