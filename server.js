const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const session = require('express-session');
const flash = require('connect-flash');
require('dotenv').config();

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));

// Session Setup
app.use(session({
  secret: 'luxmind-secret-key',
  resave: false,
  saveUninitialized: false
}));
app.use(flash());

// Pass user and flash messages to all templates
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = { success: req.flash('success'), error: req.flash('error') };
  next();
});

// Helper for dynamic greeting
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// --- AUTHENTICATION ROUTES ---
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/sis/my');
  res.render('login', { error: req.flash('error') });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query(`SELECT * FROM users WHERE username = $1 AND password = $2`, [username, password]);
    if (result.rows.length > 0) {
      req.session.user = result.rows[0];
      if (req.session.user.role === 'advisor') return res.redirect('/sis/advisor/approvals');
      return res.redirect('/sis/my');
    }
    req.flash('error', 'Invalid credentials');
    res.redirect('/login');
  } catch (err) {
    res.status(500).send("Login error");
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Middleware to protect routes
const requireLogin = (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  next();
};

// --- STUDENT ROUTES ---
app.get('/', (req, res) => res.redirect('/login'));

app.get('/sis/my', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');
  
  try {
    const profileRes = await pool.query(`SELECT * FROM student_profiles WHERE user_id = $1`, [req.session.user.id]);
    const profile = profileRes.rows[0] || { current_semester: 1 };
    
    const stats = { gpa: '3.85', credits: 45, balance: 1250, semester: profile.current_semester };
    
    res.render('dashboard', { user: req.session.user, stats: stats, greeting: getGreeting() });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/sis/my/registration', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');
  
  try {
    const coursesRes = await pool.query(`SELECT * FROM courses WHERE semester_number <= 2 ORDER BY semester_number ASC`);
    const cartRes = await pool.query(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'draft'`, [req.session.user.id]);
    const pendingRes = await pool.query(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'pending_advisor'`, [req.session.user.id]);

    res.render('registration', { user: req.session.user, courses: coursesRes.rows, cart: cartRes.rows, pending: pendingRes.rows, currentSem: 1 });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// --- ADVISOR ROUTES ---
app.get('/sis/advisor/approvals', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'advisor') return res.redirect('/login');
  
  try {
    const studentsRes = await pool.query(`SELECT u.id, u.full_name, u.username, COUNT(cr.id) as total_courses FROM course_registrations cr JOIN users u ON u.id = cr.student_id WHERE cr.status = 'pending_advisor' GROUP BY u.id, u.full_name, u.username`);
    const coursesRes = await pool.query(`SELECT cr.student_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.status = 'pending_advisor'`);
    res.render('advisor', { user: req.session.user, pendingStudents: studentsRes.rows, pendingCourses: coursesRes.rows });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Server running at http://localhost:3000/login'));