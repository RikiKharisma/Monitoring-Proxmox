// ===========================================================================
// state.js - menyimpan status tiap server di memori (down/up, hitungan gagal)
// ===========================================================================
const { servers } = require('../config');

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

module.exports = { serverStates };
