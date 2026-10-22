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

app.use(session({ secret: 'luxmind-secret', resave: false, saveUninitialized: false }));
app.use(flash());

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = { success: req.flash('success'), error: req.flash('error') };
  next();
});

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// ============================================
// --- AUTHENTICATION ---
// ============================================
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
    res.status(500).send("Login error: " + err.message);
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

const requireLogin = (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  next();
};

app.get('/', (req, res) => res.redirect('/login'));

// ============================================
// --- STUDENT DASHBOARD ---
// ============================================
app.get('/sis/my', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');
  
  try {
    const profileRes = await pool.query(`SELECT * FROM student_profiles WHERE user_id = $1`, [req.session.user.id]);
    const profile = profileRes.rows[0] || { current_semester: 1, class_level: 'Computer Engineering' };
    
    const creditsRes = await pool.query(`
      SELECT COALESCE(SUM(c.credits), 0) as total_credits 
      FROM enrollments e 
      JOIN courses c ON c.id = e.course_id 
      WHERE e.user_id = $1
    `, [req.session.user.id]);
    const credits = creditsRes.rows[0].total_credits;

    const stats = { gpa: '3.85', credits: credits, balance: 1250, semester: profile.current_semester };
    
    res.render('dashboard', { user: req.session.user, profile: profile, stats: stats, greeting: getGreeting() });
  } catch (err) {
    res.status(500).send("Dashboard Error: " + err.message);
  }
});

// ============================================
// --- STUDENT TIMETABLE ---
// ============================================
app.get('/sis/my/timetable', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');

  try {
    const scheduleRes = await pool.query(`
      SELECT 
        c.code, c.title, c.syllabus_url, c.moodle_url,
        s.id AS section_id, s.group_name, s.day_of_week, s.start_time, s.end_time, s.room,
        u.full_name AS teacher_name
      FROM enrollments e
      JOIN courses c ON c.id = e.course_id
      JOIN course_sections s ON s.id = e.section_id
      LEFT JOIN users u ON u.id = s.teacher_id
      WHERE e.user_id = $1
    `, [req.session.user.id]);

    const classes = scheduleRes.rows;
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    const schedule = { Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [] };

    classes.forEach(cls => {
      if (schedule[cls.day_of_week]) {
        cls.start_time = cls.start_time.slice(0, 5);
        cls.end_time = cls.end_time.slice(0, 5);
        schedule[cls.day_of_week].push(cls);
      }
    });

    res.render('timetable', { user: req.session.user, courses: classes, schedule: schedule, days: days });
  } catch (err) {
    res.status(500).send("Timetable Error: " + err.message);
  }
});

// ============================================
// --- STUDENT ATTENDANCE ---
// ============================================
app.get('/sis/my/attendance', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');

  try {
    const attendanceRes = await pool.query(`
      SELECT 
        c.code, c.title,
        COUNT(a.id) as total_classes,
        COUNT(CASE WHEN a.status = 'Present' THEN 1 END) as attended_classes
      FROM enrollments e
      JOIN courses c ON c.id = e.course_id
      LEFT JOIN course_sections s ON s.id = e.section_id
      LEFT JOIN attendance a ON a.section_id = s.id AND a.student_id = e.user_id
      WHERE e.user_id = $1
      GROUP BY c.id, c.code, c.title
    `, [req.session.user.id]);

    const attendanceData = attendanceRes.rows.map(row => {
      const total = Number(row.total_classes);
      const attended = Number(row.attended_classes);
      const percentage = total > 0 ? Math.round((attended / total) * 100) : 0;
      return { ...row, percentage, isBlocked: percentage < 70 && total > 0 };
    });

    res.render('attendance', { user: req.session.user, attendanceData: attendanceData });
  } catch (err) {
    res.status(500).send("Attendance Error: " + err.message);
  }
});

// ============================================
// --- COURSE REGISTRATION ---
// ============================================

// 1. View Registration Page
app.get('/sis/my/registration', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');

  try {
    const coursesRes = await pool.query(`SELECT * FROM courses WHERE semester_number <= 2 ORDER BY semester_number ASC`);
    const cartRes = await pool.query(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'draft'`, [req.session.user.id]);
    const pendingRes = await pool.query(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'pending_advisor'`, [req.session.user.id]);

    res.render('registration', {
      user: req.session.user,
      courses: coursesRes.rows,
      cart: cartRes.rows,
      pending: pendingRes.rows
    });
  } catch (err) {
    res.status(500).send("Registration Error: " + err.message);
  }
});

// 2. Add to Cart
app.post('/sis/my/registration/add', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');
  const courseId = Number(req.body.course_id);

  try {
    const existing = await pool.query(`SELECT id FROM course_registrations WHERE student_id = $1 AND course_id = $2`, [req.session.user.id, courseId]);
    if (existing.rows.length === 0) {
      await pool.query(`INSERT INTO course_registrations (student_id, course_id, status) VALUES ($1, $2, 'draft')`, [req.session.user.id, courseId]);
    }
    res.redirect('/sis/my/registration');
  } catch (err) {
    res.status(500).send("Error adding: " + err.message);
  }
});

// 3. Remove from Cart
app.post('/sis/my/registration/remove', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');
  const cartId = Number(req.body.cart_id);

  try {
    await pool.query(`DELETE FROM course_registrations WHERE id = $1 AND student_id = $2 AND status = 'draft'`, [cartId, req.session.user.id]);
    res.redirect('/sis/my/registration');
  } catch (err) {
    res.status(500).send("Error removing: " + err.message);
  }
});

// 4. Submit to Advisor
app.post('/sis/my/registration/submit', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');

  try {
    await pool.query(`UPDATE course_registrations SET status = 'pending_advisor' WHERE student_id = $1 AND status = 'draft'`, [req.session.user.id]);
    res.redirect('/sis/my/registration');
  } catch (err) {
    res.status(500).send("Error submitting: " + err.message);
  }
});

// ============================================
// --- ADVISOR APPROVALS ---
// ============================================

app.get('/sis/advisor/approvals', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'advisor') return res.redirect('/login');

  try {
    const studentsRes = await pool.query(`
      SELECT u.id, u.full_name, u.username, COUNT(cr.id) as total_courses 
      FROM course_registrations cr 
      JOIN users u ON u.id = cr.student_id 
      WHERE cr.status = 'pending_advisor' 
      GROUP BY u.id, u.full_name, u.username
    `);
    const coursesRes = await pool.query(`
      SELECT cr.student_id, c.title, c.code, c.credits 
      FROM course_registrations cr 
      JOIN courses c ON c.id = cr.course_id 
      WHERE cr.status = 'pending_advisor'
    `);

    res.render('advisor', { user: req.session.user, pendingStudents: studentsRes.rows, pendingCourses: coursesRes.rows });
  } catch (err) {
    res.status(500).send("Advisor Error: " + err.message);
  }
});

app.post('/sis/advisor/approvals/approve', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'advisor') return res.redirect('/login');
  const studentId = Number(req.body.student_id);

  try {
    const courses = await pool.query(`SELECT course_id, section_id FROM course_registrations WHERE student_id = $1 AND status = 'pending_advisor'`, [studentId]);
    for (const c of courses.rows) {
      await pool.query(`INSERT INTO enrollments (user_id, course_id, section_id) VALUES ($1, $2, $3)`, [studentId, c.course_id, c.section_id]);
    }
    await pool.query(`UPDATE course_registrations SET status = 'approved' WHERE student_id = $1 AND status = 'pending_advisor'`, [studentId]);
    res.redirect('/sis/advisor/approvals');
  } catch (err) {
    res.status(500).send("Error approving: " + err.message);
  }
});

app.post('/sis/advisor/approvals/reject', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'advisor') return res.redirect('/login');
  const studentId = Number(req.body.student_id);

  try {
    await pool.query(`DELETE FROM course_registrations WHERE student_id = $1 AND status = 'pending_advisor'`, [studentId]);
    res.redirect('/sis/advisor/approvals');
  } catch (err) {
    res.status(500).send("Error rejecting: " + err.message);
  }
});

// ============================================
// --- PLACEHOLDER (MUST BE LAST) ---
// ============================================
app.get('/sis/my/:page', requireLogin, (req, res) => {
  res.send(`
    <div style="font-family: sans-serif; padding: 3rem; text-align: center;">
      <h1>Page Under Construction</h1>
      <p>The <strong>${req.params.page}</strong> page is currently being built.</p>
      <a href="/sis/my" style="display:inline-block; margin-top:1rem; padding: 10px 20px; background: #0a1e32; color: white; text-decoration: none; border-radius: 5px;">Back to Dashboard</a>
    </div>
  `);
});

// ============================================
// --- START SERVER ---
// ============================================
app.listen(process.env.PORT || 3000, () => console.log('Server running'));