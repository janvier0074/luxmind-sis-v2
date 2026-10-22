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

// --- AUTHENTICATION ---
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

const requireLogin = (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  next();
};

// --- STUDENT DASHBOARD ---
app.get('/', (req, res) => res.redirect('/login'));

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

    const stats = { 
      gpa: '3.85', 
      credits: credits, 
      balance: 1250, 
      semester: profile.current_semester 
    };
    
    res.render('dashboard', { user: req.session.user, profile: profile, stats: stats, greeting: getGreeting() });
  } catch (err) {
    res.status(500).send("Dashboard Error: " + err.message);
  }
});

// --- STUDENT TIMETABLE ---
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

    res.render('timetable', { 
      user: req.session.user, 
      courses: classes,
      schedule: schedule,
      days: days
    });
  } catch (err) {
    res.status(500).send("Timetable Error: " + err.message);
  }
});

// --- STUDENT COURSE REGISTRATION VIEW ---
// --- STUDENT COURSE REGISTRATION VIEW ---
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
    }, (err, html) => {
      if (err) {
        console.error("EJS ERROR:", err);
        return res.status(500).send(`<pre>EJS Error: ${err.message}\n${err.stack}</pre>`);
      }
      res.send(html);
    });
  } catch (err) {
    console.error("DB ERROR:", err);
    res.status(500).send(`<pre>DB Error: ${err.message}</pre>`);
  }
});

// --- STUDENT ATTENDANCE DETAIL ---
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
      
      return {
        ...row,
        percentage,
        isBlocked: percentage < 70 && total > 0
      };
    });

    res.render('attendance', { 
      user: req.session.user, 
      attendanceData: attendanceData
    });
  } catch (err) {
    res.status(500).send("Attendance Error: " + err.message);
  }
});

// --- PLACEHOLDER FOR SIDEBAR LINKS ---
// MUST BE AT THE VERY BOTTOM BEFORE APP.LISTEN
app.get('/sis/my/:page', requireLogin, (req, res) => {
  res.send(`
    <div style="font-family: sans-serif; padding: 3rem; text-align: center;">
      <h1>Page Under Construction</h1>
      <p>The <strong>${req.params.page}</strong> page is currently being built.</p>
      <a href="/sis/my" style="display:inline-block; margin-top:1rem; padding: 10px 20px; background: #0a1e32; color: white; text-decoration: none; border-radius: 5px;">Back to Dashboard</a>
    </div>
  `);
});
// --- TEMPORARY DIAGNOSTIC ENDPOINT ---
app.get('/diag', async (req, res) => {
  try {
    const coursesCols = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'courses'
    `);
    const regCols = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'course_registrations'
    `);
    const enrollCols = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'enrollments'
    `);
    
    res.json({
      courses: coursesCols.rows.map(r => r.column_name),
      course_registrations: regCols.rows.map(r => r.column_name),
      enrollments: enrollCols.rows.map(r => r.column_name)
    });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

// --- TEMPORARY DEBUG ROUTE ---
app.get('/debug-reg', requireLogin, async (req, res) => {
  const out = { user_id: req.session.user.id, role: req.session.user.role };
  
  try {
    const coursesRes = await pool.query(`SELECT * FROM courses WHERE semester_number <= 2 ORDER BY semester_number ASC`);
    out.courses_count = coursesRes.rows.length;
    out.courses_ok = true;
  } catch (e) { out.courses_error = e.message; }

  try {
    const cartRes = await pool.query(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'draft'`, [req.session.user.id]);
    out.cart_count = cartRes.rows.length;
    out.cart_ok = true;
  } catch (e) { out.cart_error = e.message; }

  try {
    const pendingRes = await pool.query(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'pending_advisor'`, [req.session.user.id]);
    out.pending_count = pendingRes.rows.length;
    out.pending_ok = true;
  } catch (e) { out.pending_error = e.message; }

  res.json(out);
});

app.listen(process.env.PORT || 3000, () => console.log('Server running'));