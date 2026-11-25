// ===========================================================================
// status.js - merakit pesan /status lengkap untuk semua server
// ===========================================================================
const { servers } = require('../config');
const { serverStates } = require('../monitor/state');
const { runHealthChecks } = require('../monitor/health');
const { getMetrics } = require('../monitor/metrics');
const { renderServer, renderDown } = require('./render');
const { esc, now } = require('../utils/format');

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

module.exports = { buildStatusMessage, refreshKeyboard };
