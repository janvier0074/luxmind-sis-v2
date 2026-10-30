const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const session = require('express-session');
const flash = require('connect-flash');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY || 're_missing_key');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));

app.use(session({ secret: 'luxmind-secret', resave: false, saveUninitialized: false }));
app.use(flash());

app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = { success: req.flash('success'), error: req.flash('error') };
  res.locals.unseenDocs = 0;
  
  if (req.session.user && req.session.user.role === 'student') {
    try {
      const r = await pool.query(
        `SELECT COUNT(*) FROM document_requests WHERE student_id = $1 AND status != 'pending' AND seen_by_student = false`,
        [req.session.user.id]
      );
      res.locals.unseenDocs = parseInt(r.rows[0].count) || 0;
    } catch (e) { res.locals.unseenDocs = 0; }
  }
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
    const result = await pool.query(`
      SELECT u.* FROM users u
      LEFT JOIN student_profiles sp ON sp.user_id = u.id
      WHERE (u.username = $1 OR sp.admission_number = $1) AND u.password = $2
    `, [username, password]);
    
    if (result.rows.length > 0) {
      req.session.user = result.rows[0];
      
      if (req.session.user.role === 'admin') return res.redirect('/sis/admin');
      if (req.session.user.role === 'advisor') return res.redirect('/sis/advisor/approvals');
      if (req.session.user.role === 'teacher') return res.redirect('/sis/faculty');
      
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
// --- STUDENT DASHBOARD & ACADEMICS ---
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

         // Count new announcements (last 7 days)
    const newAnnCount = await pool.query(`
      SELECT COUNT(*) FROM course_announcements a
      JOIN course_sections s ON s.id = a.section_id
      JOIN enrollments e ON e.section_id = s.id
      WHERE e.user_id = $1 AND a.created_at > NOW() - INTERVAL '7 days'
    `, [req.session.user.id]);
    
          res.render('dashboard', { 
      user: req.session.user, 
      profile: profile, 
      stats: stats, 
      greeting: getGreeting(),
      announcementCount: parseInt(newAnnCount.rows[0].count) || 0
    });
  } catch (err) {
    res.status(500).send("Dashboard Error: " + err.message);
  }
});

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

app.get('/sis/my/transcript', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');

  try {
    const gradesRes = await pool.query(`
      SELECT c.code, c.title, c.credits, 
             g.midterm_grade, g.final_grade, g.letter_grade, g.gpa_points
      FROM grades g
      JOIN course_sections s ON s.id = g.section_id
      JOIN courses c ON c.id = s.course_id
      WHERE g.student_id = $1
      ORDER BY c.semester_number ASC
    `, [req.session.user.id]);

    const courses = gradesRes.rows;

    let totalCredits = 0;
    let totalPoints = 0;

    courses.forEach(c => {
      totalCredits += Number(c.credits);
      totalPoints += (Number(c.gpa_points) * Number(c.credits));
    });

    const cgpa = totalCredits > 0 ? (totalPoints / totalCredits).toFixed(2) : '0.00';

    res.render('transcript', { user: req.session.user, courses: courses, totalCredits: totalCredits, cgpa: cgpa });
  } catch (err) {
    res.status(500).send("Transcript Error: " + err.message);
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
// --- STUDENT: DOCUMENT REQUESTS ---
// ============================================
app.get('/sis/my/documents', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');

  try {
    await pool.query(
      `UPDATE document_requests SET seen_by_student = true WHERE student_id = $1 AND status != 'pending'`, 
      [req.session.user.id]
    );
    const requestsRes = await pool.query(`
      SELECT * FROM document_requests 
      WHERE student_id = $1 
      ORDER BY requested_at DESC
    `, [req.session.user.id]);

    res.render('student-documents', { user: req.session.user, requests: requestsRes.rows });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

app.post('/sis/my/documents/request', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');

  const { document_type, notes } = req.body;

  try {
    await pool.query(`
      INSERT INTO document_requests (student_id, document_type, status, notes) 
      VALUES ($1, $2, 'pending', $3)
    `, [req.session.user.id, document_type, notes || null]);

    req.flash('success', 'Document request submitted successfully.');
    res.redirect('/sis/my/documents');
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

app.get('/sis/my/documents/view/:id', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');

  try {
    const reqRes = await pool.query(`
      SELECT * FROM document_requests 
      WHERE id = $1 AND student_id = $2 AND status = 'ready'
    `, [req.params.id, req.session.user.id]);

    if (reqRes.rows.length === 0) {
      return res.send("Document not ready or unauthorized.");
    }

    const profileRes = await pool.query(`
      SELECT u.full_name, u.username, u.email, sp.admission_number, sp.class_level, sp.current_semester
      FROM users u JOIN student_profiles sp ON sp.user_id = u.id
      WHERE u.id = $1
    `, [req.session.user.id]);

    const coursesRes = await pool.query(`
      SELECT c.code, c.title, c.credits, 
             g.midterm_grade, g.final_grade, g.letter_grade, g.gpa_points
      FROM enrollments e
      JOIN courses c ON c.id = e.course_id
      LEFT JOIN grades g ON g.student_id = e.user_id AND g.section_id = e.section_id
      WHERE e.user_id = $1
    `, [req.session.user.id]);

    res.render('document-template', {
      user: req.session.user,
      profile: profileRes.rows[0],
      courses: coursesRes.rows,
      document: reqRes.rows[0],
      today: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// ============================================
// --- STUDENT FINANCE & SCHOLARSHIP ENGINE ---
// ============================================
app.get('/sis/my/finance', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');

  try {
    const profileRes = await pool.query(`
      SELECT u.full_name, sp.class_level, sp.current_semester, sp.is_international, sp.high_school_gpa
      FROM users u JOIN student_profiles sp ON sp.user_id = u.id
      WHERE u.id = $1
    `, [req.session.user.id]);
    
    const student = profileRes.rows[0];

    let scholarshipPercentage = 0;
    let scholarshipName = 'None';

    if (student.is_international) {
      scholarshipPercentage = 50;
      scholarshipName = 'International Undergraduate Scholarship';
    }
    
    if (student.high_school_gpa && student.high_school_gpa >= 3.5) {
      scholarshipPercentage = 100;
      scholarshipName = 'High Honor Merit Scholarship';
    }

    const feeRes = await pool.query(`
      SELECT amount FROM fee_structure 
      WHERE LOWER(program) = LOWER($1) AND semester = $2
    `, [student.class_level, student.current_semester]);
    
    const baseTuition = feeRes.rows.length > 0 ? Number(feeRes.rows[0].amount) : 0;
    const scholarshipAmount = (baseTuition * scholarshipPercentage) / 100;
    const netTuition = baseTuition - scholarshipAmount;

    const paidRes = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE student_id = $1`, [req.session.user.id]);
    const totalPaid = Number(paidRes.rows[0].total);
    const debt = netTuition - totalPaid;

    res.render('student-finance', {
      user: req.session.user,
      student: student,
      baseTuition: baseTuition,
      scholarshipName: scholarshipName,
      scholarshipPercentage: scholarshipPercentage,
      scholarshipAmount: scholarshipAmount,
      netTuition: netTuition,
      totalPaid: totalPaid,
      debt: debt
    });
  } catch (err) {
    res.status(500).send("Finance Error: " + err.message);
  }
});

app.post('/sis/my/finance/pay', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');
  const amount = Number(req.body.amount);
  
  try {
    await pool.query(`INSERT INTO payments (student_id, amount) VALUES ($1, $2)`, [req.session.user.id, amount]);
    req.flash('success', `Payment of $${amount} processed successfully.`);
    res.redirect('/sis/my/finance');
  } catch (err) {
    res.status(500).send("Error: " + err.message);
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

    res.render('advisor', { 
      user: req.session.user, 
      greeting: getGreeting(),
      pendingStudents: studentsRes.rows, 
      pendingCourses: coursesRes.rows 
    });
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
// --- FACULTY ROUTES ---
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

    res.render('faculty-dashboard', { 
      user: req.session.user, 
      greeting: getGreeting(),
      courses: coursesRes.rows 
    });
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

app.get('/sis/faculty/grades', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher' && req.session.user.role !== 'advisor') return res.redirect('/login');

  try {
    const coursesRes = await pool.query(`
      SELECT s.id as section_id, c.code, c.title, s.group_name
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      WHERE s.teacher_id = $1
    `, [req.session.user.id]);

    res.render('faculty-grades', { user: req.session.user, courses: coursesRes.rows });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

app.get('/sis/faculty/grades/:section_id', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher' && req.session.user.role !== 'advisor') return res.redirect('/login');

  try {
    const sectionRes = await pool.query(`
      SELECT s.id, c.code, c.title, s.group_name 
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = $1 AND s.teacher_id = $2
    `, [req.params.section_id, req.session.user.id]);

    if (sectionRes.rows.length === 0) return res.redirect('/sis/faculty/grades');

    const studentsRes = await pool.query(`
      SELECT u.id as user_id, u.full_name, u.username, 
             g.midterm_grade, g.final_grade, g.letter_grade, g.gpa_points
      FROM enrollments e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN grades g ON g.student_id = u.id AND g.section_id = $1
      WHERE e.section_id = $1
    `, [req.params.section_id]);

    res.render('faculty-grades-entry', { 
      user: req.session.user, 
      section: sectionRes.rows[0], 
      students: studentsRes.rows 
    });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

app.post('/sis/faculty/grades/:section_id', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher' && req.session.user.role !== 'advisor') return res.redirect('/login');

  const sectionId = req.params.section_id;

  try {
    for (const key in req.body) {
      if (key.startsWith('midterm_')) {
        const studentId = key.split('_')[1];
        const midterm = Number(req.body[key]) || 0;
        const final = Number(req.body['final_' + studentId]) || 0;

               // Calculate total, CIU letter grade, and GPA
        const total = (midterm + final) / 2;
        let letter = 'F';
        let gpa = 0.0;

        if (total >= 97) { letter = 'A+'; gpa = 4.0; }
        else if (total >= 93) { letter = 'A'; gpa = 4.0; }
        else if (total >= 90) { letter = 'A-'; gpa = 3.7; }
        else if (total >= 87) { letter = 'B+'; gpa = 3.3; }
        else if (total >= 83) { letter = 'B'; gpa = 3.0; }
        else if (total >= 80) { letter = 'B-'; gpa = 2.7; }
        else if (total >= 77) { letter = 'C+'; gpa = 2.3; }
        else if (total >= 73) { letter = 'C'; gpa = 2.0; }
        else if (total >= 70) { letter = 'C-'; gpa = 1.7; }
        else if (total >= 67) { letter = 'D+'; gpa = 1.3; }
        else if (total >= 63) { letter = 'D'; gpa = 1.0; }
        else if (total >= 60) { letter = 'D-'; gpa = 0.7; }
        else { letter = 'F'; gpa = 0.0; }

        await pool.query(`
          INSERT INTO grades (student_id, section_id, midterm_grade, final_grade, letter_grade, gpa_points)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (student_id, section_id) 
          DO UPDATE SET midterm_grade = $3, final_grade = $4, letter_grade = $5, gpa_points = $6
        `, [studentId, sectionId, midterm, final, letter, gpa]);
      }
    }
    req.flash('success', 'Grades saved successfully.');
    res.redirect('/sis/faculty/grades/' + sectionId);
  } catch (err) {
    res.status(500).send("Error saving grades: " + err.message);
  }
});

// ============================================
// --- ADMIN ROUTES ---
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
      greeting: getGreeting(),
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
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.get('/sis/admin/students/new', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');
  try {
    const advisorsRes = await pool.query(`SELECT id, full_name FROM users WHERE role = 'advisor'`);
    res.render('admin-student-new', { user: req.session.user, advisors: advisorsRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.post('/sis/admin/students/new', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');
  
  const { full_name, username, email, class_level, advisor_id, admission_number, is_international, high_school_gpa } = req.body;
  const defaultPassword = 'Student2026!';
  const generatedId = admission_number || 'LUX-' + Math.floor(100000 + Math.random() * 900000);

  try {
    const userRes = await pool.query(
      `INSERT INTO users (full_name, username, email, password, role) VALUES ($1, $2, $3, $4, 'student') RETURNING id`,
      [full_name, username, email || username + '@luxmind.edu', defaultPassword]
    );
    const userId = userRes.rows[0].id;
    
    await pool.query(
      `INSERT INTO student_profiles 
       (user_id, admission_number, class_level, current_semester, advisor_id, is_international, high_school_gpa) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId, 
        generatedId, 
        class_level || 'Computer Engineering', 
        1, 
        advisor_id ? Number(advisor_id) : null,
        is_international === 'true', 
        high_school_gpa ? Number(high_school_gpa) : null
      ]
    );
    
    req.flash('success', `Student ${full_name} created! Password: ${defaultPassword}`);
    res.redirect('/sis/admin/students');
  } catch (err) {
    req.flash('error', 'Error creating student: ' + err.message);
    res.redirect('/sis/admin/students/new');
  }
});

app.get('/sis/admin/teachers', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');
  try {
    const teachersRes = await pool.query(`SELECT id, full_name, username, email, created_at FROM users WHERE role = 'teacher' ORDER BY created_at DESC`);
    res.render('admin-teachers', { user: req.session.user, teachers: teachersRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.get('/sis/admin/teachers/new', requireLogin, (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');
  res.render('admin-teacher-new', { user: req.session.user });
});

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

app.get('/sis/admin/sections', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');
  try {
    const coursesRes = await pool.query(`SELECT * FROM courses ORDER BY semester_number ASC, code ASC`);
    const sectionsRes = await pool.query(`
      SELECT s.*, u.full_name as teacher_name
      FROM course_sections s
      LEFT JOIN users u ON u.id = s.teacher_id
    `);
    const sectionsByCourse = {};
    sectionsRes.rows.forEach(sec => {
      if (!sectionsByCourse[sec.course_id]) sectionsByCourse[sec.course_id] = [];
      sectionsByCourse[sec.course_id].push(sec);
    });
    res.render('admin-sections', { user: req.session.user, courses: coursesRes.rows, sectionsByCourse: sectionsByCourse });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.get('/sis/admin/sections/:course_id/new', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');
  try {
    const courseRes = await pool.query(`SELECT * FROM courses WHERE id = $1`, [req.params.course_id]);
    if (courseRes.rows.length === 0) return res.redirect('/sis/admin/sections');
    const teachersRes = await pool.query(`SELECT id, full_name FROM users WHERE role = 'teacher' ORDER BY full_name`);
    res.render('admin-section-new', { user: req.session.user, course: courseRes.rows[0], teachers: teachersRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.post('/sis/admin/sections/:course_id/new', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');
  const courseId = Number(req.params.course_id);
  const { group_name, teacher_id, day_of_week, start_time, end_time, room, quota } = req.body;

  try {
    await pool.query(`
      INSERT INTO course_sections 
      (course_id, group_name, teacher_id, day_of_week, start_time, end_time, room, max_capacity) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [courseId, group_name, teacher_id ? Number(teacher_id) : null, day_of_week, start_time, end_time, room, quota ? Number(quota) : 40]);
    req.flash('success', 'New group created successfully.');
    res.redirect('/sis/admin/sections');
  } catch (err) {
    req.flash('error', 'Error creating group: ' + err.message);
    res.redirect('/sis/admin/sections/' + courseId + '/new');
  }
});

app.get('/sis/admin/registrations', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');
  try {
    const registrationsRes = await pool.query(`
      SELECT cr.id, cr.status, cr.requested_at, u.full_name as student_name, u.username, c.code as course_code, c.title as course_title
      FROM course_registrations cr
      JOIN users u ON u.id = cr.student_id
      JOIN courses c ON c.id = cr.course_id
      ORDER BY cr.requested_at DESC
    `);
    res.render('admin-registrations', { user: req.session.user, registrations: registrationsRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.get('/sis/admin/finance', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');
  try {
    const feesRes = await pool.query(`SELECT * FROM fee_structure ORDER BY program, semester`);
    const studentsRes = await pool.query(`
      SELECT u.id, u.full_name, u.username, sp.class_level, sp.current_semester
      FROM users u JOIN student_profiles sp ON sp.user_id = u.id
      WHERE u.role = 'student'
    `);
    const balances = [];
    for (const student of studentsRes.rows) {
      const matchingFee = feesRes.rows.find(f => 
        f.program.toLowerCase().trim() === student.class_level.toLowerCase().trim() && 
        Number(f.semester) === Number(student.current_semester)
      );
      const totalFee = matchingFee ? Number(matchingFee.amount) : 0;
      const paidRes = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE student_id = $1`, [student.id]);
      const totalPaid = Number(paidRes.rows[0].total);
      balances.push({ ...student, total_fee: totalFee, total_paid: totalPaid, balance: totalFee - totalPaid });
    }
    res.render('admin-finance', { user: req.session.user, fees: feesRes.rows, balances });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

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

app.get('/sis/admin/documents', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');
  try {
    const requestsRes = await pool.query(`
      SELECT dr.*, u.full_name as student_name, u.username
      FROM document_requests dr
      JOIN users u ON u.id = dr.student_id
      ORDER BY dr.requested_at DESC
    `);
    res.render('admin-documents', { user: req.session.user, requests: requestsRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.post('/sis/admin/documents/:id/status', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');
  const { status, admin_notes } = req.body; 
  const requestId = req.params.id;

  try {
    await pool.query(
      `UPDATE document_requests SET status = $1, admin_notes = $2, seen_by_student = false WHERE id = $3`, 
      [status, admin_notes || null, requestId]
    );

    const infoRes = await pool.query(`
      SELECT u.email, u.full_name, dr.document_type
      FROM document_requests dr
      JOIN users u ON u.id = dr.student_id
      WHERE dr.id = $1
    `, [requestId]);

    if (infoRes.rows.length > 0) {
      const s = infoRes.rows[0];
      const statusLabel = status === 'ready' ? 'APPROVED ✅' : 'REJECTED ❌';
      
      try {
        await resend.emails.send({
          from: 'LuxMind Registrar <onboarding@resend.dev>',
          to: s.email,
          subject: `LuxMind SIS - Document Request ${statusLabel}`,
          html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; background: #f7fafd; border: 1px solid #d9e6f2; border-radius: 8px;">
              <h2 style="color: #0a1e32;">LuxMind University</h2>
              <p>Dear <strong>${s.full_name}</strong>,</p>
              <p>Your document request for <strong>${s.document_type}</strong> has been <strong style="color:${status === 'ready' ? 'green' : 'red'};">${statusLabel}</strong>.</p>
              ${admin_notes ? `<p><strong>Message from the Registrar:</strong> ${admin_notes}</p>` : ''}
              <p>Please log in to your Student Portal to view and download your document.</p>
             <a href="${process.env.APP_URL}/sis/my/documents" style="display: inline-block; padding: 12px 24px; background: #0a1e32; color: #fff; text-decoration: none; border-radius: 6px; margin-top: 15px;">Go to Student Portal</a>
            </div>
          `
        });
        console.log('Email sent successfully via Resend.');
      } catch (mailErr) {
        console.error('Resend API Error:', mailErr);
      }
    }

    req.flash('success', 'Request status updated and email sent.');
    res.redirect('/sis/admin/documents');
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});


// ============================================
// --- ADMIN: EXAM PROGRAM ---
// ============================================
app.get('/sis/admin/exams', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');
  try {
    const examsRes = await pool.query(`
      SELECT e.*, c.code, c.title 
      FROM exams e
      JOIN courses c ON c.id = e.course_id
      ORDER BY e.exam_date ASC
    `);
    const coursesRes = await pool.query(`SELECT id, code, title FROM courses ORDER BY code`);
    res.render('admin-exams', { user: req.session.user, exams: examsRes.rows, courses: coursesRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.post('/sis/admin/exams/new', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.redirect('/login');
  const { course_id, exam_type, exam_date, start_time, room } = req.body;
  try {
    await pool.query(`
      INSERT INTO exams (course_id, exam_type, exam_date, start_time, room) 
      VALUES ($1, $2, $3, $4, $5)
    `, [Number(course_id), exam_type, exam_date, start_time, room]);
    req.flash('success', 'Exam scheduled successfully.');
    res.redirect('/sis/admin/exams');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- STUDENT: EXAM PROGRAM ---
// ============================================
app.get('/sis/my/exams', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');
  try {
    const examsRes = await pool.query(`
      SELECT e.*, c.code, c.title 
      FROM exams e
      JOIN courses c ON c.id = e.course_id
      JOIN enrollments en ON en.course_id = c.id
      WHERE en.user_id = $1
      ORDER BY e.exam_date ASC
    `, [req.session.user.id]);
    res.render('student-exams', { user: req.session.user, exams: examsRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- STUDENT: EXAM RESULTS ---
// ============================================
app.get('/sis/my/exam-results', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');
  try {
    const resultsRes = await pool.query(`
      SELECT c.code, c.title, c.credits, 
             g.midterm_grade, g.final_grade, g.letter_grade, g.gpa_points
      FROM grades g
      JOIN course_sections s ON s.id = g.section_id
      JOIN courses c ON c.id = s.course_id
      WHERE g.student_id = $1
      ORDER BY c.code ASC
    `, [req.session.user.id]);

    // Calculate current semester CGPA for this specific view
    let totalPoints = 0;
    let totalCredits = 0;
    resultsRes.rows.forEach(r => {
      totalCredits += Number(r.credits);
      totalPoints += (Number(r.gpa_points) * Number(r.credits));
    });
    const semesterGPA = totalCredits > 0 ? (totalPoints / totalCredits).toFixed(2) : '0.00';

    res.render('student-exam-results', { 
      user: req.session.user, 
      results: resultsRes.rows,
      semesterGPA: semesterGPA
    });
  } catch (err) { 
    res.status(500).send("Error: " + err.message); 
  }
});

// ============================================
// --- FACULTY: MY COURSES ---
// ============================================
app.get('/sis/faculty/courses', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher' && req.session.user.role !== 'advisor') return res.redirect('/login');
  
  try {
    const coursesRes = await pool.query(`
      SELECT s.id as section_id, c.code, c.title, c.credits, s.group_name, s.day_of_week, s.start_time, s.room,
             (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = s.id) as student_count
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      WHERE s.teacher_id = $1
    `, [req.session.user.id]);

    res.render('faculty-courses', { 
      user: req.session.user, 
      courses: coursesRes.rows,
      greeting: getGreeting()
    });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});


// ============================================
// --- FACULTY: COURSE MATERIALS ---
// ============================================

// 1. Show Materials Form
app.get('/sis/faculty/courses/:course_id/materials', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher' && req.session.user.role !== 'advisor') return res.redirect('/login');
  
  try {
    // Verify the teacher actually teaches this course
    const courseRes = await pool.query(`
      SELECT c.id, c.code, c.title, c.syllabus_url, c.moodle_url 
      FROM courses c
      JOIN course_sections s ON s.course_id = c.id
      WHERE c.id = $1 AND s.teacher_id = $2
      LIMIT 1
    `, [req.params.course_id, req.session.user.id]);

    if (courseRes.rows.length === 0) return res.redirect('/sis/faculty/courses');

    res.render('faculty-course-materials', { 
      user: req.session.user, 
      course: courseRes.rows[0],
      greeting: getGreeting()
    });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// 2. Save Materials
app.post('/sis/faculty/courses/:course_id/materials', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher' && req.session.user.role !== 'advisor') return res.redirect('/login');
  
  const { syllabus_url, moodle_url } = req.body;
  const courseId = req.params.course_id;

  try {
    await pool.query(`
      UPDATE courses 
      SET syllabus_url = $1, moodle_url = $2 
      WHERE id = $3
    `, [syllabus_url || null, moodle_url || null, courseId]);

    req.flash('success', 'Course materials updated successfully.');
    res.redirect('/sis/faculty/courses');
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});


// ============================================
// --- FACULTY: ATTENDANCE HISTORY ---
// ============================================

// 1. Show Attendance History (Summary of dates)
app.get('/sis/faculty/attendance-history/:section_id', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher' && req.session.user.role !== 'advisor') return res.redirect('/login');
  
  try {
    // Verify the teacher actually teaches this course
    const sectionRes = await pool.query(`
      SELECT s.id, c.code, c.title, s.group_name 
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = $1 AND s.teacher_id = $2
    `, [req.params.section_id, req.session.user.id]);

    if (sectionRes.rows.length === 0) return res.redirect('/sis/faculty/courses');

    // Get the history grouped by date
    const historyRes = await pool.query(`
      SELECT date, 
             COUNT(CASE WHEN status = 'Present' THEN 1 END) as present_count,
             COUNT(CASE WHEN status = 'Absent' THEN 1 END) as absent_count,
             COUNT(CASE WHEN status = 'Late' THEN 1 END) as late_count,
             COUNT(*) as total_students
      FROM attendance 
      WHERE section_id = $1
      GROUP BY date
      ORDER BY date DESC
    `, [req.params.section_id]);

    res.render('faculty-attendance-history', { 
      user: req.session.user, 
      section: sectionRes.rows[0],
      history: historyRes.rows,
      greeting: getGreeting()
    });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// 2. Show Detailed Roster for a specific past date
app.get('/sis/faculty/attendance-history/:section_id/:date', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher' && req.session.user.role !== 'advisor') return res.redirect('/login');
  
  try {
    const sectionRes = await pool.query(`
      SELECT s.id, c.code, c.title, s.group_name 
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = $1 AND s.teacher_id = $2
    `, [req.params.section_id, req.session.user.id]);

    if (sectionRes.rows.length === 0) return res.redirect('/sis/faculty/courses');

    // Get the exact roster for that day
    const rosterRes = await pool.query(`
      SELECT u.full_name, u.username, a.status
      FROM attendance a
      JOIN users u ON u.id = a.student_id
      WHERE a.section_id = $1 AND a.date = $2
      ORDER BY u.full_name ASC
    `, [req.params.section_id, req.params.date]);

    res.render('faculty-attendance-detail', { 
      user: req.session.user, 
      section: sectionRes.rows[0],
      roster: rosterRes.rows,
      date: req.params.date,
      greeting: getGreeting()
    });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// ============================================
// --- FACULTY: GRADE DISTRIBUTION ---
// ============================================
app.get('/sis/faculty/grades/:section_id/summary', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher' && req.session.user.role !== 'advisor') return res.redirect('/login');
  
  try {
    const sectionRes = await pool.query(`
      SELECT s.id, c.code, c.title, s.group_name 
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = $1 AND s.teacher_id = $2
    `, [req.params.section_id, req.session.user.id]);

    if (sectionRes.rows.length === 0) return res.redirect('/sis/faculty/courses');

    // Count how many students got each grade
    const distRes = await pool.query(`
      SELECT letter_grade, COUNT(*) as count
      FROM grades
      WHERE section_id = $1 AND letter_grade IS NOT NULL
      GROUP BY letter_grade
    `, [req.params.section_id]);

    // Initialize all possible grades with 0
    const distribution = {
      'A+': 0, 'A': 0, 'A-': 0,
      'B+': 0, 'B': 0, 'B-': 0,
      'C+': 0, 'C': 0, 'C-': 0,
      'D+': 0, 'D': 0, 'D-': 0,
      'F': 0
    };

    distRes.rows.forEach(row => {
      if (distribution[row.letter_grade] !== undefined) {
        distribution[row.letter_grade] = Number(row.count);
      }
    });

    res.render('faculty-grades-summary', { 
      user: req.session.user, 
      section: sectionRes.rows[0],
      distribution: distribution,
      greeting: getGreeting()
    });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});




// ============================================
// --- STUDENT: ANNOUNCEMENTS PAGE ---
// ============================================
app.get('/sis/my/announcements', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'student') return res.redirect('/login');
  try {
    const annRes = await pool.query(`
      SELECT a.*, c.code as course_code, c.title as course_title, u.full_name as teacher_name
      FROM course_announcements a
      JOIN course_sections s ON s.id = a.section_id
      JOIN courses c ON c.id = s.course_id
      JOIN users u ON u.id = a.teacher_id
      JOIN enrollments e ON e.section_id = s.id
      WHERE e.user_id = $1
      ORDER BY a.created_at DESC
    `, [req.session.user.id]);

    res.render('student-announcements', { 
      user: req.session.user, 
      announcements: annRes.rows 
    });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- FACULTY: CLASS ANNOUNCEMENTS ---
// ============================================

// 1. List all announcements by this teacher
app.get('/sis/faculty/announcements', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher' && req.session.user.role !== 'advisor') return res.redirect('/login');
  try {
    const annRes = await pool.query(`
      SELECT a.*, c.code, c.title, s.group_name
      FROM course_announcements a
      JOIN course_sections s ON s.id = a.section_id
      JOIN courses c ON c.id = s.course_id
      WHERE a.teacher_id = $1
      ORDER BY a.created_at DESC
    `, [req.session.user.id]);

    res.render('faculty-announcements', { 
      user: req.session.user, 
      announcements: annRes.rows,
      greeting: getGreeting()
    });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 2. Show Form to create announcement
app.get('/sis/faculty/announcements/new', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher' && req.session.user.role !== 'advisor') return res.redirect('/login');
  try {
    const coursesRes = await pool.query(`
      SELECT s.id as section_id, c.code, c.title, s.group_name
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      WHERE s.teacher_id = $1
    `, [req.session.user.id]);

    res.render('faculty-announcement-new', { 
      user: req.session.user, 
      courses: coursesRes.rows,
      greeting: getGreeting()
    });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 3. Save Announcement
app.post('/sis/faculty/announcements/new', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'teacher' && req.session.user.role !== 'advisor') return res.redirect('/login');
  const { section_id, title, message } = req.body;
  
  try {
    await pool.query(`
      INSERT INTO course_announcements (section_id, teacher_id, title, message)
      VALUES ($1, $2, $3, $4)
    `, [Number(section_id), req.session.user.id, title, message]);
    
    req.flash('success', 'Announcement posted successfully.');
    res.redirect('/sis/faculty/announcements');
  } catch (err) { res.status(500).send("Error: " + err.message); }
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

app.listen(process.env.PORT || 3000, () => console.log('Server running'));