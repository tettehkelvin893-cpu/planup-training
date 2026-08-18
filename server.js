require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Database = require('better-sqlite3');

const app = express();
app.use(cors());
app.use(express.json());

const db = new Database('planup.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id TEXT UNIQUE,
    full_name TEXT,
    phone TEXT,
    email TEXT,
    course TEXT,
    batch TEXT,
    payment_status TEXT DEFAULT 'PENDING',
    amount_paid INTEGER DEFAULT 0,
    payment_reference TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

function generateApplicationId() {
  const year = new Date().getFullYear();
  const row = db.prepare('SELECT COUNT(*) AS count FROM students').get();
  const nextNumber = (row.count + 1).toString().padStart(6, '0');
  return `PT-${year}-${nextNumber}`;
}

app.post('/register', (req, res) => {
  const { full_name, phone, email, course, batch } = req.body;
  if (!full_name || !phone || !course) {
    return res.status(400).json({ error: 'Full name, phone, and course are required.' });
  }
  const application_id = generateApplicationId();
  db.prepare(`
    INSERT INTO students (application_id, full_name, phone, email, course, batch)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(application_id, full_name, phone, email || '', course, batch || '');
  res.json({ message: 'Registration successful', application_id });
});

app.post('/portal', (req, res) => {
  const { application_id, phone } = req.body;
  if (!application_id || !phone) {
    return res.status(400).json({ error: 'Application ID and phone number are required.' });
  }
  const student = db.prepare(`SELECT * FROM students WHERE application_id = ? AND phone = ?`)
    .get(application_id.trim(), phone.trim());
  if (!student) {
    return res.status(404).json({ error: 'No student found with that Application ID and phone number.' });
  }
  res.json({ student });
});

const COURSE_FEES = {
  'Forklift Operator': 3000,
  'Excavator Operator': 6000,
  'Tipper Truck Operator': 7000,
  'Mobile Crane Operator': 6000
};

app.post('/pay/initialize', async (req, res) => {
  const { application_id } = req.body;
  const student = db.prepare(`SELECT * FROM students WHERE application_id = ?`).get(application_id);
  if (!student) return res.status(404).json({ error: 'Student not found.' });

  const amountGHS = COURSE_FEES[student.course];
  if (!amountGHS) return res.status(400).json({ error: 'Unknown course fee.' });

  try {
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: student.email && student.email.includes('@') ? student.email : 'student@planuptraining.com',
        amount: amountGHS * 100,
        currency: 'GHS',
        callback_url: 'http://localhost:3000/pay/verify',
        metadata: { application_id: student.application_id }
      },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    res.json({ authorization_url: response.data.data.authorization_url });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).json({ error: 'Could not start payment. Check server logs.' });
  }
});

app.get('/pay/verify', async (req, res) => {
  const { reference } = req.query;
  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const data = response.data.data;
    if (data.status === 'success') {
      const application_id = data.metadata.application_id;
      db.prepare(`
        UPDATE students SET payment_status = 'PAID', amount_paid = ?, payment_reference = ?
        WHERE application_id = ?
      `).run(data.amount / 100, reference, application_id);
      res.send(`
        <div style="font-family:sans-serif; text-align:center; padding:60px 20px;">
          <h1 style="color:#2F8F5B;">✅ Payment Successful</h1>
          <p>Application ID: <b>${application_id}</b></p>
          <p>You can close this tab and check your status in the Student Portal.</p>
        </div>
      `);
    } else {
      res.send(`<div style="font-family:sans-serif; text-align:center; padding:60px 20px;"><h1 style="color:#C4501C;">❌ Payment not successful</h1></div>`);
    }
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(500).send('Something went wrong verifying payment.');
  }
});

// Admin: get every student — protected by a password header
app.get('/admin/students', (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const students = db.prepare(`SELECT * FROM students ORDER BY id DESC`).all();
  const totalRevenue = students.reduce((sum, s) => sum + (s.amount_paid || 0), 0);
  const paidCount = students.filter(s => s.payment_status === 'PAID').length;
  res.json({
    students,
    stats: {
      total_students: students.length,
      paid_count: paidCount,
      pending_count: students.length - paidCount,
      total_revenue: totalRevenue
    }
  });
});

app.get('/', (req, res) => {
  res.send('Planup Training backend is running.');
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});