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
require('dotenv').config();

const { initDB, getPool } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
// File upload config
const upload = multer({ dest: 'uploads/' });

// WhatsApp API Config
const WA_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'ghazala2024';
const WA_API = `https://graph.facebook.com/v18.0/${PHONE_ID}/messages`;

// ==================== AUTH MIDDLEWARE ====================
function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'ghazala_secret');
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ==================== WHATSAPP SEND FUNCTIONS ====================

async function sendTextMessage(phone, text) {
  try {
    const response = await axios.post(WA_API, {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'text',
      text: { body: text, preview_url: false }
    }, {
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }
    });
    return response.data;
  } catch (err) {
    console.error('Send text error:', err.response?.data || err.message);
    return null;
  }
}

async function sendInteractiveButtons(phone, bodyText, buttons) {
  try {
    // WhatsApp max 3 buttons per message, handle overflow with list
    if (buttons.length <= 3) {
      const response = await axios.post(WA_API, {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: bodyText },
          action: {
            buttons: buttons.map(b => ({
              type: 'reply',
              reply: { id: b.id, title: b.title.substring(0, 20) }
            }))
          }
        }
      }, {
        headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }
      });
      return response.data;
    } else {
      // Use list message for more than 3 options
      const rows = buttons.map(b => ({
        id: b.id,
        title: b.title.substring(0, 24),
        description: ''
      }));

      const response = await axios.post(WA_API, {
        messaging_product: 'whatsapp',
        to: phone,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: bodyText },
          action: {
            button: 'Choose Option',
            sections: [{
              title: 'Options',
              rows: rows.slice(0, 10)
            }]
          }
        }
      }, {
        headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }
      });
      return response.data;
    }
  } catch (err) {
    console.error('Send interactive error:', err.response?.data || err.message);
    // Fallback to text
    return await sendTextMessage(phone, bodyText);
  }
}

async function sendTemplate(phone, templateName, variables) {
  try {
    const components = variables && variables.length > 0 ? [{
      type: 'body',
      parameters: variables.map(v => ({ type: 'text', text: String(v) }))
    }] : [];

    const response = await axios.post(WA_API, {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'en' },
        components
      }
    }, {
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }
    });
    return { success: true, data: response.data };
  } catch (err) {
    return { success: false, error: err.response?.data?.error?.message || err.message };
  }
}

// ==================== BOT ENGINE ====================

async function getBotFlow(triggerKey) {
  const pool = getPool();
  if (!pool) return getDefaultFlow(triggerKey);
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM bot_flows WHERE trigger_key = ? AND is_active = 1', [triggerKey]
    );
    if (rows.length > 0) {
      rows[0].buttons = typeof rows[0].buttons === 'string' ? JSON.parse(rows[0].buttons) : rows[0].buttons;
      return rows[0];
    }
  } catch (err) {
    console.error('Get flow error:', err.message);
  }
  return null;
}

async function getSession(phone) {
  const pool = getPool();
  if (!pool) return { phone, state: 'idle', data: {}, agent_mode: 0 };
  try {
    const [rows] = await pool.execute('SELECT * FROM bot_sessions WHERE phone = ?', [phone]);
    if (rows.length > 0) {
      rows[0].data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data || '{}') : (rows[0].data || {});
      return rows[0];
    }
    return { phone, state: 'idle', data: {}, agent_mode: 0 };
  } catch { return { phone, state: 'idle', data: {}, agent_mode: 0 }; }
}

async function updateSession(phone, state, data = {}) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.execute(`
      INSERT INTO bot_sessions (phone, state, data, last_activity) VALUES (?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE state = VALUES(state), data = VALUES(data), last_activity = NOW()
    `, [phone, state, JSON.stringify(data)]);
  } catch (err) { console.error('Session update error:', err.message); }
}

async function setAgentMode(phone, agentMode) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.execute(`
      INSERT INTO bot_sessions (phone, agent_mode) VALUES (?, ?)
      ON DUPLICATE KEY UPDATE agent_mode = VALUES(agent_mode)
    `, [phone, agentMode]);
  } catch (err) { console.error('Agent mode error:', err.message); }
}

async function saveMessage(phone, name, direction, content, msgId = null) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.execute(`
      INSERT INTO messages (contact_phone, contact_name, direction, content, whatsapp_msg_id)
      VALUES (?, ?, ?, ?, ?)
    `, [phone, name || phone, direction, content, msgId]);

    // Update contact last message time
    await pool.execute(`
      INSERT INTO contacts (phone, name, last_message) VALUES (?, ?, NOW())
      ON DUPLICATE KEY UPDATE last_message = NOW(), name = COALESCE(VALUES(name), name)
    `, [phone, name || null]);
  } catch (err) { console.error('Save message error:', err.message); }
}

async function saveLead(data) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.execute(`
      INSERT INTO leads (name, phone, course, level, mode, timing, source)
      VALUES (?, ?, ?, ?, ?, ?, 'bot')
    `, [data.name, data.phone, data.course, data.level || null, data.mode || null, data.timing || null]);
  } catch (err) { console.error('Save lead error:', err.message); }
}

async function processIncomingMessage(phone, name, msgType, msgContent, msgId) {
  // Save incoming message
  await saveMessage(phone, name, 'inbound', msgContent, msgId);

  // Get session
  const session = await getSession(phone);

  // If agent mode — just save, don't bot respond
  if (session.agent_mode) {
    console.log(`[AGENT MODE] ${phone}: ${msgContent}`);
    return;
  }

  // Registration flow states
  if (session.state === 'reg_waiting_name') {
    await updateSession(phone, 'reg_waiting_phone', { ...session.data, name: msgContent });
    const reply = `Nice to meet you, *${msgContent}*! 😊\n\n📱 Enter your *phone number*:`;
    await sendTextMessage(phone, reply);
    await saveMessage(phone, name, 'outbound', reply);
    return;
  }

  if (session.state === 'reg_waiting_phone') {
    await updateSession(phone, 'reg_waiting_course', { ...session.data, altPhone: msgContent });
    const courseButtons = [
      { id: 'reg_course_german', title: '🇩🇪 German' },
      { id: 'reg_course_ielts', title: '📝 IELTS' },
      { id: 'reg_course_pte', title: '💻 PTE' },
      { id: 'reg_course_spoken', title: '🎤 Spoken English' }
    ];
    const reply = '📚 *Which course?*';
    await sendInteractiveButtons(phone, reply, courseButtons);
    await saveMessage(phone, name, 'outbound', reply + ' [buttons shown]');
    return;
  }

  if (session.state === 'reg_waiting_course') {
    const courseMap = {
      'reg_course_german': 'German',
      'reg_course_ielts': 'IELTS',
      'reg_course_pte': 'PTE',
      'reg_course_spoken': 'Spoken English'
    };
    const courseId = msgContent;
    const courseName = courseMap[courseId] || msgContent;
    const updatedData = { ...session.data, course: courseName };
    await updateSession(phone, 'reg_waiting_mode', updatedData);

    const modeButtons = [
      { id: 'reg_mode_onsite', title: '🏫 Onsite' },
      { id: 'reg_mode_online', title: '💻 Online' }
    ];
    const reply = `Great choice! *${courseName}* 🎓\n\n🏫 Onsite or 💻 Online?`;
    await sendInteractiveButtons(phone, reply, modeButtons);
    await saveMessage(phone, name, 'outbound', reply);
    return;
  }

  if (session.state === 'reg_waiting_mode') {
    const modeMap = { 'reg_mode_onsite': 'Onsite', 'reg_mode_online': 'Online' };
    const mode = modeMap[msgContent] || msgContent;
    const updatedData = { ...session.data, mode };

    // Save lead
    await saveLead({
      name: updatedData.name,
      phone: phone,
      course: updatedData.course,
      mode: mode,
    });

    await updateSession(phone, 'idle', {});
    const confirmMsg = `✅ *Registration Complete!*\n\n🎊 Thank you *${updatedData.name}*!\n\n📋 *Your Details:*\n👤 Name: ${updatedData.name}\n📱 Phone: ${phone}\n📚 Course: ${updatedData.course}\n🏫 Mode: ${mode}\n\nOur team will contact you soon to confirm your batch timing!\n\n📞 03142230194 | 03334429257`;
    await sendTextMessage(phone, confirmMsg);
    await saveMessage(phone, name, 'outbound', confirmMsg);

    // Show main menu after registration
    setTimeout(async () => {
      const flow = await getBotFlow('main_menu');
      if (flow && flow.buttons?.length > 0) {
        await sendInteractiveButtons(phone, flow.message, flow.buttons);
      }
    }, 2000);
    return;
  }

  // Button/List reply handling
  let buttonId = null;
  if (msgType === 'interactive') {
    buttonId = msgContent;
  } else {
    // Text commands
    const text = msgContent.toLowerCase().trim();
    if (text === 'hi' || text === 'hello' || text === 'start' || text === 'menu' || text === 'helo' || text === 'hey') {
      buttonId = 'welcome';
    } else if (text === 'stop') {
      await handleOptOut(phone, name);
      return;
    } else {
      buttonId = 'welcome'; // Default to welcome for unknown text
    }
  }

  // Get bot flow for button
  const flow = await getBotFlow(buttonId);
  if (!flow) {
    const reply = 'Sorry, I didn\'t understand that. Type *menu* to see options.';
    await sendTextMessage(phone, reply);
    await saveMessage(phone, name, 'outbound', reply);
    return;
  }

  // Handle special actions
  if (flow.action === 'agent_handover') {
    await setAgentMode(phone, 1);
    await sendTextMessage(phone, flow.message);
    await saveMessage(phone, name, 'outbound', flow.message);
    return;
  }

  if (flow.action === 'start_registration') {
    await updateSession(phone, 'reg_waiting_name', { regPhone: phone });
    await sendTextMessage(phone, flow.message);
    await saveMessage(phone, name, 'outbound', flow.message);
    return;
  }

  // Send flow message with buttons
  if (flow.buttons && flow.buttons.length > 0) {
    await sendInteractiveButtons(phone, flow.message, flow.buttons);
  } else {
    await sendTextMessage(phone, flow.message);
  }
  await saveMessage(phone, name, 'outbound', flow.message);
}

async function handleOptOut(phone, name) {
  const pool = getPool();
  if (pool) {
    await pool.execute('UPDATE contacts SET status = "opted_out" WHERE phone = ?', [phone]);
  }
  await sendTextMessage(phone, '✅ You have been unsubscribed. Reply *START* anytime to re-subscribe.');
}

// ==================== WEBHOOK ====================

// Verify webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  res.status(403).send('Forbidden');
});

// Receive messages
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK'); // Always respond 200 first

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const value = change.value;

        // Handle message status updates
        if (value.statuses) {
          for (const status of value.statuses) {
            await updateMessageStatus(status.id, status.status);
          }
        }

        // Handle incoming messages
        if (value.messages) {
          for (const msg of value.messages) {
            const phone = msg.from;
            const msgId = msg.id;
            const contact = value.contacts?.find(c => c.wa_id === phone);
            const name = contact?.profile?.name || phone;

            let content = '';
            let msgType = msg.type;

            if (msg.type === 'text') {
              content = msg.text?.body || '';
            } else if (msg.type === 'interactive') {
              if (msg.interactive?.type === 'button_reply') {
                content = msg.interactive.button_reply?.id || '';
              } else if (msg.interactive?.type === 'list_reply') {
                content = msg.interactive.list_reply?.id || '';
              }
            } else {
              content = `[${msg.type} message]`;
              msgType = 'text';
            }

            await processIncomingMessage(phone, name, msgType, content, msgId);
          }
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

async function updateMessageStatus(waId, status) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.execute('UPDATE messages SET status = ? WHERE whatsapp_msg_id = ?', [status, waId]);
  } catch { }
}

// ==================== AUTH ROUTES ====================

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const pool = getPool();

  if (!pool) {
    // Fallback if no DB
    if (username === (process.env.ADMIN_USERNAME || 'admin') &&
      password === (process.env.ADMIN_PASSWORD || 'ghazala123')) {
      const token = jwt.sign({ id: 1, username, role: 'admin' }, process.env.JWT_SECRET || 'ghazala_secret', { expiresIn: '7d' });
      return res.json({ success: true, token, user: { username, role: 'admin', name: 'Admin' } });
    }
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  try {
    const [rows] = await pool.execute('SELECT * FROM users WHERE username = ? AND is_active = 1', [username]);
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = rows[0];
    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET || 'ghazala_secret', { expiresIn: '7d' });
    res.json({ success: true, token, user: { username: user.username, role: user.role, name: user.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== DASHBOARD STATS ====================

app.get('/api/stats', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json({ messages: 0, contacts: 0, leads: 0, broadcasts: 0 });
  try {
    const [[msgCount]] = await pool.execute('SELECT COUNT(*) as count FROM messages');
    const [[contactCount]] = await pool.execute('SELECT COUNT(*) as count FROM contacts WHERE status = "active"');
    const [[leadCount]] = await pool.execute('SELECT COUNT(*) as count FROM leads');
    const [[broadcastCount]] = await pool.execute('SELECT COUNT(*) as count FROM broadcasts');
    const [[todayMsgs]] = await pool.execute('SELECT COUNT(*) as count FROM messages WHERE DATE(created_at) = CURDATE()');
    const [[newLeads]] = await pool.execute('SELECT COUNT(*) as count FROM leads WHERE DATE(created_at) = CURDATE()');

    res.json({
      messages: msgCount.count,
      contacts: contactCount.count,
      leads: leadCount.count,
      broadcasts: broadcastCount.count,
      todayMessages: todayMsgs.count,
      todayLeads: newLeads.count
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== CONTACTS ====================

app.get('/api/contacts', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const { search, segment, status, page = 1, limit = 50 } = req.query;
    let query = 'SELECT * FROM contacts WHERE 1=1';
    const params = [];
    if (search) { query += ' AND (name LIKE ? OR phone LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    if (segment) { query += ' AND segment = ?'; params.push(segment); }
    if (status) { query += ' AND status = ?'; params.push(status); }
    query += ' ORDER BY last_message DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contacts', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  try {
    const { name, phone, segment } = req.body;
    await pool.execute('INSERT IGNORE INTO contacts (name, phone, segment) VALUES (?, ?, ?)', [name, phone, segment || 'General']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Import contacts from CSV
app.post('/api/contacts/import', authMiddleware, upload.single('file'), async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  if (!req.file) return res.status(400).json({ error: 'No file' });

  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      let imported = 0, failed = 0;
      for (const row of results) {
        const phone = row.phone || row.Phone || row.number || row.Number || row.mobile || row.Mobile;
        const name = row.name || row.Name || '';
        const segment = row.segment || row.Segment || 'Imported';
        if (phone) {
          try {
            await pool.execute('INSERT IGNORE INTO contacts (name, phone, segment) VALUES (?, ?, ?)', [name, phone.toString().trim(), segment]);
            imported++;
          } catch { failed++; }
        }
      }
      fs.unlink(req.file.path, () => { });
      res.json({ success: true, imported, failed });
    });
});

// ==================== CHAT / MESSAGES ====================

app.get('/api/chats', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const [rows] = await pool.execute(`
      SELECT c.*, 
        (SELECT content FROM messages WHERE contact_phone = c.phone ORDER BY created_at DESC LIMIT 1) as last_msg,
        (SELECT created_at FROM messages WHERE contact_phone = c.phone ORDER BY created_at DESC LIMIT 1) as last_msg_time,
        (SELECT COUNT(*) FROM messages WHERE contact_phone = c.phone AND direction = 'inbound' AND created_at > COALESCE(c.last_message, '2000-01-01')) as unread,
        (SELECT agent_mode FROM bot_sessions WHERE phone = c.phone) as agent_mode
      FROM contacts c
      WHERE c.status = 'active'
      ORDER BY last_msg_time DESC
      LIMIT 100
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chats/:phone', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM messages WHERE contact_phone = ? ORDER BY created_at ASC LIMIT 200',
      [req.params.phone]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send message from dashboard
app.post('/api/chats/:phone/send', authMiddleware, async (req, res) => {
  const { message } = req.body;
  const phone = req.params.phone;
  try {
    const result = await sendTextMessage(phone, message);
    await saveMessage(phone, null, 'outbound', message);
    res.json({ success: true, result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Toggle agent mode
app.post('/api/chats/:phone/agent', authMiddleware, async (req, res) => {
  const { agentMode } = req.body;
  const phone = req.params.phone;
  try {
    await setAgentMode(phone, agentMode ? 1 : 0);
    if (!agentMode) {
      // Bot takes over — send welcome
      const flow = await getBotFlow('welcome');
      if (flow && flow.buttons?.length > 0) {
        await sendInteractiveButtons(phone, flow.message, flow.buttons);
        await saveMessage(phone, null, 'outbound', flow.message);
      }
    } else {
      const msg = '🤝 An agent has joined the chat. How can we help you?';
      await sendTextMessage(phone, msg);
      await saveMessage(phone, null, 'outbound', msg);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== BROADCAST ====================

app.post('/api/broadcast', authMiddleware, async (req, res) => {
  const pool = getPool();
  const { name, templateName, variables, segment, phones } = req.body;

  let contactList = [];

  if (phones && phones.length > 0) {
    // Manual phone list
    contactList = phones.map(p => ({ phone: p, name: '' }));
  } else if (pool) {
    // From DB segments
    let query = 'SELECT phone, name FROM contacts WHERE status = "active"';
    const params = [];
    if (segment && segment !== 'all') {
      query += ' AND segment = ?';
      params.push(segment);
    }
    const [rows] = await pool.execute(query, params);
    contactList = rows;
  }

  if (contactList.length === 0) {
    return res.status(400).json({ error: 'No contacts found' });
  }

  // Create broadcast record
  let broadcastId = null;
  if (pool) {
    const [result] = await pool.execute(
      'INSERT INTO broadcasts (name, template_name, template_variables, segment, total_contacts, status) VALUES (?, ?, ?, ?, ?, "sending")',
      [name, templateName, JSON.stringify(variables), segment || 'all', contactList.length]
    );
    broadcastId = result.insertId;
  }

  res.json({ success: true, broadcastId, totalContacts: contactList.length, message: 'Broadcast started' });

  // Send in background with delay to avoid rate limiting
  (async () => {
    let sent = 0, failed = 0;
    for (const contact of contactList) {
      // Replace variables with contact data
      const finalVars = variables.map(v => {
        if (v === '{{name}}' || v === '{name}') return contact.name || 'Student';
        return v;
      });
      // Replace first variable with name if it's a name field
      if (finalVars.length > 0 && (finalVars[0] === '' || finalVars[0] === '{name}')) {
        finalVars[0] = contact.name || 'Student';
      }

      const result = await sendTemplate(contact.phone, templateName, finalVars);

      if (result.success) {
        sent++;
        if (pool) {
          await pool.execute(
            'INSERT INTO broadcast_logs (broadcast_id, phone, name, status) VALUES (?, ?, ?, "sent")',
            [broadcastId, contact.phone, contact.name]
          );
          // Save to messages
          await saveMessage(contact.phone, contact.name, 'outbound', `[Template: ${templateName}]`);
        }
      } else {
        failed++;
        if (pool) {
          await pool.execute(
            'INSERT INTO broadcast_logs (broadcast_id, phone, name, status, error_msg) VALUES (?, ?, ?, "failed", ?)',
            [broadcastId, contact.phone, contact.name, result.error]
          );
        }
      }

      // Update broadcast progress
      if (pool && broadcastId) {
        await pool.execute(
          'UPDATE broadcasts SET sent = ?, failed = ? WHERE id = ?',
          [sent, failed, broadcastId]
        );
      }

      // Rate limit: 1 message per 100ms to avoid Meta limits
      await new Promise(r => setTimeout(r, 100));
    }

    // Mark complete
    if (pool && broadcastId) {
      await pool.execute(
        'UPDATE broadcasts SET status = "completed", completed_at = NOW() WHERE id = ?',
        [broadcastId]
      );
    }
    console.log(`✅ Broadcast complete: ${sent} sent, ${failed} failed`);
  })();
});

app.get('/api/broadcasts', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const [rows] = await pool.execute('SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 50');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/broadcasts/:id/progress', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json({});
  try {
    const [rows] = await pool.execute('SELECT * FROM broadcasts WHERE id = ?', [req.params.id]);
    res.json(rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== TEMPLATES ====================

app.get('/api/templates', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const [rows] = await pool.execute('SELECT * FROM templates WHERE is_active = 1');
    rows.forEach(r => { r.variables = typeof r.variables === 'string' ? JSON.parse(r.variables) : r.variables; });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/templates', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  const { name, template_name, category, variables, body } = req.body;
  try {
    await pool.execute(
      'INSERT INTO templates (name, template_name, category, variables, body) VALUES (?, ?, ?, ?, ?)',
      [name, template_name, category, JSON.stringify(variables), body]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/templates/:id', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  const { name, template_name, category, variables, body } = req.body;
  try {
    await pool.execute(
      'UPDATE templates SET name=?, template_name=?, category=?, variables=?, body=? WHERE id=?',
      [name, template_name, category, JSON.stringify(variables), body, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== BOT FLOWS (Editable) ====================

app.get('/api/bot-flows', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const [rows] = await pool.execute('SELECT * FROM bot_flows ORDER BY id ASC');
    rows.forEach(r => { r.buttons = typeof r.buttons === 'string' ? JSON.parse(r.buttons) : r.buttons; });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/bot-flows/:id', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  const { message, buttons, is_active } = req.body;
  try {
    await pool.execute(
      'UPDATE bot_flows SET message=?, buttons=?, is_active=? WHERE id=?',
      [message, JSON.stringify(buttons), is_active ? 1 : 0, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bot-flows', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  const { trigger_key, message, buttons, action } = req.body;
  try {
    await pool.execute(
      'INSERT INTO bot_flows (trigger_key, message, buttons, action) VALUES (?, ?, ?, ?)',
      [trigger_key, message, JSON.stringify(buttons), action]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== LEADS ====================

app.get('/api/leads', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const [rows] = await pool.execute('SELECT * FROM leads ORDER BY created_at DESC LIMIT 200');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/leads/:id', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  const { status, notes } = req.body;
  try {
    await pool.execute('UPDATE leads SET status=?, notes=? WHERE id=?', [status, notes, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==================== SETTINGS ====================

app.get('/api/settings', authMiddleware, (req, res) => {
  res.json({
    phoneNumberId: PHONE_ID ? '••••' + PHONE_ID.slice(-4) : 'Not set',
    tokenSet: !!WA_TOKEN,
    verifyToken: VERIFY_TOKEN,
    webhookUrl: `${req.protocol}://${req.get('host')}/webhook`
  });
});

// ==================== USERS / AGENTS ====================

app.get('/api/users', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.json([]);
  try {
    const [rows] = await pool.execute('SELECT id, username, name, role, is_active, created_at FROM users');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', authMiddleware, async (req, res) => {
  const pool = getPool();
  if (!pool) return res.status(500).json({ error: 'No DB' });
  const { username, password, name, role } = req.body;
  try {
    const hashed = bcrypt.hashSync(password, 10);
    await pool.execute('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)', [username, hashed, name, role || 'agent']);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Serve dashboard for all non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/webhook')) {
    res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==================== START SERVER ====================

async function start() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`🚀 Ghazala WhatsApp System running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔗 Webhook: http://localhost:${PORT}/webhook`);
  });
}

start();
