const mysql = require('mysql2/promise');
require('dotenv').config();

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ghazala_whatsapp',
  port: parseInt(process.env.DB_PORT || '3306'),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

let pool;

async function initDB() {
  try {
    const tempConn = await mysql.createConnection({
      host: dbConfig.host, user: dbConfig.user,
      password: dbConfig.password, port: dbConfig.port
    });
    await tempConn.execute(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\``);
    await tempConn.end();
    pool = mysql.createPool(dbConfig);
    await createTables();
    console.log('✅ Database connected and tables ready');
  } catch (err) {
    console.error('❌ Database error:', err.message);
    pool = null;
  }
}

async function createTables() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS contacts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255),
        phone VARCHAR(20) UNIQUE NOT NULL,
        segment VARCHAR(100) DEFAULT 'General',
        mode VARCHAR(20) DEFAULT NULL,
        status ENUM('active','opted_out','blocked') DEFAULT 'active',
        last_message DATETIME,
        last_read_at DATETIME DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        contact_phone VARCHAR(20) NOT NULL,
        contact_name VARCHAR(255),
        direction ENUM('inbound','outbound') NOT NULL,
        message_type VARCHAR(50) DEFAULT 'text',
        media_url TEXT,
        content TEXT,
        status VARCHAR(50) DEFAULT 'sent',
        whatsapp_msg_id VARCHAR(255),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_phone (contact_phone),
        INDEX idx_created (created_at)
      )
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS bot_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        phone VARCHAR(20) UNIQUE NOT NULL,
        state VARCHAR(100) DEFAULT 'idle',
        data JSON,
        last_flow VARCHAR(100) DEFAULT NULL,
        agent_mode TINYINT DEFAULT 0,
        agent_id INT DEFAULT NULL,
        last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS leads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255),
        phone VARCHAR(20),
        course VARCHAR(100),
        level VARCHAR(50),
        mode VARCHAR(50),
        timing VARCHAR(255),
        source VARCHAR(100) DEFAULT 'bot',
        status ENUM('new','contacted','enrolled','dropped') DEFAULT 'new',
        notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS broadcasts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255),
        template_name VARCHAR(255),
        template_variables JSON,
        segment VARCHAR(100),
        total_contacts INT DEFAULT 0,
        sent INT DEFAULT 0,
        delivered INT DEFAULT 0,
        failed INT DEFAULT 0,
        status ENUM('draft','sending','completed','failed') DEFAULT 'draft',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      )
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS broadcast_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        broadcast_id INT,
        phone VARCHAR(20),
        name VARCHAR(255),
        status ENUM('sent','delivered','failed') DEFAULT 'sent',
        error_msg TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id)
      )
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS bot_flows (
        id INT AUTO_INCREMENT PRIMARY KEY,
        trigger_key VARCHAR(100) UNIQUE NOT NULL,
        message TEXT,
        buttons JSON,
        action VARCHAR(100),
        is_active TINYINT DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS templates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255),
        template_name VARCHAR(255),
        category VARCHAR(100),
        variables JSON,
        body TEXT,
        is_active TINYINT DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role ENUM('admin','agent') DEFAULT 'agent',
        name VARCHAR(255),
        email VARCHAR(255),
        whatsapp VARCHAR(20),
        about TEXT,
        address TEXT,
        profile_pic MEDIUMTEXT,
        social_links JSON,
        business_hours JSON,
        two_fa_enabled TINYINT DEFAULT 0,
        two_fa_method VARCHAR(20) DEFAULT NULL,
        totp_secret VARCHAR(255) DEFAULT NULL,
        is_active TINYINT DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Upgrade existing tables — safe ALTER TABLE with specific error check
    const upgradeColumns = [
      ['users', 'email VARCHAR(255)'],
      ['users', 'whatsapp VARCHAR(20)'],
      ['users', 'about TEXT'],
      ['users', 'address TEXT'],
      ['users', 'profile_pic MEDIUMTEXT'],
      ['users', 'social_links JSON'],
      ['users', 'business_hours JSON'],
      ['users', 'two_fa_enabled TINYINT DEFAULT 0'],
      ['users', 'two_fa_method VARCHAR(20) DEFAULT NULL'],
      ['users', 'totp_secret VARCHAR(255) DEFAULT NULL'],
      ['contacts', 'last_read_at DATETIME DEFAULT NULL'],
      ['contacts', 'mode VARCHAR(20) DEFAULT NULL'],
    ];
    for (const [tbl, col] of upgradeColumns) {
      try { await conn.execute(`ALTER TABLE ${tbl} ADD COLUMN ${col}`); } catch (e) { /* column already exists */ }
    }

    // Add 'active' status option to leads (MODIFY is safe to re-run every startup)
    try {
      await conn.execute(`ALTER TABLE leads MODIFY status ENUM('active','new','contacted','enrolled','dropped') DEFAULT 'new'`);
    } catch (e) { /* already up to date */ }

    const bcrypt = require('bcryptjs');
    const adminPass = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'ghazala123', 10);
    await conn.execute(`
      INSERT IGNORE INTO users (username, password, role, name, email, whatsapp)
      VALUES (?, ?, 'admin', 'Admin', ?, ?)
    `, [
      process.env.ADMIN_USERNAME || 'admin',
      adminPass,
      process.env.ADMIN_EMAIL || '',
      process.env.ADMIN_WHATSAPP || ''
    ]);

    await insertDefaultTemplates(conn);
    await insertDefaultBotFlows(conn);

  } finally {
    conn.release();
  }
}

async function insertDefaultTemplates(conn) {
  const templates = [
    {
      name: 'Welcome Message',
      template_name: 'ghazala_welcome',
      category: 'MARKETING',
      variables: JSON.stringify(['Student Name']),
      body: 'Hi {{1}}! 👋\n\nWelcome to *Ghazala Institute* — your gateway to language mastery and international education! 🌍\n\nWe offer:\n🇩🇪 German Language\n📝 IELTS Preparation\n💻 PTE Preparation\n🎤 Spoken English\n✈️ Study Abroad Consultancy\n\nReply *menu* to explore our courses!\n\n📞 03142230194 | 03334429257'
    },
    {
      name: 'Fee Details',
      template_name: 'ghazala_fee_details',
      category: 'MARKETING',
      variables: JSON.stringify(['Student Name', 'Course Name', 'Fee Details', 'Inclusions']),
      body: 'Hi {{1}}! 😊\n\nHere\'s the fee breakdown for *{{2}}*:\n\n💰 {{3}}\n\n✅ {{4}}\n✅ No hidden charges.\n\nRegistration: Rs. 2,000 (non-refundable)\n\n📞 03142230194 | 03334429257'
    },
    {
      name: 'Course Follow-up',
      template_name: 'ghazala_course_followup',
      category: 'MARKETING',
      variables: JSON.stringify(['Student Name', 'Course Name', 'Start Date', 'Fee']),
      body: 'Hi {{1}}! 👋\n\nYou\'d shown interest in our *{{2}}* course — just checking in!\n\nNext batch: *{{3}}*\n💰 Fee: {{4}}\n🏫 Onsite & online available\n\n📞 03142230194 | 03334429257'
    },
    {
      name: 'New Batch Announcement',
      template_name: 'ghazala_new_batch',
      category: 'MARKETING',
      variables: JSON.stringify(['Student Name', 'Course Name', 'Start Date', 'Timing', 'Instructor', 'Mode']),
      body: 'Hi {{1}}! 🎉\n\nNew batch for *{{2}}* is opening!\n\n📅 Start: {{3}}\n⏰ Timing: {{4}}\n👨‍🏫 Instructor: {{5}}\n🏫 Mode: {{6}}\n\nEnroll now!\n📞 03142230194 | 03334429257'
    },
    {
      name: 'Enrollment Confirmation',
      template_name: 'ghazala_enrollment_confirm',
      category: 'UTILITY',
      variables: JSON.stringify(['Student Name', 'Course Name', 'Batch Timing', 'Mode', 'Start Date']),
      body: 'Hi {{1}}! 🎊\n\nYou\'re officially enrolled in *{{2}}* at Ghazala Institute!\n\n📅 Timing: {{3}}\n📍 Mode: {{4}}\n🗓️ Starting: {{5}}\n\nWelcome aboard! 💪\n\n📞 03142230194 | 03334429257'
    }
  ];
  for (const t of templates) {
    await conn.execute('INSERT IGNORE INTO templates (name, template_name, category, variables, body) VALUES (?,?,?,?,?)',
      [t.name, t.template_name, t.category, t.variables, t.body]);
  }
}

async function insertDefaultBotFlows(conn) {
  const flows = [
    {
      trigger_key: 'welcome',
      message: '👋 *Welcome to Ghazala Institute!*\n\n🌍 Language Courses | ✈️ Study Abroad Consultancy\n\nPlease choose an option:',
      buttons: JSON.stringify([
        { id: 'courses_fees', title: '📚 Courses & Fees' },
        { id: 'study_abroad', title: '✈️ Study Abroad' },
        { id: 'location_info', title: '📍 Location & Info' },
        { id: 'admission_info', title: '🎓 Admission Info' },
        { id: 'talk_to_agent', title: '🤝 Talk to Agent' },
        { id: 'register_now', title: '📋 Register Now' }
      ]),
      action: 'main_menu'
    },
    {
      trigger_key: 'courses_fees',
      message: '📚 *Select a Course:*',
      buttons: JSON.stringify([
        { id: 'course_german', title: '🇩🇪 German' },
        { id: 'course_ielts', title: '📝 IELTS' },
        { id: 'course_pte', title: '💻 PTE' },
        { id: 'course_spoken', title: '🎤 Spoken English' },
        { id: 'main_menu', title: '🏠 Main Menu' }
      ]),
      action: 'course_select'
    },
    {
      trigger_key: 'course_german',
      message: '🇩🇪 *German Language*\n\n⏱️ Duration: 3 months per level\n\n💰 *Fee Structure:*\n• A1 Lower Beginner (Onsite): PKR 38,000\n• A1 Lower Beginner (Online): PKR 35,000\n• A1 Intensive (Onsite): PKR 45,000\n• A2 Upper Beginner: PKR 42,000\n• B1 Intermediate: PKR 45,000\n• B2.1 Upper Inter.: PKR 50,000\n• B2.2 Upper Inter.: PKR 50,000\n\n📦 *Includes:* Books, Material, Registration\n✅ No hidden charges\n\n📋 Registration Fee: Rs. 2,000 (Non-refundable)',
      buttons: JSON.stringify([
        { id: 'schedule_german', title: '📅 View Schedule' },
        { id: 'register_now', title: '📋 Register Now' },
        { id: 'main_menu', title: '🏠 Main Menu' }
      ]),
      action: 'course_detail'
    },
    {
      trigger_key: 'schedule_german',
      message: '📅 *German A1 Schedule*\n🗓️ Starting: Monday, 08-June-2026\n\n🏫 *ONSITE WEEKDAY:*\n• Mon, Wed, Fri | 11:00am-01:00pm | Miss Fizza\n• Tue, Thu, Fri | 05:00pm-07:00pm | Sir Hateem\n• Mon, Wed, Sat | 07:00pm-09:00pm | Miss Waniya\n\n💪 *INTENSIVE:*\n• Mon-Thu | 05:00pm-07:00pm | Miss Waniya\n\n💻 *ONLINE:*\n• Mon-Thu | 05:00pm-06:00pm\n• Mon-Thu | 10:00pm-11:00pm | Sir Mustafa\n\n🏫 *ONSITE WEEKEND:*\n• Sat & Sun | 01:00pm-03:00pm | Sir Mustafa\n• Sat & Sun | 03:00pm-05:00pm | Miss Wania',
      buttons: JSON.stringify([
        { id: 'register_now', title: '📋 Register Now' },
        { id: 'courses_fees', title: '📚 Other Courses' },
        { id: 'main_menu', title: '🏠 Main Menu' }
      ]),
      action: 'schedule'
    },
    {
      trigger_key: 'course_ielts',
      message: '📝 *IELTS Preparation*\n\n⏱️ Duration: 2 months\n\n💰 *Fee Structure:*\n• Regular (Onsite): PKR 25,000\n• Regular (Online): PKR 22,000\n• Intensive (Onsite): PKR 30,000\n\n📦 *Includes:* Study material, Mock tests, Books\n✅ No hidden charges\n\n📋 Registration Fee: Rs. 2,000',
      buttons: JSON.stringify([
        { id: 'register_now', title: '📋 Register Now' },
        { id: 'courses_fees', title: '📚 Other Courses' },
        { id: 'main_menu', title: '🏠 Main Menu' }
      ]),
      action: 'course_detail'
    },
    {
      trigger_key: 'course_pte',
      message: '💻 *PTE Preparation*\n\n⏱️ Duration: 6 weeks\n\n💰 *Fee Structure:*\n• Regular (Onsite): PKR 20,000\n• Regular (Online): PKR 18,000\n\n📦 *Includes:* Study material, Practice tests\n✅ No hidden charges\n\n📋 Registration Fee: Rs. 2,000',
      buttons: JSON.stringify([
        { id: 'register_now', title: '📋 Register Now' },
        { id: 'courses_fees', title: '📚 Other Courses' },
        { id: 'main_menu', title: '🏠 Main Menu' }
      ]),
      action: 'course_detail'
    },
    {
      trigger_key: 'course_spoken',
      message: '🎤 *Spoken English*\n\n⏱️ Duration: 3 months\n\n💰 *Fee Structure:*\n• Regular (Onsite): PKR 15,000\n• Regular (Online): PKR 12,000\n\n📦 *Includes:* Speaking sessions, Materials\n✅ No hidden charges\n\n📋 Registration Fee: Rs. 2,000',
      buttons: JSON.stringify([
        { id: 'register_now', title: '📋 Register Now' },
        { id: 'courses_fees', title: '📚 Other Courses' },
        { id: 'main_menu', title: '🏠 Main Menu' }
      ]),
      action: 'course_detail'
    },
    {
      trigger_key: 'study_abroad',
      message: '✈️ *Study Abroad Consultancy*\n\nGhazala Institute provides complete guidance for studying abroad.\n\n🌍 *Countries:*\n• Germany 🇩🇪\n• UK 🇬🇧\n• Australia 🇦🇺\n• Canada 🇨🇦\n\n📋 *Services:*\n• University selection\n• Application assistance\n• Visa guidance\n• Language preparation\n\nFor detailed consultation:',
      buttons: JSON.stringify([
        { id: 'talk_to_agent', title: '🤝 Talk to Agent' },
        { id: 'register_now', title: '📋 Register Now' },
        { id: 'main_menu', title: '🏠 Main Menu' }
      ]),
      action: 'study_abroad'
    },
    {
      trigger_key: 'location_info',
      message: '📍 *Ghazala Institute Location*\n\n🏢 FL-4/10 Block 5, Rashid Minhas Road\nGulshan-e-Iqbal, Karachi\n\n📞 *Contact:*\n• 03142230194\n• 03334429257\n• 021-34801984\n\n📧 info@ghazalainstitute.com\n🌐 ghazalainstitute.com\n\n🗺️ https://maps.google.com/?q=Ghazala+Institute+Gulshan+e+Iqbal+Karachi\n\n⏰ *Hours:*\nMon-Sat: 9:00am - 9:00pm',
      buttons: JSON.stringify([
        { id: 'courses_fees', title: '📚 Courses & Fees' },
        { id: 'register_now', title: '📋 Register Now' },
        { id: 'main_menu', title: '🏠 Main Menu' }
      ]),
      action: 'location'
    },
    {
      trigger_key: 'admission_info',
      message: '🎓 *Admission Information*\n\n📋 *Requirements:*\n• Valid CNIC/B-Form copy\n• Recent passport size photo\n• Registration fee Rs. 2,000\n\n📝 *Process:*\n1. Select your course\n2. Choose batch timing\n3. Pay registration fee\n4. Confirmation sent\n\n🎯 *Levels Available:*\n• Beginner to Advanced\n• Onsite & Online both available',
      buttons: JSON.stringify([
        { id: 'register_now', title: '📋 Register Now' },
        { id: 'courses_fees', title: '📚 View Courses' },
        { id: 'main_menu', title: '🏠 Main Menu' }
      ]),
      action: 'admission'
    },
    {
      trigger_key: 'talk_to_agent',
      message: '🤝 *Connecting you to an agent...*\n\nAn agent will respond shortly.\nOffice hours: Mon-Sat 9am-9pm\n\n📞 Or call directly:\n• 03142230194\n• 03334429257',
      buttons: JSON.stringify([]),
      action: 'agent_handover'
    },
    {
      trigger_key: 'register_now',
      message: '📋 *Registration Form*\n\nLet\'s get you enrolled! 😊\n\n👤 Please enter your *full name*:',
      buttons: JSON.stringify([]),
      action: 'start_registration'
    },
    {
      trigger_key: 'main_menu',
      message: '🏠 *Main Menu*\n\nHow can we help you?',
      buttons: JSON.stringify([
        { id: 'courses_fees', title: '📚 Courses & Fees' },
        { id: 'study_abroad', title: '✈️ Study Abroad' },
        { id: 'location_info', title: '📍 Location & Info' },
        { id: 'admission_info', title: '🎓 Admission Info' },
        { id: 'talk_to_agent', title: '🤝 Talk to Agent' },
        { id: 'register_now', title: '📋 Register Now' }
      ]),
      action: 'main_menu'
    }
  ];

  for (const flow of flows) {
    await conn.execute('INSERT IGNORE INTO bot_flows (trigger_key, message, buttons, action) VALUES (?,?,?,?)',
      [flow.trigger_key, flow.message, flow.buttons, flow.action]);
  }
}

function getPool() { return pool; }
module.exports = { initDB, getPool };
