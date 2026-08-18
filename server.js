require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create the students table if it doesn't exist yet
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      application_id TEXT UNIQUE,
      full_name TEXT,
      phone TEXT,
      email TEXT,
      course TEXT,
      batch TEXT,
      payment_status TEXT DEFAULT 'PENDING',
      amount_paid INTEGER DEFAULT 0,
      payment_reference TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Database ready.');
}
initDb().catch(err => console.error('Failed to set up database:', err));

async function generateApplicationId() {
  const year = new Date().getFullYear();
  const result = await pool.query('SELECT COUNT(*) AS count FROM students');
  const nextNumber = (parseInt(result.rows[0].count) + 1).toString().padStart(6, '0');
  return `PT-${year}-${nextNumber}`;
}

app.post('/register', async (req, res) => {
  const { full_name, phone, email, course, batch } = req.body;
  if (!full_name || !phone || !course) {
    return res.status(400).json({ error: 'Full name, phone, and course are required.' });
  }
  try {
    const application_id = await generateApplicationId();
    await pool.query(
      `INSERT INTO students (application_id, full_name, phone, email, course, batch)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [application_id, full_name, phone, email || '', course, batch || '']
    );
    res.json({ message: 'Registration successful', application_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

app.post('/portal', async (req, res) => {
  const { application_id, phone } = req.body;
  if (!application_id || !phone) {
    return res.status(400).json({ error: 'Application ID and phone number are required.' });
  }
  try {
    const result = await pool.query(
      `SELECT * FROM students WHERE application_id = $1 AND phone = $2`,
      [application_id.trim(), phone.trim()]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No student found with that Application ID and phone number.' });
    }
    res.json({ student: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lookup failed.' });
  }
});

const COURSE_FEES = {
  'Forklift Operator': 3000,
  'Excavator Operator': 6000,
  'Tipper Truck Operator': 7000,
  'Mobile Crane Operator': 6000
};

app.post('/pay/initialize', async (req, res) => {
  const { application_id } = req.body;
  try {
    const result = await pool.query(`SELECT * FROM students WHERE application_id = $1`, [application_id]);
    const student = result.rows[0];
    if (!student) return res.status(404).json({ error: 'Student not found.' });

    const amountGHS = COURSE_FEES[student.course];
    if (!amountGHS) return res.status(400).json({ error: 'Unknown course fee.' });

    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email: student.email && student.email.includes('@') ? student.email : 'student@planuptraining.com',
        amount: amountGHS * 100,
        currency: 'GHS',
        callback_url: `${process.env.BACKEND_URL || 'http://localhost:3000'}/pay/verify`,
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
      await pool.query(
        `UPDATE students SET payment_status = 'PAID', amount_paid = $1, payment_reference = $2 WHERE application_id = $3`,
        [data.amount / 100, reference, application_id]
      );
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

app.get('/admin/students', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await pool.query(`SELECT * FROM students ORDER BY id DESC`);
    const students = result.rows;
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load students.' });
  }
});

app.get('/', (req, res) => {
  res.send('Planup Training backend is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});