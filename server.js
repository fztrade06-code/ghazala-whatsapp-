const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
require('dotenv').config();

const { initDB, getPool } = require('./database');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// ── Startup warnings ────────────────────────────────────────
['WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'JWT_SECRET', 'ADMIN_PASSWORD'].forEach(v => {
  if (!process.env[v]) console.warn(`⚠️  Missing env var: ${v} — using insecure default`);
});

// ── CORS ────────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: ALLOWED_ORIGIN }));

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
// Serve static files from root directory (where index.html lives)
app.use(express.static(__dirname));

const upload = multer({ dest: 'uploads/', limits: { fileSize: 90 * 1024 * 1024 } });
// Railway's filesystem starts fresh — make sure the uploads folder actually exists
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads', { recursive: true });

const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'ghazala2024';
const WA_API = PHONE_ID ? `https://graph.facebook.com/v18.0/${PHONE_ID}/messages` : null;
const JWT_SECRET = process.env.JWT_SECRET || 'ghazala_secret_change_me';
const ADMIN_PHONE = process.env.ADMIN_WHATSAPP || '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';

// ── Rate limiters ───────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again in 15 minutes.' }
});
const otpLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many OTP attempts. Wait 5 minutes.' }
});

// ── WebSocket ───────────────────────────────────────────────
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach(ws => {
    try { if (ws.readyState === 1) ws.send(msg); } catch (e) {}
  });
}

// ── OTP Store ───────────────────────────────────────────────
const otpStore = new Map();

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendOTPWhatsApp(phone, otp, purpose = 'login') {
  if (!phone || !WA_TOKEN || !WA_API) return false;
  try {
    const msg = `🔐 *Ghazala Institute*\n\nYour ${purpose} OTP is:\n\n*${otp}*\n\n⏰ Valid for 10 minutes.\nDo not share this code.`;
    await axios.post(WA_API, {
      messaging_product: 'whatsapp', to: phone, type: 'text',
      text: { body: msg }
    }, { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } });
    return true;
  } catch (e) {
    console.error('OTP WhatsApp error:', e.message);
    return false;
  }
}

async function sendOTPEmail(email, otp, purpose = 'login') {
  if (!email || !process.env.SMTP_USER) return false;
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transporter.sendMail({
      from: `"Ghazala Institute" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `Your OTP — Ghazala Institute`,
      html: `<div style="font-family:sans-serif;padding:20px;background:#f5f5f5;">
        <h2 style="color:#128C7E;">Ghazala Institute</h2>
        <p>Your <b>${purpose}</b> OTP is:</p>
        <h1 style="letter-spacing:8px;color:#333;">${otp}</h1>
        <p style="color:#666;">Valid for 10 minutes. Do not share this code.</p>
      </div>`
    });
    return true;
  } catch (e) {
    console.error('OTP Email error:', e.message);
    return false;
  }
}

// ── Auth middleware ─────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ── WhatsApp send helpers ───────────────────────────────────
async function sendTextMessage(phone, text) {
  if (!WA_API || !WA_TOKEN) return null;
  try {
    const r = await axios.post(WA_API, {
      messaging_product: 'whatsapp', to: phone, type: 'text',
      text: { body: text, preview_url: false }
    }, { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } });
    return r.data;
  } catch (err) {
    console.error('Send text error:', err.response?.data || err.message);
    return null;
  }
}

async function sendInteractiveButtons(phone, bodyText, buttons) {
  if (!WA_API || !WA_TOKEN) return null;
  try {
    if (buttons.length <= 3) {
      const r = await axios.post(WA_API, {
        messaging_product: 'whatsapp', to: phone, type: 'interactive',
        interactive: {
          type: 'button', body: { text: bodyText },
          action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title.substring(0, 20) } })) }
        }
      }, { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } });
      return r.data;
    } else {
      const r = await axios.post(WA_API, {
        messaging_product: 'whatsapp', to: phone, type: 'interactive',
        interactive: {
          type: 'list', body: { text: bodyText },
          action: { button: 'Choose Option', sections: [{ title: 'Options', rows: buttons.slice(0, 10).map(b => ({ id: b.id, title: b.title.substring(0, 24), description: '' })) }] }
        }
      }, { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } });
      return r.data;
    }
  } catch (err) {
    console.error('Send interactive error:', err.response?.data || err.message);
    return await sendTextMessage(phone, bodyText);
  }
}

async function sendTemplate(phone, templateName, variables) {
  if (!WA_API || !WA_TOKEN) return { success: false, error: 'WhatsApp not configured' };
  try {
    const components = variables?.length > 0 ? [{ type: 'body', parameters: variables.map(v => ({ type: 'text', text: String(v) })) }] : [];
    const r = await axios.post(WA_API, {
      messaging_product: 'whatsapp', to: phone, type: 'template',
      template: { name: templateName, language: { code: 'en' }, components }
    }, { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } });
    return { success: true, data: r.data };
  } catch (err) {
    return { success: false, error: err.response?.data?.error?.message || err.message };
  }
}

async function sendMediaMessage(phone, mediaType, mediaUrl, caption = '') {
  if (!WA_API || !WA_TOKEN) return { success: false, error: 'WhatsApp not configured' };
  try {
    const waType = { image: 'image', video: 'video', audio: 'audio', document: 'document' }[mediaType] || 'document';
    const mediaObj = { link: mediaUrl };
    if (caption && ['image', 'video', 'document'].includes(waType)) mediaObj.caption = caption;
    const r = await axios.post(WA_API, {
      messaging_product: 'whatsapp', to: phone, type: waType, [waType]: mediaObj
    }, { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } });
    return { success: true, data: r.data };
  } catch (err) {
    return { success: false, error: err.response?.data?.error?.message || err.message };
  }
}

// Upload a local file directly to WhatsApp's Media API — returns a media_id (no public URL needed)
async function uploadMediaToWhatsApp(filePath, mimeType) {
  if (!WA_TOKEN || !PHONE_ID) return { success: false, error: 'WhatsApp not configured' };
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([fileBuffer], { type: mimeType }), 'upload');
    const uploadRes = await fetch(`https://graph.facebook.com/v18.0/${PHONE_ID}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
      body: form
    });
    const data = await uploadRes.json();
    if (data.id) return { success: true, mediaId: data.id };
    return { success: false, error: data.error?.message || 'Upload to WhatsApp failed' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Send a message using a WhatsApp media_id (from a direct upload) instead of a public link
async function sendMediaByIdMessage(phone, waType, mediaId, caption = '', filename = '') {
  if (!WA_API || !WA_TOKEN) return { success: false, error: 'WhatsApp not configured' };
  try {
    const mediaObj = { id: mediaId };
    if (caption && ['image', 'video', 'document'].includes(waType)) mediaObj.caption = caption;
    if (waType === 'document' && filename) mediaObj.filename = filename;
    const r = await axios.post(WA_API, {
      messaging_product: 'whatsapp', to: phone, type: waType, [waType]: mediaObj
    }, { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } });
    return { success: true, data: r.data };
  } catch (err) {
    return { success: false, error: err.response?.data?.error?.message || err.message };
  }
}

// ── Bot engine ──────────────────────────────────────────────
async function getBotFlow(triggerKey) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const [rows] = await pool.execute('SELECT * FROM bot_flows WHERE trigger_key = ? AND is_active = 1', [triggerKey]);
    if (rows.length > 0) {
      rows[0].buttons = typeof rows[0].buttons === 'string' ? JSON.parse(rows[0].buttons) : rows[0].buttons;
      return rows[0];
    }
  } catch (err) { console.error('Get flow error:', err.message); }
  return null;
}

async function getSession(phone) {
  const pool = getPool();
  if (!pool) return { phone, state: 'idle', data: {}, agent_mode: 0, last_flow: null };
  try {
    const [rows] = await pool.execute('SELECT * FROM bot_sessions WHERE phone = ?', [phone]);
    if (rows.length > 0) {
      rows[0].data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data || '{}') : (rows[0].data || {});
      return rows[0];
    }
    return { phone, state: 'idle', data: {}, agent_mode: 0, last_flow: null };
  } catch { return { phone, state: 'idle', data: {}, agent_mode: 0, last_flow: null }; }
}

async function updateSession(phone, state, data = {}, lastFlow = null) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.execute(`
      INSERT INTO bot_sessions (phone, state, data, last_flow, last_activity) VALUES (?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE state=VALUES(state), data=VALUES(data), last_flow=VALUES(last_flow), last_activity=NOW()
    `, [phone, state, JSON.stringify(data), lastFlow]);
  } catch (err) { console.error('Session update error:', err.message); }
}

async function setAgentMode(phone, agentMode) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.execute(`
      INSERT INTO bot_sessions (phone, agent_mode) VALUES (?, ?)
      ON DUPLICATE KEY UPDATE agent_mode=VALUES(agent_mode)
    `, [phone, agentMode]);
  } catch (err) { console.error('Agent mode error:', err.message); }
}

async function saveMessage(phone, name, direction, content, msgId = null, msgType = 'text', mediaUrl = null) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.execute(`
      INSERT INTO messages (contact_phone, contact_name, direction, content, whatsapp_msg_id, message_type, media_url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [phone, name || phone, direction, content, msgId, msgType, mediaUrl]);
    await pool.execute(`
      INSERT INTO contacts (phone, name, last_message) VALUES (?, ?, NOW())
      ON DUPLICATE KEY UPDATE last_message=NOW(), name=COALESCE(VALUES(name), name)
    `, [phone, name || null]);
    broadcast({ type: 'new_message', phone, name: name || phone, direction, content, msgType, mediaUrl, time: new Date().toISOString() });
  } catch (err) { console.error('Save message error:', err.message); }
}

async function saveLead(data) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.execute(`
      INSERT INTO leads (name, phone, course, level, mode, timing, source) VALUES (?, ?, ?, ?, ?, ?, 'bot')
    `, [data.name, data.phone, data.course, data.level || null, data.mode || null, data.timing || null]);
    broadcast({ type: 'new_lead', data });
  } catch (err) { console.error('Save lead error:', err.message); }
}

// ── Bot message processor ───────────────────────────────────
async function processIncomingMessage(phone, name, msgType, msgContent, msgId, mediaUrl = null) {
  await saveMessage(phone, name, 'inbound', msgContent, msgId, msgType, mediaUrl);
  const session = await getSession(phone);

  if (session.agent_mode) {
    broadcast({ type: 'agent_message', phone, content: msgContent, msgType, mediaUrl });
    return;
  }

  // Registration flow
  if (session.state === 'reg_waiting_name') {
    if (!msgContent.trim()) return;
    await updateSession(phone, 'reg_waiting_phone', { ...session.data, name: msgContent.trim() }, session.last_flow);
    const reply = `Nice to meet you, *${msgContent.trim()}*! 😊\n\n📱 Please enter your *contact number*:`;
    await sendTextMessage(phone, reply);
    await saveMessage(phone, name, 'outbound', reply);
    return;
  }

  if (session.state === 'reg_waiting_phone') {
    await updateSession(phone, 'reg_waiting_course', { ...session.data, altPhone: msgContent }, session.last_flow);
    const courseButtons = [
      { id: 'reg_course_german', title: '🇩🇪 German' },
      { id: 'reg_course_ielts', title: '📝 IELTS' },
      { id: 'reg_course_pte', title: '💻 PTE' },
      { id: 'reg_course_spoken', title: '🎤 Spoken English' },
      { id: 'reg_course_abroad', title: '✈️ Study Abroad' }
    ];
    const reply = '📚 *Which course would you like to join?*';
    await sendInteractiveButtons(phone, reply, courseButtons);
    await saveMessage(phone, name, 'outbound', reply + ' [course buttons]');
    return;
  }

  if (session.state === 'reg_waiting_course') {
    const courseMap = { 'reg_course_german': 'German', 'reg_course_ielts': 'IELTS', 'reg_course_pte': 'PTE', 'reg_course_spoken': 'Spoken English', 'reg_course_abroad': 'Study Abroad' };
    if (msgType === 'interactive' && !courseMap[msgContent]) {
      const courseButtons = [
        { id: 'reg_course_german', title: '🇩🇪 German' },
        { id: 'reg_course_ielts', title: '📝 IELTS' },
        { id: 'reg_course_pte', title: '💻 PTE' },
        { id: 'reg_course_spoken', title: '🎤 Spoken English' },
        { id: 'reg_course_abroad', title: '✈️ Study Abroad' }
      ];
      await sendInteractiveButtons(phone, '📚 Please select your *course*:', courseButtons);
      return;
    }
    const courseName = courseMap[msgContent] || msgContent;
    await updateSession(phone, 'reg_waiting_mode', { ...session.data, course: courseName }, session.last_flow);
    const modeButtons = [{ id: 'reg_mode_onsite', title: '🏫 Onsite' }, { id: 'reg_mode_online', title: '💻 Online' }];
    const reply = `Great choice! *${courseName}* 🎓\n\nHow would you like to attend?`;
    await sendInteractiveButtons(phone, reply, modeButtons);
    await saveMessage(phone, name, 'outbound', reply);
    return;
  }

  if (session.state === 'reg_waiting_mode') {
    const modeMap = { 'reg_mode_onsite': 'Onsite', 'reg_mode_online': 'Online' };
    if (msgType === 'interactive' && !modeMap[msgContent]) {
      const modeButtons = [{ id: 'reg_mode_onsite', title: '🏫 Onsite' }, { id: 'reg_mode_online', title: '💻 Online' }];
      await sendInteractiveButtons(phone, '🏫 Please select *Onsite* or 💻 *Online*:', modeButtons);
      return;
    }
    const mode = modeMap[msgContent] || msgContent;
    const updatedData = { ...session.data, mode };
    await saveLead({ name: updatedData.name, phone, course: updatedData.course, mode });
    await updateSession(phone, 'idle', {}, null);
    const confirmMsg = `✅ *Registration Complete!*\n\n🎊 Thank you *${updatedData.name}*!\n\n📋 *Your Details:*\n👤 Name: ${updatedData.name}\n📱 Phone: ${phone}\n📚 Course: ${updatedData.course}\n🏫 Mode: ${mode}\n\nOur team will contact you soon!\n\n📞 03142230194 | 03334429257`;
    await sendTextMessage(phone, confirmMsg);
    await saveMessage(phone, name, 'outbound', confirmMsg);
    setTimeout(async () => {
      const flow = await getBotFlow('main_menu');
      if (flow?.buttons?.length > 0) await sendInteractiveButtons(phone, flow.message, flow.buttons);
    }, 2000);
    return;
  }

  // Button / text routing
  let buttonId = null;

  if (msgType === 'interactive') {
    buttonId = msgContent;
    if (session.state && session.state !== 'idle' && session.state.startsWith('reg_')) {
      await updateSession(phone, 'idle', {}, null);
    }
  } else {
    const text = msgContent.toLowerCase().trim();
    if (['hi', 'hello', 'start', 'menu', 'helo', 'hey', 'salam', 'assalam', 'aoa', 'welcome'].includes(text)) {
      buttonId = 'welcome';
    } else if (text === 'stop') {
      await handleOptOut(phone, name);
      return;
    } else {
      buttonId = 'welcome';
    }
  }

  const flow = await getBotFlow(buttonId);
  if (!flow) {
    const reply = "Sorry, I didn't understand that. Type *menu* to see options.";
    await sendTextMessage(phone, reply);
    await saveMessage(phone, name, 'outbound', reply);
    return;
  }

  await updateSession(phone, 'idle', session.data || {}, buttonId);

  if (flow.action === 'agent_handover') {
    await setAgentMode(phone, 1);
    await sendTextMessage(phone, flow.message);
    await saveMessage(phone, name, 'outbound', flow.message);
    broadcast({ type: 'agent_request', phone, name });
    return;
  }

  if (flow.action === 'start_registration') {
    await updateSession(phone, 'reg_waiting_name', { regPhone: phone }, buttonId);
    await sendTextMessage(phone, flow.message);
    await saveMessage(phone, name, 'outbound', flow.message);
    return;
  }

  if (flow.buttons?.length > 0) {
    await sendInteractiveButtons(phone, flow.message, flow.buttons);
  } else {
    await sendTextMessage(phone, flow.message);
  }
  await saveMessage(phone, name, 'outbound', flow.message);
}

// FIX: clear session on opt-out
async function handleOptOut(phone, name) {
  const pool = getPool();
  if (pool) {
    await pool.execute('UPDATE contacts SET status = "opted_out" WHERE phone = ?', [phone]);
    await updateSession(phone, 'idle', {}, null); // clear stale state
  }
  const msg = '✅ You have been unsubscribed. Reply *START* anytime to re-subscribe.';
  await sendTextMessage(phone, msg);
}

// ── Webhook ─────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.status(403).send('Forbidden');
});

app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value;
        if (value.statuses) {
          for (const s of value.statuses) await updateMessageStatus(s.id, s.status);
        }
        if (value.messages) {
          for (const msg of value.messages) {
            const phone = msg.from;
            const msgId = msg.id;
            const contact = value.contacts?.find(c => c.wa_id === phone);
            const name = contact?.profile?.name || phone;
            let content = '', msgType = msg.type, mediaUrl = null;

            if (msg.type === 'text') {
              content = msg.text?.body || '';
            } else if (msg.type === 'interactive') {
              content = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || '';
            } else if (['image', 'video', 'audio', 'document', 'voice'].includes(msg.type)) {
              const mediaObj = msg[msg.type] || {};
              content = `[${msg.type}${mediaObj.caption ? ': ' + mediaObj.caption : ''}]`;
              if (mediaObj.id) {
                try {
                  const mr = await axios.get(`https://graph.facebook.com/v18.0/${mediaObj.id}`, { headers: { Authorization: `Bearer ${WA_TOKEN}` } });
                  mediaUrl = mr.data?.url || null;
                } catch (e) {}
              }
            } else {
              content = `[${msg.type} message]`;
              msgType = 'text';
            }
            await processIncomingMessage(phone, name, msgType, content, msgId, mediaUrl);
          }
        }
      }
    }
  } catch (err) { console.error('Webhook error:', err.message); }
});

async function updateMessageStatus(waId, status) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.execute('UPDATE messages SET status=? WHERE whatsapp_msg_id=?', [status, waId]);
    broadcast({ type: 'message_status', waId, status });
  } catch {}
}

// ── AUTH ─────────────────────────────────────────────────────
app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  const pool = getPool();
  try {
    let user = null;
    if (!pool) {
      if (username === (process.env.ADMIN_USERNAME || 'admin') && password === (process.env.ADMIN_PASSWORD || 'ghazala123')) {
        user = { id: 1, username, role: 'admin', name: 'Admin', email: ADMIN_EMAIL, whatsapp: ADMIN_PHONE, two_fa_enabled: 0, two_fa_method: null };
      }
    } else {
      const [rows] = await pool.execute('SELECT * FROM users WHERE username=? AND is_active=1', [username]);
      if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });
      if (!bcrypt.compareSync(password, rows[0].password)) return res.status(401).json({ error: 'Invalid credentials' });
      user = rows[0];
    }
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.two_fa_enabled) {
      const method = user.two_fa_method || 'otp';
      if (method === 'totp') {
        // TOTP — no OTP to send, user opens their authenticator app
        return res.json({ success: true, requireOTP: true, method: 'totp', message: 'Enter the code from your Authenticator app.' });
      }
      // OTP via WhatsApp / Email
      const otp = generateOTP();
      otpStore.set(username, { otp, expires: Date.now() + 10 * 60 * 1000, userId: user.id, purpose: 'login' });
      let sent = false;
      if (user.whatsapp) sent = await sendOTPWhatsApp(user.whatsapp, otp, 'Login');
      if (!sent && user.email) sent = await sendOTPEmail(user.email, otp, 'Login');
      return res.json({ success: true, requireOTP: true, method: 'otp', message: 'OTP sent to your WhatsApp / Email.' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { username: user.username, role: user.role, name: user.name } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/verify-otp', otpLimiter, async (req, res) => {
  const { username, otp, method } = req.body;
  const pool = getPool();
  try {
    let user = null;
    if (!pool) {
      user = { id: 1, username, role: 'admin', name: 'Admin' };
    } else {
      const [rows] = await pool.execute('SELECT * FROM users WHERE username=?', [username]);
      user = rows[0];
    }
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (method === 'totp') {
      if (!user.totp_secret) return res.status(400).json({ error: 'TOTP not configured for this account.' });
      const verified = speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: otp, window: 2 });
      if (!verified) return res.status(400).json({ error: 'Invalid authenticator code.' });
    } else {
      const stored = otpStore.get(username);
      if (!stored) return res.status(400).json({ error: 'OTP not found or expired. Please login again.' });
      if (Date.now() > stored.expires) { otpStore.delete(username); return res.status(400).json({ error: 'OTP expired. Please login again.' }); }
      if (stored.otp !== otp) return res.status(400).json({ error: 'Invalid OTP' });
      otpStore.delete(username);
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, user: { username: user.username, role: user.role, name: user.name } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/forgot-password', authLimiter, async (req, res) => {
  const { username } = req.body;
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'Database not available' });
  try {
    const [rows] = await pool.execute('SELECT * FROM users WHERE username=? AND is_active=1', [username]);
    if (rows.length === 0) return res.status(404).json({ error: 'Username not found' });
    const user = rows[0];
    const otp = generateOTP();
    otpStore.set('reset_' + username, { otp, expires: Date.now() + 10 * 60 * 1000, userId: user.id });
    let sent = false;
    if (user.whatsapp) sent = await sendOTPWhatsApp(user.whatsapp, otp, 'Password Reset');
    if (!sent && user.email) sent = await sendOTPEmail(user.email, otp, 'Password Reset');
    if (!sent) return res.status(500).json({ error: 'Could not send OTP. No email/WhatsApp set for this user.' });
    res.json({ success: true, message: 'OTP sent to your registered email/WhatsApp.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reset-password', otpLimiter, async (req, res) => {
  const { username, otp, newPassword } = req.body;
  const pool = getPool();
  const stored = otpStore.get('reset_' + username);
  if (!stored) return res.status(400).json({ error: 'OTP not found or expired.' });
  if (Date.now() > stored.expires) { otpStore.delete('reset_' + username); return res.status(400).json({ error: 'OTP expired.' }); }
  if (stored.otp !== otp) return res.status(400).json({ error: 'Invalid OTP' });
  otpStore.delete('reset_' + username);
  try {
    const hashed = bcrypt.hashSync(newPassword, 10);
    await pool.execute('UPDATE users SET password=? WHERE id=?', [hashed, stored.userId]);
    res.json({ success: true, message: 'Password reset successfully.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send OTP for 2FA setup (WhatsApp or Email)
app.post('/api/send-otp', authMiddleware, otpLimiter, async (req, res) => {
  const { type } = req.body;
  const pool = getPool();
  try {
    const [rows] = await pool.execute('SELECT * FROM users WHERE id=?', [req.user.id]);
    const user = rows[0];
    const otp = generateOTP();
    otpStore.set('2fa_' + req.user.username, { otp, expires: Date.now() + 10 * 60 * 1000, purpose: '2fa' });
    let sent = false;
    if (type === 'whatsapp' && user.whatsapp) sent = await sendOTPWhatsApp(user.whatsapp, otp, '2FA Setup');
    if (type === 'email' && user.email) sent = await sendOTPEmail(user.email, otp, '2FA Setup');
    if (!sent) return res.status(400).json({ error: 'Could not send OTP. Check your email/WhatsApp is set in profile.' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// TOTP Setup — generate secret + QR code
app.post('/api/setup-totp', authMiddleware, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute('SELECT username FROM users WHERE id=?', [req.user.id]);
    const username = rows[0]?.username || req.user.username;
    const secret = speakeasy.generateSecret({
      name: `Ghazala CRM (${username})`,
      issuer: 'Ghazala Institute',
      length: 20
    });
    otpStore.set('totp_setup_' + req.user.username, {
      secret: secret.base32,
      expires: Date.now() + 15 * 60 * 1000
    });
    const qrCode = await QRCode.toDataURL(secret.otpauth_url);
    res.json({ success: true, secret: secret.base32, qrCode, otpauthUrl: secret.otpauth_url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Profile ─────────────────────────────────────────────────
app.get('/api/profile', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json({});
  try {
    const [rows] = await pool.execute(
      'SELECT id, username, name, role, email, whatsapp, about, address, profile_pic, social_links, business_hours, two_fa_enabled, two_fa_method FROM users WHERE id=?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const u = rows[0];
    if (u.social_links) try { u.social_links = JSON.parse(u.social_links); } catch { u.social_links = {}; }
    if (u.business_hours) try { u.business_hours = JSON.parse(u.business_hours); } catch { u.business_hours = {}; }
    res.json(u);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/profile', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  const { name, email, whatsapp, about, address, profile_pic, social_links, business_hours } = req.body;
  try {
    await pool.execute(
      'UPDATE users SET name=?,email=?,whatsapp=?,about=?,address=?,profile_pic=?,social_links=?,business_hours=? WHERE id=?',
      [name, email, whatsapp, about, address, profile_pic, JSON.stringify(social_links || {}), JSON.stringify(business_hours || {}), req.user.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/profile/password', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password too short (min 6 chars)' });
  try {
    const [rows] = await pool.execute('SELECT password FROM users WHERE id=?', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (!bcrypt.compareSync(currentPassword, rows[0].password)) return res.status(401).json({ error: 'Current password incorrect' });
    await pool.execute('UPDATE users SET password=? WHERE id=?', [bcrypt.hashSync(newPassword, 10), req.user.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/profile/2fa', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  const { enabled, otp, method } = req.body;

  if (enabled) {
    if (method === 'totp') {
      const stored = otpStore.get('totp_setup_' + req.user.username);
      if (!stored || Date.now() > stored.expires) return res.status(400).json({ error: 'TOTP setup expired. Please restart.' });
      const verified = speakeasy.totp.verify({ secret: stored.secret, encoding: 'base32', token: otp, window: 2 });
      if (!verified) return res.status(400).json({ error: 'Invalid code. Check your authenticator app.' });
      otpStore.delete('totp_setup_' + req.user.username);
      await pool.execute('UPDATE users SET two_fa_enabled=1, two_fa_method="totp", totp_secret=? WHERE id=?', [stored.secret, req.user.id]);
      return res.json({ success: true });
    }
    // OTP method (WhatsApp or Email)
    const stored = otpStore.get('2fa_' + req.user.username);
    if (!stored || stored.otp !== otp || Date.now() > stored.expires) {
      return res.status(400).json({ error: 'Invalid or expired OTP. Please request a new one.' });
    }
    otpStore.delete('2fa_' + req.user.username);
    await pool.execute('UPDATE users SET two_fa_enabled=1, two_fa_method="otp", totp_secret=NULL WHERE id=?', [req.user.id]);
    return res.json({ success: true });
  }

  await pool.execute('UPDATE users SET two_fa_enabled=0, two_fa_method=NULL WHERE id=?', [req.user.id]);
  res.json({ success: true });
});

// ── Stats ───────────────────────────────────────────────────
app.get('/api/stats', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json({ messages: 0, contacts: 0, leads: 0, broadcasts: 0, todayMessages: 0, todayLeads: 0 });
  try {
    const [[m]] = await pool.execute('SELECT COUNT(*) as c FROM messages');
    const [[co]] = await pool.execute('SELECT COUNT(*) as c FROM contacts WHERE status="active"');
    const [[l]] = await pool.execute('SELECT COUNT(*) as c FROM leads');
    const [[b]] = await pool.execute('SELECT COUNT(*) as c FROM broadcasts');
    const [[tm]] = await pool.execute('SELECT COUNT(*) as c FROM messages WHERE DATE(created_at)=CURDATE()');
    const [[tl]] = await pool.execute('SELECT COUNT(*) as c FROM leads WHERE DATE(created_at)=CURDATE()');
    res.json({ messages: m.c, contacts: co.c, leads: l.c, broadcasts: b.c, todayMessages: tm.c, todayLeads: tl.c });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Contacts ────────────────────────────────────────────────
app.get('/api/contacts', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json({ contacts: [], total: 0 });
  try {
    const { search, segment, status, mode, from, to, page = 1, limit = 50 } = req.query;
    let q = 'SELECT * FROM contacts WHERE 1=1', p = [];
    if (search) { q += ' AND (name LIKE ? OR phone LIKE ?)'; p.push(`%${search}%`, `%${search}%`); }
    if (segment) { q += ' AND segment=?'; p.push(segment); }
    if (status) { q += ' AND status=?'; p.push(status); }
    if (mode) { q += ' AND mode=?'; p.push(mode); }
    if (from) { q += ' AND DATE(created_at)>=?'; p.push(from); }
    if (to) { q += ' AND DATE(created_at)<=?'; p.push(to); }
    const countQ = q.replace('SELECT *', 'SELECT COUNT(*) as total');
    const [[{ total }]] = await pool.execute(countQ, p);

    // mysql2 prepared statements (execute) can misbehave with LIMIT/OFFSET as bound params —
    // validate as safe integers and inline directly instead of using ? placeholders
    const safeLimit = Math.max(1, Math.min(1000, parseInt(limit) || 50));
    const safeOffset = Math.max(0, (parseInt(page) || 1) - 1) * safeLimit;
    q += ` ORDER BY id DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`;
    const [rows] = await pool.execute(q, p);
    res.json({ contacts: rows, total });
  } catch (err) {
    console.error('GET /api/contacts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'Database not connected' });
  const { name, segment, mode } = req.body;
  const phone = (req.body.phone || '').toString().trim().replace(/[^\d]/g, '');
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  try {
    const [existing] = await pool.execute('SELECT id FROM contacts WHERE phone=?', [phone]);
    if (existing.length > 0) {
      await pool.execute('UPDATE contacts SET name=COALESCE(?,name), segment=?, mode=COALESCE(?,mode), last_message=NOW() WHERE phone=?', [name || null, segment || 'General', mode || null, phone]);
    } else {
      await pool.execute('INSERT INTO contacts (name, phone, segment, mode, status, last_message) VALUES (?,?,?,?,"active",NOW())', [name || null, phone, segment || 'General', mode || null]);
    }
    console.log(`Contact saved: ${phone} (${name || 'no name'})`);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/contacts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/contacts/:id', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'Database not connected' });
  const { name, segment, status, mode } = req.body;
  const phone = (req.body.phone || '').toString().trim().replace(/[^\d]/g, '');
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  try {
    await pool.execute(
      'UPDATE contacts SET name=?, phone=?, segment=?, status=?, mode=? WHERE id=?',
      [name || null, phone, segment || 'General', status || 'active', mode || null, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/contacts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/contacts/:id/segment', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'Database not connected' });
  const { segment } = req.body;
  try {
    await pool.execute('UPDATE contacts SET segment=? WHERE id=?', [segment || 'General', req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/contacts/:id/segment error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/contacts/:id/mode', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'Database not connected' });
  const { mode } = req.body;
  try {
    await pool.execute('UPDATE contacts SET mode=? WHERE id=?', [mode || null, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/contacts/:id/mode error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contacts/import', authMiddleware, upload.single('file'), async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const results = [];
  fs.createReadStream(req.file.path).pipe(csv()).on('data', d => results.push(d)).on('end', async () => {
    let imported = 0, failed = 0;
    for (const row of results) {
      const rawPhone = (row.phone || row.Phone || row.number || row.Number || row.mobile || row.Mobile || '').toString();
      const phone = rawPhone.trim().replace(/[^\d]/g, '');
      const name = row.name || row.Name || null;
      const segment = row.segment || row.Segment || 'Imported';
      const mode = row.mode || row.Mode || null;
      if (phone) {
        try {
          const [existing] = await pool.execute('SELECT id FROM contacts WHERE phone=?', [phone]);
          if (existing.length > 0) {
            await pool.execute('UPDATE contacts SET name=COALESCE(?,name), segment=?, mode=COALESCE(?,mode) WHERE phone=?', [name, segment, mode, phone]);
          } else {
            await pool.execute('INSERT INTO contacts (name, phone, segment, mode, status, last_message) VALUES (?,?,?,?,"active",NOW())', [name, phone, segment, mode]);
          }
          imported++;
        } catch (err) { console.error('Import row error:', err.message); failed++; }
      } else { failed++; }
    }
    fs.unlink(req.file.path, () => {});
    res.json({ success: true, imported, failed });
  });
});

app.get('/api/contacts/segment/:seg', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const seg = req.params.seg;
    if (seg === 'new_leads') {
      const [leads] = await pool.execute('SELECT phone, name FROM leads WHERE status="new"');
      return res.json(leads);
    }
    let q = 'SELECT * FROM contacts WHERE status="active"', p = [];
    if (seg !== 'all') { q += ' AND segment=?'; p.push(seg); }
    const [rows] = await pool.execute(q, p);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/contacts/:id', authMiddleware, adminOnly, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  try {
    await pool.execute('DELETE FROM contacts WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Chat ────────────────────────────────────────────────────
app.get('/api/chats', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const [rows] = await pool.execute(`
      SELECT c.*,
        (SELECT content FROM messages WHERE contact_phone=c.phone ORDER BY created_at DESC LIMIT 1) as last_msg,
        (SELECT message_type FROM messages WHERE contact_phone=c.phone ORDER BY created_at DESC LIMIT 1) as last_msg_type,
        (SELECT created_at FROM messages WHERE contact_phone=c.phone ORDER BY created_at DESC LIMIT 1) as last_msg_time,
        (SELECT COUNT(*) FROM messages WHERE contact_phone=c.phone AND direction='inbound'
          AND created_at > COALESCE(c.last_read_at, '2000-01-01')) as unread,
        (SELECT agent_mode FROM bot_sessions WHERE phone=c.phone) as agent_mode
      FROM contacts c WHERE c.status='active'
      ORDER BY last_msg_time DESC LIMIT 100
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chats/:phone', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const [rows] = await pool.execute('SELECT * FROM messages WHERE contact_phone=? ORDER BY created_at ASC LIMIT 300', [req.params.phone]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark messages as read when chat is opened
app.post('/api/chats/:phone/read', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json({ success: true });
  try {
    await pool.execute('UPDATE contacts SET last_read_at=NOW() WHERE phone=?', [req.params.phone]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/chats/:phone/send', authMiddleware, async (req, res) => {
  const { message, mediaUrl, mediaType } = req.body;
  const phone = req.params.phone;
  try {
    let result;
    if (mediaUrl && mediaType) {
      result = await sendMediaMessage(phone, mediaType, mediaUrl, message);
      await saveMessage(phone, null, 'outbound', message || `[${mediaType}]`, null, mediaType, mediaUrl);
    } else {
      result = await sendTextMessage(phone, message);
      await saveMessage(phone, null, 'outbound', message);
    }
    res.json({ success: true, result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Direct file upload from agent's device — no public URL needed.
// Uploads the file straight to WhatsApp's Media API and sends it by media_id.
app.post('/api/chats/:phone/send-media-file', authMiddleware, upload.single('file'), async (req, res) => {
  const phone = req.params.phone;
  const caption = req.body.caption || '';
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const mimeType = req.file.mimetype || 'application/octet-stream';
    const originalName = req.file.originalname || 'file';

    let waType = 'document';
    if (mimeType.startsWith('image/')) waType = 'image';
    else if (mimeType.startsWith('video/')) waType = 'video';
    else if (mimeType.startsWith('audio/')) waType = 'audio';

    const upload = await uploadMediaToWhatsApp(req.file.path, mimeType);
    fs.unlink(req.file.path, () => {});

    if (!upload.success) return res.status(500).json({ error: upload.error || 'Failed to upload to WhatsApp' });

    const result = await sendMediaByIdMessage(phone, waType, upload.mediaId, caption, originalName);
    if (!result.success) return res.status(500).json({ error: result.error || 'Failed to send media' });

    await saveMessage(phone, null, 'outbound', caption || `[${waType}: ${originalName}]`, null, waType, null);
    res.json({ success: true });
  } catch (err) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    console.error('send-media-file error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chats/:phone/agent', authMiddleware, async (req, res) => {
  const { agentMode } = req.body;
  const phone = req.params.phone;
  try {
    await setAgentMode(phone, agentMode ? 1 : 0);
    if (!agentMode) {
      const flow = await getBotFlow('welcome');
      if (flow?.buttons?.length > 0) { await sendInteractiveButtons(phone, flow.message, flow.buttons); await saveMessage(phone, null, 'outbound', flow.message); }
    } else {
      const msg = '🤝 An agent has joined the chat. How can we help you?';
      await sendTextMessage(phone, msg); await saveMessage(phone, null, 'outbound', msg);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Broadcast ────────────────────────────────────────────────
app.post('/api/broadcast', authMiddleware, async (req, res) => {
  const pool = getPool();
  const { name, templateName, variables, segment, phones } = req.body;
  let contactList = [];
  if (phones?.length > 0) {
    contactList = phones.map(p => ({ phone: p.phone || p, name: p.name || '' }));
  } else if (pool) {
    if (segment === 'new_leads') {
      const [leads] = await pool.execute('SELECT phone, name FROM leads WHERE status="new"');
      contactList = leads;
    } else {
      let q = 'SELECT phone, name FROM contacts WHERE status="active"', p = [];
      if (segment && segment !== 'all') { q += ' AND segment=?'; p.push(segment); }
      const [rows] = await pool.execute(q, p);
      contactList = rows;
    }
  }
  if (!contactList.length) return res.status(400).json({ error: 'No contacts found' });

  let broadcastId = null;
  if (pool) {
    const [r] = await pool.execute(
      'INSERT INTO broadcasts (name, template_name, template_variables, segment, total_contacts, status) VALUES (?,?,?,?,?,"sending")',
      [name, templateName, JSON.stringify(variables), segment || 'all', contactList.length]
    );
    broadcastId = r.insertId;
  }
  res.json({ success: true, broadcastId, totalContacts: contactList.length });

  // FIX: Broadcast IIFE now has try/catch — can't get stuck at "sending"
  (async () => {
    let sent = 0, failed = 0;
    try {
      for (const contact of contactList) {
        const finalVars = contact.perVars?.length > 0
        ? contact.perVars.map((v, i) => v || variables[i] || '')
        : variables.map((v, i) => (i === 0 && (!v || v === '{{name}}')) ? (contact.name || 'Student') : (v || ''));
        const result = await sendTemplate(contact.phone, templateName, finalVars);
        if (result.success) {
          sent++;
          if (pool) {
            await pool.execute('INSERT INTO broadcast_logs (broadcast_id, phone, name, status) VALUES (?,?,?,"sent")', [broadcastId, contact.phone, contact.name]);
            await saveMessage(contact.phone, contact.name, 'outbound', `[Template: ${templateName}]`);
          }
        } else {
          failed++;
          if (pool) await pool.execute('INSERT INTO broadcast_logs (broadcast_id, phone, name, status, error_msg) VALUES (?,?,?,"failed",?)', [broadcastId, contact.phone, contact.name, result.error]);
        }
        if (pool && broadcastId) await pool.execute('UPDATE broadcasts SET sent=?, failed=? WHERE id=?', [sent, failed, broadcastId]);
        broadcast({ type: 'broadcast_progress', broadcastId, sent, failed, total: contactList.length });
        await new Promise(r => setTimeout(r, 150));
      }
      if (pool && broadcastId) await pool.execute('UPDATE broadcasts SET status="completed", completed_at=NOW() WHERE id=?', [broadcastId]);
      broadcast({ type: 'broadcast_complete', broadcastId, sent, failed });
    } catch (err) {
      console.error('Broadcast error:', err.message);
      if (pool && broadcastId) await pool.execute('UPDATE broadcasts SET status="failed" WHERE id=?', [broadcastId]);
      broadcast({ type: 'broadcast_complete', broadcastId, sent, failed, error: err.message });
    }
  })();
});

app.post('/api/broadcasts/:id/resend-failed', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  try {
    const [[b]] = await pool.execute('SELECT * FROM broadcasts WHERE id=?', [req.params.id]);
    if (!b) return res.status(404).json({ error: 'Not found' });
    const [failedLogs] = await pool.execute('SELECT * FROM broadcast_logs WHERE broadcast_id=? AND status="failed"', [req.params.id]);
    if (!failedLogs.length) return res.json({ success: true, message: 'No failed messages' });
    const variables = JSON.parse(b.template_variables || '[]');
    res.json({ success: true, message: `Resending to ${failedLogs.length} contacts` });
    (async () => {
      for (const log of failedLogs) {
        const finalVars = log.perVars?.length > 0
          ? log.perVars.map((v, i) => v || variables[i] || '')
          : variables.map((v, i) => i === 0 ? (log.name || 'Student') : v);
        const result = await sendTemplate(log.phone, b.template_name, finalVars);
        await pool.execute('UPDATE broadcast_logs SET status=?, error_msg=? WHERE id=?', [result.success ? 'sent' : 'failed', result.success ? null : result.error, log.id]);
        await new Promise(r => setTimeout(r, 150));
      }
      await pool.execute('UPDATE broadcasts SET sent=(SELECT COUNT(*) FROM broadcast_logs WHERE broadcast_id=? AND status="sent"), failed=(SELECT COUNT(*) FROM broadcast_logs WHERE broadcast_id=? AND status="failed") WHERE id=?', [b.id, b.id, b.id]);
    })();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/broadcasts', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try { const [rows] = await pool.execute('SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 50'); res.json(rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/broadcasts/:id', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json({});
  try {
    const [rows] = await pool.execute('SELECT * FROM broadcasts WHERE id=?', [req.params.id]);
    const [logs] = await pool.execute('SELECT * FROM broadcast_logs WHERE broadcast_id=? ORDER BY created_at DESC', [req.params.id]);
    res.json({ ...(rows[0] || {}), logs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/broadcasts/:id/progress', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json({});
  try { const [rows] = await pool.execute('SELECT * FROM broadcasts WHERE id=?', [req.params.id]); res.json(rows[0] || {}); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Templates ────────────────────────────────────────────────
app.get('/api/templates', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const [rows] = await pool.execute('SELECT * FROM templates WHERE is_active=1');
    rows.forEach(r => { try { r.variables = typeof r.variables === 'string' ? JSON.parse(r.variables) : r.variables; } catch { r.variables = []; } });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/templates', authMiddleware, adminOnly, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  const { name, template_name, category, variables, body } = req.body;
  try {
    await pool.execute('INSERT INTO templates (name, template_name, category, variables, body) VALUES (?,?,?,?,?)', [name, template_name, category, JSON.stringify(variables), body]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/templates/:id', authMiddleware, adminOnly, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  const { name, template_name, category, variables, body } = req.body;
  try {
    await pool.execute('UPDATE templates SET name=?,template_name=?,category=?,variables=?,body=? WHERE id=?', [name, template_name, category, JSON.stringify(variables), body, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/templates/:id', authMiddleware, adminOnly, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  try { await pool.execute('UPDATE templates SET is_active=0 WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Bot flows ────────────────────────────────────────────────
app.get('/api/bot-flows', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const [rows] = await pool.execute('SELECT * FROM bot_flows ORDER BY id ASC');
    rows.forEach(r => { try { r.buttons = typeof r.buttons === 'string' ? JSON.parse(r.buttons) : r.buttons; } catch { r.buttons = []; } });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/bot-flows/:id', authMiddleware, adminOnly, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  const { message, buttons, is_active } = req.body;
  try {
    await pool.execute('UPDATE bot_flows SET message=?, buttons=?, is_active=? WHERE id=?', [message, JSON.stringify(buttons), is_active ? 1 : 0, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bot-flows', authMiddleware, adminOnly, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  const { trigger_key, message, buttons, action } = req.body;
  try {
    await pool.execute('INSERT INTO bot_flows (trigger_key, message, buttons, action) VALUES (?,?,?,?)', [trigger_key, message, JSON.stringify(buttons), action]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/bot-flows/:id', authMiddleware, adminOnly, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  try { await pool.execute('DELETE FROM bot_flows WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Leads ────────────────────────────────────────────────────
app.get('/api/leads', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const { course, mode, status, from, to, search } = req.query;
    let q = 'SELECT * FROM leads WHERE 1=1', p = [];
    if (course) { q += ' AND course=?'; p.push(course); }
    if (mode) { q += ' AND mode=?'; p.push(mode); }
    if (status) { q += ' AND status=?'; p.push(status); }
    if (from) { q += ' AND DATE(created_at)>=?'; p.push(from); }
    if (to) { q += ' AND DATE(created_at)<=?'; p.push(to); }
    if (search) { q += ' AND (name LIKE ? OR phone LIKE ?)'; p.push(`%${search}%`, `%${search}%`); }
    q += ' ORDER BY created_at DESC LIMIT 200';
    const [rows] = await pool.execute(q, p);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/leads/:id', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  const { status, notes } = req.body;
  try { await pool.execute('UPDATE leads SET status=?, notes=? WHERE id=?', [status, notes, req.params.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Settings ─────────────────────────────────────────────────
app.get('/api/settings', authMiddleware, (req, res) => {
  res.json({
    phoneNumberId: PHONE_ID ? '••••' + PHONE_ID.slice(-4) : 'Not set',
    tokenSet: !!WA_TOKEN,
    verifyToken: VERIFY_TOKEN,
    webhookUrl: `${req.protocol}://${req.get('host')}/webhook`,
    waConfigured: !!(WA_TOKEN && PHONE_ID)
  });
});

// ── Users ────────────────────────────────────────────────────
app.get('/api/users', authMiddleware, adminOnly, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try { const [rows] = await pool.execute('SELECT id, username, name, role, email, whatsapp, is_active, two_fa_enabled, two_fa_method, created_at FROM users'); res.json(rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', authMiddleware, adminOnly, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  const { username, password, name, role, email, whatsapp } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const hashed = bcrypt.hashSync(password, 10);
    await pool.execute('INSERT INTO users (username, password, name, role, email, whatsapp) VALUES (?,?,?,?,?,?)', [username, hashed, name, role || 'agent', email || null, whatsapp || null]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/users/:id', authMiddleware, adminOnly, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  const { name, role, is_active, password, email, whatsapp } = req.body;
  try {
    if (password) {
      await pool.execute('UPDATE users SET name=?,role=?,is_active=?,password=?,email=?,whatsapp=? WHERE id=?', [name, role, is_active, bcrypt.hashSync(password, 10), email, whatsapp, req.params.id]);
    } else {
      await pool.execute('UPDATE users SET name=?,role=?,is_active=?,email=?,whatsapp=? WHERE id=?', [name, role, is_active, email, whatsapp, req.params.id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Health ───────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const pool = getPool();
  const result = {
    status: 'ok',
    buildVersion: '2026-06-22-media-upload-v4',
    time: new Date().toISOString(),
    db: !!pool,
    dbHost: process.env.DB_HOST || 'not set',
    dbName: process.env.DB_NAME || 'ghazala_whatsapp (default)',
    whatsapp: !!(WA_TOKEN && PHONE_ID)
  };
  if (pool) {
    try {
      const [[{ cnt }]] = await pool.execute('SELECT COUNT(*) as cnt FROM contacts');
      const [recent] = await pool.execute('SELECT id, name, phone, created_at FROM contacts ORDER BY id DESC LIMIT 5');
      result.contactsCount = cnt;
      result.recentContacts = recent;
    } catch (err) {
      result.dbError = err.message;
    }
  }
  res.json(result);
});

// Serve frontend
const INDEX_PATH = path.join(__dirname, 'index.html');

app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) return;
  res.sendFile(INDEX_PATH, err => {
    if (err) {
      res.status(503).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Ghazala CRM</title>
<style>body{font-family:sans-serif;background:#0a1a0a;color:#25D366;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px;}
p{color:#888;font-size:14px;max-width:400px;text-align:center;line-height:1.6;}code{background:#1a2a1a;padding:3px 8px;border-radius:4px;font-size:12px;color:#aaa;}</style>
</head><body>
<h2>⚠️ index.html not found</h2>
<p>The dashboard file is missing from the deployment.<br>Make sure <code>index.html</code> is in the same folder as <code>server.js</code> and is committed to git.</p>
<p style="color:#555">Looking for: <code>${INDEX_PATH}</code></p>
</body></html>`);
    }
  });
});

app.use((err, req, res, next) => {
  console.error('Global error:', err.message);
  res.status(500).json({ error: 'Server error', message: err.message });
});

async function start() {
  await initDB();
  server.listen(PORT, () => {
    console.log(`🚀 Ghazala WhatsApp System running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔗 Webhook:   http://localhost:${PORT}/webhook`);
    if (!WA_TOKEN || !PHONE_ID) console.warn('⚠️  WhatsApp API not configured — messaging disabled until env vars are set');
  });
}

start();
