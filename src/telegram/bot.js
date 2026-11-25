// ===========================================================================
// bot.js - membuat koneksi bot Telegram + fungsi send()
// File lain cukup: const { bot, send } = require('../telegram/bot');
// ===========================================================================
const TelegramBot = require('node-telegram-bot-api');
const { telegram } = require('../config');

const bot = new TelegramBot(telegram.token, { polling: true });
bot.on('polling_error', (e) => console.error('[Telegram polling]', e.code || e.message));

// Kirim pesan ke chat yang diizinkan (ALLOWED_CHAT_ID)
async function send(text, opts = {}) {
  try {
    return await bot.sendMessage(telegram.chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...opts
    });
  } catch (e) {
    console.error('[send]', e.message);
  }
}

// Hanya chat yang terdaftar yang boleh memakai perintah bot
const isAllowed = (chatId) => String(chatId) === String(telegram.chatId);

module.exports = { bot, send, isAllowed };
