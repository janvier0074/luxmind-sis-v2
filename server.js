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
// --- STUDENT TIMETABLE ---
app.get('/sis/my/timetable', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');

  try {
    const scheduleRes = await pool.query(`
      SELECT 
        c.code, c.title, c.syllabus_url, c.moodle_url,
        s.group_name, s.day_of_week, s.start_time, s.end_time, s.room,
        u.full_name AS teacher_name
      FROM enrollments e
      JOIN courses c ON c.id = e.course_id
      LEFT JOIN course_sections s ON s.id = e.section_id
      LEFT JOIN users u ON u.id = s.teacher_id
      WHERE e.user_id = $1
    `, [req.session.user.id]);

    const classes = scheduleRes.rows;
    
    // Sort classes by start time
    classes.sort((a, b) => (a.start_time || '00:00').localeCompare(b.start_time || '00:00'));

    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    const schedule = { Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [] };

    classes.forEach((cls, index) => {
      // Format time to HH:MM
      if (cls.start_time) cls.start_time = cls.start_time.slice(0, 5);
      if (cls.end_time) cls.end_time = cls.end_time.slice(0, 5);
      
      // Assign a color index (0-4) for the frontend gradients
      cls.colorIndex = index % 5;

      if (cls.day_of_week && schedule[cls.day_of_week]) {
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
// --- STUDENT COURSE REGISTRATION VIEW ---
app.get('/sis/my/registration', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');

  try {
    // 1. Check if the student is ALREADY ENROLLED in anything
    const enrollCheck = await pool.query(`SELECT id FROM enrollments WHERE user_id = $1 LIMIT 1`, [req.session.user.id]);
    const hasRegistered = enrollCheck.rows.length > 0;

    // 2. Fetch the rest of the data (only if not registered)
    const coursesRes = await pool.query(`
      SELECT c.*, COALESCE(c.quota, 40) as quota,
             ((SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) + (SELECT COUNT(*) FROM course_registrations cr WHERE cr.course_id = c.id AND cr.status = 'pending_advisor')) as enrolled_count
      FROM courses c ORDER BY c.semester_number ASC
    `);
    const cartRes = await pool.query(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'draft'`, [req.session.user.id]);
    const pendingRes = await pool.query(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'pending_advisor'`, [req.session.user.id]);

    res.render('registration', {
      user: req.session.user,
      courses: coursesRes.rows,
      cart: cartRes.rows,
      pending: pendingRes.rows,
      hasRegistered: hasRegistered // Pass this to the frontend
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
    const courses = await pool.query(`SELECT course_id FROM course_registrations WHERE student_id = $1 AND status = 'pending_advisor'`, [studentId]);
    
    for (const c of courses.rows) {
      // Auto-assign the first available section for this course
      const sec = await pool.query(`SELECT id FROM course_sections WHERE course_id = $1 LIMIT 1`, [c.course_id]);
      const sectionId = sec.rows.length > 0 ? sec.rows[0].id : null;

      await pool.query(`INSERT INTO enrollments (user_id, course_id, section_id) VALUES ($1, $2, $3)`, [studentId, c.course_id, sectionId]);
    }
    
    await pool.query(`UPDATE course_registrations SET status = 'approved' WHERE student_id = $1 AND status = 'pending_advisor'`, [studentId]);
    res.redirect('/sis/advisor/approvals');
  } catch (err) {
    res.status(500).send("Error approving: " + err.message);
  }
});

// ============================================
// --- FACULTY: ATTENDANCE MANAGEMENT ---
// ============================================

// 1. Show list of classes
app.get('/sis/faculty/attendance', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'advisor' && req.session.user.role !== 'teacher') return res.redirect('/login');
  
  try {
    const coursesRes = await pool.query(`
      SELECT s.id as section_id, c.code, c.title, s.group_name, s.day_of_week, s.start_time
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      WHERE s.teacher_id = $1
    `, [req.session.user.id]);
    
    res.render('faculty-attendance', { 
      user: req.session.user, 
      courses: coursesRes.rows, 
      section: null, 
      students: [] 
    });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// 2. Show roster for a specific class
// 2. Show roster for a specific class
app.get('/sis/faculty/attendance/:section_id', requireLogin, async (req, res) => {
  // Allow both teacher and advisor roles (since they can be the same person)
  if (req.session.user.role !== 'advisor' && req.session.user.role !== 'teacher') return res.redirect('/login');
  
  try {
    const coursesRes = await pool.query(`
      SELECT s.id as section_id, c.code, c.title, s.group_name, s.day_of_week, s.start_time
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      WHERE s.teacher_id = $1
    `, [req.session.user.id]);

    const sectionRes = await pool.query(`
      SELECT s.id, c.code, c.title, s.group_name 
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = $1 AND s.teacher_id = $2
    `, [req.params.section_id, req.session.user.id]);

    if (sectionRes.rows.length === 0) return res.redirect('/sis/faculty/attendance');

    const studentsRes = await pool.query(`
      SELECT u.id as user_id, u.full_name, u.username, a.status as current_status
      FROM enrollments e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN attendance a ON a.student_id = u.id AND a.section_id = $1 AND a.date = CURRENT_DATE
      WHERE e.section_id = $1
    `, [req.params.section_id]);

    // Get today's date for the UI and QR code
    const today = new Date().toISOString().slice(0, 10);

    res.render('faculty-attendance', { 
      user: req.session.user, 
      courses: coursesRes.rows, 
      section: sectionRes.rows[0], 
      students: studentsRes.rows,
      today: today
    });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// 3. Save the attendance
app.post('/sis/faculty/attendance/:section_id', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'advisor' && req.session.user.role !== 'teacher') return res.redirect('/login');
  
  const sectionId = req.params.section_id;
  const today = new Date().toISOString().slice(0, 10);

  try {
    for (const key in req.body) {
      if (key.startsWith('status_')) {
        const studentId = key.split('_')[1];
        const status = req.body[key];

        // Delete existing attendance for today to avoid duplicates
        await pool.query(`DELETE FROM attendance WHERE student_id = $1 AND section_id = $2 AND date = $3`, [studentId, sectionId, today]);
        
        // Insert the new attendance record
        await pool.query(`INSERT INTO attendance (student_id, section_id, date, status) VALUES ($1, $2, $3, $4)`, [studentId, sectionId, today, status]);
      }
    }
    res.redirect('/sis/faculty/attendance/' + sectionId);
  } catch (err) {
    res.status(500).send("Error saving attendance: " + err.message);
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
// --- TEMPORARY DATABASE FIX ---
app.get('/fix-db', async (req, res) => {
  try {
    // 1. Fix the column length
    await pool.query(`ALTER TABLE course_sections ALTER COLUMN day_of_week TYPE VARCHAR(20);`);
    
    // 2. Distribute the schedule
    await pool.query(`
      UPDATE course_sections 
      SET day_of_week = CASE (id % 5)
          WHEN 0 THEN 'Monday'
          WHEN 1 THEN 'Tuesday'
          WHEN 2 THEN 'Wednesday'
          WHEN 3 THEN 'Thursday'
          ELSE 'Friday'
        END,
        start_time = CASE (id % 4)
          WHEN 0 THEN '08:30'::time
          WHEN 1 THEN '10:30'::time
          WHEN 2 THEN '13:30'::time
          ELSE '15:30'::time
        END,
        room = 'Room ' || (100 + (id % 20));
    `);

    res.send('<h1>✅ SUCCESS!</h1><p>Database unlocked and schedule distributed. You can now check your Timetable.</p>');
  } catch (err) {
    res.status(500).send('<h1>❌ Error</h1><pre>' + err.message + '</pre>');
  }
});
// ============================================
// --- START SERVER ---
// ============================================
app.listen(process.env.PORT || 3000, () => console.log('Server running'));