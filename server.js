const express = require('express');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));

const mockUser = { id: 1, full_name: 'Janvier Harerimana', username: 'janvier', admission_number: '220305203' };

// --- STUDENT REGISTRATION ---
app.get('/sis/my/registration', async (req, res) => {
  try {
    const coursesRes = await pool.query(`SELECT * FROM courses ORDER BY id ASC`);
    const cartRes = await pool.query(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'draft'`, [mockUser.id]);
    const pendingRes = await pool.query(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'pending_advisor'`, [mockUser.id]);

    res.render('registration', { user: mockUser, courses: coursesRes.rows, cart: cartRes.rows, pending: pendingRes.rows, currentSem: 1 });
  } catch (err) {
    res.status(500).send("Database error: " + err.message);
  }
});

app.post('/sis/my/registration/add', async (req, res) => {
  await pool.query(`INSERT INTO course_registrations (student_id, course_id, status) VALUES ($1, $2, 'draft')`, [mockUser.id, req.body.course_id]);
  res.redirect('/sis/my/registration');
});

app.post('/sis/my/registration/remove', async (req, res) => {
  await pool.query(`DELETE FROM course_registrations WHERE id = $1`, [req.body.cart_id]);
  res.redirect('/sis/my/registration');
});

app.post('/sis/my/registration/submit', async (req, res) => {
  await pool.query(`UPDATE course_registrations SET status = 'pending_advisor' WHERE student_id = $1 AND status = 'draft'`, [mockUser.id]);
  res.redirect('/sis/my/registration');
});

// --- ADVISOR APPROVAL ---
app.get('/sis/advisor/approvals', async (req, res) => {
  try {
    const studentsRes = await pool.query(`SELECT u.id, u.full_name, u.username, COUNT(cr.id) as total_courses FROM course_registrations cr JOIN users u ON u.id = cr.student_id WHERE cr.status = 'pending_advisor' GROUP BY u.id, u.full_name, u.username`);
    const coursesRes = await pool.query(`SELECT cr.student_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.status = 'pending_advisor'`);
    res.render('advisor', { user: mockUser, pendingStudents: studentsRes.rows, pendingCourses: coursesRes.rows });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post('/sis/advisor/approvals/approve', async (req, res) => {
  const studentId = Number(req.body.student_id);
  const courses = await pool.query(`SELECT course_id FROM course_registrations WHERE student_id = $1 AND status = 'pending_advisor'`, [studentId]);
  for (const c of courses.rows) {
    await pool.query(`INSERT INTO enrollments (user_id, course_id) VALUES ($1, $2)`, [studentId, c.course_id]);
  }
  await pool.query(`UPDATE course_registrations SET status = 'approved' WHERE student_id = $1 AND status = 'pending_advisor'`, [studentId]);
  res.redirect('/sis/advisor/approvals');
});

app.post('/sis/advisor/approvals/reject', async (req, res) => {
  await pool.query(`DELETE FROM course_registrations WHERE student_id = $1 AND status = 'pending_advisor'`, [req.body.student_id]);
  res.redirect('/sis/advisor/approvals');
});

app.listen(process.env.PORT || 3000, () => console.log('Server running'));