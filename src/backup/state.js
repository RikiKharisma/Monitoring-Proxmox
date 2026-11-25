// ===========================================================================
// state.js (backup) - mengingat kapan backup terakhir jalan (disimpan di file)
// supaya setelah bot restart tidak backup dua kali.
// ===========================================================================
const fs = require('fs');
const path = require('path');
const { backup } = require('../config');

const state = {
  lastRun: 0, // waktu backup terakhir (ms), disimpan ke file
  running: false // sedang backup atau tidak (hanya di memori)
};

// Return true jika file state ditemukan
function load() {
  try {
    const data = JSON.parse(fs.readFileSync(backup.stateFile, 'utf8'));
    state.lastRun = data.lastRun || 0;
    return true;
  } catch (_) {
    return false;
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(backup.stateFile), { recursive: true });
    fs.writeFileSync(backup.stateFile, JSON.stringify({ lastRun: state.lastRun }));
  } catch (e) {
    console.error('[backup] gagal simpan state:', e.message);
  }
}

module.exports = { state, load, save };
