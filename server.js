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
      
      // Route based on exact role
      if (req.session.user.role === 'admin') return res.redirect('/sis/admin');
      if (req.session.user.role === 'advisor') return res.redirect('/sis/advisor/approvals');
      if (req.session.user.role === 'teacher') return res.redirect('/sis/faculty');
      
      return res.redirect('/sis/my'); // Student
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
        s.group_name, s.day_of_week, s.start_time, s.end_time, s.room,
        u.full_name AS teacher_name
      FROM enrollments e
      JOIN courses c ON c.id = e.course_id
      LEFT JOIN course_sections s ON s.id = e.section_id
      LEFT JOIN users u ON u.id = s.teacher_id
      WHERE e.user_id = $1
    `, [req.session.user.id]);

    const classes = scheduleRes.rows;
    classes.sort((a, b) => (a.start_time || '00:00').localeCompare(b.start_time || '00:00'));

    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    const schedule = { Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [] };

    classes.forEach((cls, index) => {
      if (cls.start_time) cls.start_time = cls.start_time.slice(0, 5);
      if (cls.end_time) cls.end_time = cls.end_time.slice(0, 5);
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
app.get('/sis/my/registration', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');

  try {
    const enrollCheck = await pool.query(`SELECT id FROM enrollments WHERE user_id = $1 LIMIT 1`, [req.session.user.id]);
    const hasRegistered = enrollCheck.rows.length > 0;

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
      hasRegistered: hasRegistered
    });
  } catch (err) {
    res.status(500).send("Registration Error: " + err.message);
  }
});

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
app.get('/sis/faculty', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher' && req.session.user.role !== 'advisor') return res.redirect('/login');

  try {
    const coursesRes = await pool.query(`
      SELECT s.id as section_id, c.code, c.title, s.group_name, s.day_of_week, s.start_time,
             (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = s.id) as student_count
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      WHERE s.teacher_id = $1
    `, [req.session.user.id]);

    res.render('faculty-dashboard', { user: req.session.user, courses: coursesRes.rows });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

app.get('/sis/faculty/attendance/:section_id', requireLogin, async (req, res) => {
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

    const today = new Date().toISOString().slice(0, 10);
    const hours = [1, 2, 3, 4];

    res.render('faculty-attendance', { 
      user: req.session.user, 
      courses: coursesRes.rows, 
      section: sectionRes.rows[0], 
      students: studentsRes.rows,
      today: today,
      hours: hours
    });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

app.post('/sis/faculty/attendance/:section_id', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'advisor' && req.session.user.role !== 'teacher') return res.redirect('/login');
  const sectionId = req.params.section_id;
  const today = new Date().toISOString().slice(0, 10);

  try {
    for (const key in req.body) {
      if (key.startsWith('status_')) {
        const studentId = key.split('_')[1];
        const status = req.body[key];
        await pool.query(`DELETE FROM attendance WHERE student_id = $1 AND section_id = $2 AND date = $3`, [studentId, sectionId, today]);
        await pool.query(`INSERT INTO attendance (student_id, section_id, date, status) VALUES ($1, $2, $3, $4)`, [studentId, sectionId, today, status]);
      }
    }
    res.redirect('/sis/faculty/attendance/' + sectionId);
  } catch (err) {
    res.status(500).send("Error saving attendance: " + err.message);
  }
});


// ============================================
// --- ADMIN: STUDENT REGISTRY ---
// ============================================

// 1. List all students
app.get('/sis/admin/students', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');

  try {
    const studentsRes = await pool.query(`
      SELECT u.id, u.full_name, u.username, u.email, sp.admission_number, sp.class_level, sp.current_semester, adv.full_name as advisor_name
      FROM users u
      LEFT JOIN student_profiles sp ON sp.user_id = u.id
      LEFT JOIN users adv ON adv.id = sp.advisor_id
      WHERE u.role = 'student'
      ORDER BY u.created_at DESC
    `);

    res.render('admin-students', { user: req.session.user, students: studentsRes.rows });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// 2. Show Registration Form
app.get('/sis/admin/students/new', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');

  try {
    const advisorsRes = await pool.query(`SELECT id, full_name FROM users WHERE role = 'advisor'`);
    res.render('admin-student-new', { user: req.session.user, advisors: advisorsRes.rows });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// 3. Save New Student
app.post('/sis/admin/students/new', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');

  const { full_name, username, email, class_level, advisor_id, admission_number } = req.body;
  const defaultPassword = 'Student2026!';
  const generatedId = admission_number || 'LUX-' + Math.floor(100000 + Math.random() * 900000);

  try {
    // Insert into users
    const userRes = await pool.query(
      `INSERT INTO users (full_name, username, email, password, role) VALUES ($1, $2, $3, $4, 'student') RETURNING id`,
      [full_name, username, email || username + '@luxmind.edu', defaultPassword]
    );
    const userId = userRes.rows[0].id;

    // Insert into student_profiles
    await pool.query(
      `INSERT INTO student_profiles (user_id, admission_number, class_level, current_semester, advisor_id) VALUES ($1, $2, $3, $4, $5)`,
      [userId, generatedId, class_level || 'Computer Engineering', 1, advisor_id ? Number(advisor_id) : null]
    );

    req.flash('success', `Student ${full_name} created! Password: ${defaultPassword}`);
    res.redirect('/sis/admin/students');
  } catch (err) {
    req.flash('error', 'Error creating student: ' + err.message);
    res.redirect('/sis/admin/students/new');
  }
});

// ============================================
// --- ADMIN: TEACHER REGISTRY ---
// ============================================

// 1. List all teachers
app.get('/sis/admin/teachers', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');

  try {
    const teachersRes = await pool.query(`
      SELECT id, full_name, username, email, created_at
      FROM users
      WHERE role = 'teacher'
      ORDER BY created_at DESC
    `);

    res.render('admin-teachers', { user: req.session.user, teachers: teachersRes.rows });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// 2. Show Teacher Registration Form
app.get('/sis/admin/teachers/new', requireLogin, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');
  res.render('admin-teacher-new', { user: req.session.user });
});

// 3. Save New Teacher
app.post('/sis/admin/teachers/new', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');

  const { full_name, username, email } = req.body;
  const defaultPassword = 'Teacher2026!';

  try {
    await pool.query(
      `INSERT INTO users (full_name, username, email, password, role) VALUES ($1, $2, $3, $4, 'teacher')`,
      [full_name, username, email || username + '@luxmind.edu', defaultPassword]
    );

    req.flash('success', `Teacher ${full_name} created! Password: ${defaultPassword}`);
    res.redirect('/sis/admin/teachers');
  } catch (err) {
    req.flash('error', 'Error creating teacher: ' + err.message);
    res.redirect('/sis/admin/teachers/new');
  }
});

// ============================================
// --- ADMIN: SECTIONS & GROUPS ---
// ============================================

// 1. Show all courses and their sections
app.get('/sis/admin/sections', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');

  try {
    // Get all courses
    const coursesRes = await pool.query(`SELECT * FROM courses ORDER BY semester_number ASC, code ASC`);
    
    // Get all sections with teacher names
    const sectionsRes = await pool.query(`
      SELECT s.*, u.full_name as teacher_name
      FROM course_sections s
      LEFT JOIN users u ON u.id = s.teacher_id
    `);

    // Group sections by course_id for easy rendering
    const sectionsByCourse = {};
    sectionsRes.rows.forEach(sec => {
      if (!sectionsByCourse[sec.course_id]) sectionsByCourse[sec.course_id] = [];
      sectionsByCourse[sec.course_id].push(sec);
    });

    res.render('admin-sections', { 
      user: req.session.user, 
      courses: coursesRes.rows, 
      sectionsByCourse: sectionsByCourse 
    });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// 2. Show form to create a new section for a course
app.get('/sis/admin/sections/:course_id/new', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');

  try {
    const courseRes = await pool.query(`SELECT * FROM courses WHERE id = $1`, [req.params.course_id]);
    if (courseRes.rows.length === 0) return res.redirect('/sis/admin/sections');

    const teachersRes = await pool.query(`SELECT id, full_name FROM users WHERE role = 'teacher' ORDER BY full_name`);

    res.render('admin-section-new', { 
      user: req.session.user, 
      course: courseRes.rows[0], 
      teachers: teachersRes.rows 
    });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// 3. Save the new section to the database
app.post('/sis/admin/sections/:course_id/new', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');

  const courseId = Number(req.params.course_id);
  const { group_name, teacher_id, day_of_week, start_time, end_time, room, quota } = req.body;

  try {
    await pool.query(`
      INSERT INTO course_sections 
      (course_id, group_name, teacher_id, day_of_week, start_time, end_time, room, max_capacity) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      courseId, 
      group_name, 
      teacher_id ? Number(teacher_id) : null, 
      day_of_week, 
      start_time, 
      end_time, 
      room, 
      quota ? Number(quota) : 40
    ]);

    req.flash('success', 'New group created successfully.');
    res.redirect('/sis/admin/sections');
  } catch (err) {
    req.flash('error', 'Error creating group: ' + err.message);
    res.redirect('/sis/admin/sections/' + courseId + '/new');
  }
});

// ============================================
// --- ADMIN: FINANCE & REGISTRATIONS ---
// ============================================

// 1. Master Registration List
app.get('/sis/admin/registrations', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');

  try {
    const registrationsRes = await pool.query(`
      SELECT cr.id, cr.status, cr.requested_at, 
             u.full_name as student_name, u.username,
             c.code as course_code, c.title as course_title
      FROM course_registrations cr
      JOIN users u ON u.id = cr.student_id
      JOIN courses c ON c.id = cr.course_id
      ORDER BY cr.requested_at DESC
    `);

    res.render('admin-registrations', { user: req.session.user, registrations: registrationsRes.rows });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// 2. Finance Dashboard
app.get('/sis/admin/finance', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');

  try {
    // Get Fee Structures
    const feesRes = await pool.query(`SELECT * FROM fee_structure ORDER BY program, semester`);

    // Get Student Balances (Total Fee for their program - Total Payments)
    const balancesRes = await pool.query(`
      SELECT u.id, u.full_name, u.username, sp.class_level, sp.current_semester,
            COALESCE((SELECT SUM(amount) FROM fee_structure fs WHERE LOWER(fs.program) = LOWER(sp.class_level) AND fs.semester = sp.current_semester), 0) as total_fee,
             COALESCE((SELECT SUM(amount) FROM payments p WHERE p.student_id = u.id), 0) as total_paid
      FROM users u
      JOIN student_profiles sp ON sp.user_id = u.id
      WHERE u.role = 'student'
    `);

    // Calculate remaining balance
    const balances = balancesRes.rows.map(b => ({
      ...b,
      balance: Number(b.total_fee) - Number(b.total_paid)
    }));

    res.render('admin-finance', { user: req.session.user, fees: feesRes.rows, balances });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// 3. Add Fee Structure
app.post('/sis/admin/finance/new', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');

  const { program, semester, amount } = req.body;
  try {
    await pool.query(`INSERT INTO fee_structure (program, semester, amount) VALUES ($1, $2, $3)`, [program, Number(semester), Number(amount)]);
    req.flash('success', 'Fee structure added.');
    res.redirect('/sis/admin/finance');
  } catch (err) {
    req.flash('error', 'Error adding fee: ' + err.message);
    res.redirect('/sis/admin/finance');
  }
});





// ============================================
// --- ADMIN DASHBOARD ---
// ============================================
app.get('/sis/admin', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');

  try {
    const studentsCount = await pool.query(`SELECT COUNT(*) FROM users WHERE role = 'student'`);
    const teachersCount = await pool.query(`SELECT COUNT(*) FROM users WHERE role = 'teacher'`);
    const coursesCount = await pool.query(`SELECT COUNT(*) FROM courses`);
    const pendingRegs = await pool.query(`SELECT COUNT(*) FROM course_registrations WHERE status = 'pending_advisor'`);

    res.render('admin-dashboard', { 
      user: req.session.user,
      stats: {
        students: studentsCount.rows[0].count,
        teachers: teachersCount.rows[0].count,
        courses: coursesCount.rows[0].count,
        pending: pendingRegs.rows[0].count
      }
    });
  } catch (err) {
    res.status(500).send("Admin Error: " + err.message);
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