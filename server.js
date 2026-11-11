require('dotenv').config(); // <--- MUST BE LINE 1

const { createClient } = require('@supabase/supabase-js');

// Safely initialize Supabase (prevents server crash if keys are missing)
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
} else {
  console.warn("⚠️ WARNING: Supabase keys are missing in environment variables. File uploads will not work.");
}
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const session = require('express-session');
const flash = require('connect-flash');
const { Resend } = require('resend');
const multer = require('multer');
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // Increased to 5MB for PDFs
});

// ============================================
// --- i18n: LANGUAGE DICTIONARIES ---
// ============================================
const langDicts = {
  en: require('./lang/en.json'),
  fr: require('./lang/fr.json'),
  sw: require('./lang/sw.json'),
  rn: require('./lang/rn.json')
};

const app = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const resend = new Resend(process.env.RESEND_API_KEY || 're_missing_key');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));

app.use(session({ secret: 'luxmind-secret', resave: false, saveUninitialized: false }));

// ============================================
// --- i18n: MIDDLEWARE ---
// ============================================
app.use((req, res, next) => {
  const selected = (req.session && req.session.language) || 'en';
  res.locals.lang = langDicts[selected] || langDicts.en;
  res.locals.locale = langDicts[selected] ? selected : 'en';
  next();
});

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
      if (req.session.user.role === 'advisor') return res.redirect('/sis/advisor');
      if (req.session.user.role === 'teacher') return res.redirect('/sis/faculty');
      if (req.session.user.role === 'rectorate') return res.redirect('/sis/rectorate');
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

// ============================================
// --- CENTRALIZED SECURITY MIDDLEWARE ---
// ============================================
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }
    if (!allowedRoles.includes(req.session.user.role)) {
      return res.status(403).render('403'); // Show 403 Forbidden page
    }
    next();
  };
};

app.get('/', (req, res) => res.redirect('/login'));

// ============================================
// --- i18n: LANGUAGE SWITCHER ROUTE ---
// ============================================
app.get('/set-language/:locale', (req, res) => {
  const { locale } = req.params;
  if (langDicts[locale]) {
    req.session.language = locale;
  }
  res.redirect(req.get('referer') || '/sis/my');
});

// ============================================
// --- STUDENT DASHBOARD & ACADEMICS ---
// ============================================
app.get('/sis/my', requireRole('student'), async (req, res) => {
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

    const newAnnCount = await pool.query(`
      SELECT COUNT(*) FROM course_announcements a
      JOIN course_sections s ON s.id = a.section_id
      JOIN enrollments e ON e.section_id = s.id
      WHERE e.user_id = $1 AND a.created_at > NOW() - INTERVAL '7 days'
    `, [req.session.user.id]);
    const globalAnnCount = await pool.query(`
      SELECT COUNT(*) FROM global_announcements WHERE created_at > NOW() - INTERVAL '7 days'
    `);
    

    const targetedRes = await pool.query(`
      SELECT * FROM targeted_announcements 
      WHERE target_role IN ('student', 'all') 
      ORDER BY created_at DESC LIMIT 5
    `);

    res.render('dashboard', { 
      user: req.session.user, 
      profile: profile, 
      stats: stats, 
      greeting: getGreeting(),
      announcementCount: parseInt(newAnnCount.rows[0].count) || 0,
      globalAnnouncementCount: parseInt(globalAnnCount.rows[0].count) || 0,
      targetedMessages: targetedRes.rows
    });
  } catch (err) {
    res.status(500).send("Dashboard Error: " + err.message);
  }
});

app.get('/sis/my/timetable', requireRole('student'), async (req, res) => {
  try {
    const scheduleRes = await pool.query(`
      SELECT c.code, c.title, c.syllabus_url, c.moodle_url, s.group_name, s.day_of_week, s.start_time, s.end_time, s.room, u.full_name AS teacher_name
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
  } catch (err) { res.status(500).send("Timetable Error: " + err.message); }
});

app.get('/sis/my/attendance', requireRole('student'), async (req, res) => {
  try {
    const attendanceRes = await pool.query(`
      SELECT c.code, c.title,
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
  } catch (err) { res.status(500).send("Attendance Error: " + err.message); }
});



// ============================================
// --- STUDENT: CGPA SIMULATOR ---
// ============================================
app.get('/sis/my/cgpa-simulator', requireRole('student'), async (req, res) => {
  try {
    // 1. Get past published grades to calculate CURRENT CGPA
    const pastGradesRes = await pool.query(`
      SELECT c.credits, g.gpa_points 
      FROM grades g
      JOIN course_sections s ON s.id = g.section_id
      JOIN courses c ON c.id = s.course_id
      WHERE g.student_id = $1 AND g.is_published = true
    `, [req.session.user.id]);

    let currentCredits = 0;
    let currentPoints = 0;
    pastGradesRes.rows.forEach(row => {
      currentCredits += Number(row.credits);
      currentPoints += (Number(row.gpa_points) * Number(row.credits));
    });
    const currentCGPA = currentCredits > 0 ? (currentPoints / currentCredits).toFixed(2) : '0.00';

    // 2. Get currently enrolled courses for the simulator
    const activeCoursesRes = await pool.query(`
      SELECT c.id, c.code, c.title, c.credits 
      FROM enrollments e
      JOIN courses c ON c.id = e.course_id
      WHERE e.user_id = $1
      ORDER BY c.code ASC
    `, [req.session.user.id]);

    res.render('student-cgpa-simulator', {
      user: req.session.user,
      currentCGPA,
      currentCredits,
      currentPoints,
      activeCourses: activeCoursesRes.rows
    });
  } catch (err) { res.status(500).send("CGPA Simulator Error: " + err.message); }
});




app.get('/sis/my/transcript', requireRole('student'), async (req, res) => {
  try {
    const gradesRes = await pool.query(` SELECT c.code, c.title, c.credits, g.midterm_grade, g.final_grade, g.letter_grade, g.gpa_points FROM grades g JOIN course_sections s ON s.id = g.section_id JOIN courses c ON c.id = s.course_id WHERE g.student_id = $1 AND g.is_published = true ORDER BY c.semester_number ASC `, [req.session.user.id]);

    const courses = gradesRes.rows;
    let totalCredits = 0;
    let totalPoints = 0;

    courses.forEach(c => {
      totalCredits += Number(c.credits);
      totalPoints += (Number(c.gpa_points) * Number(c.credits));
    });

    const cgpa = totalCredits > 0 ? (totalPoints / totalCredits).toFixed(2) : '0.00';
    res.render('transcript', { user: req.session.user, courses: courses, totalCredits: totalCredits, cgpa: cgpa });
  } catch (err) { res.status(500).send("Transcript Error: " + err.message); }
});

// ============================================
// --- COURSE REGISTRATION ---
// ============================================
app.get('/sis/my/registration', requireRole('student'), async (req, res) => {
  try {
    const enrollCheck = await pool.query(`SELECT id FROM enrollments WHERE user_id = $1 LIMIT 1`, [req.session.user.id]);
    const hasRegistered = enrollCheck.rows.length > 0;

    // 1. Get courses, their sections, and current capacity
    const coursesRes = await pool.query(`
      SELECT c.*, COALESCE(c.quota, 40) as quota,
             s.id as section_id, s.day_of_week, s.start_time, s.end_time,
             ((SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) + 
              (SELECT COUNT(*) FROM course_registrations cr WHERE cr.course_id = c.id AND cr.status = 'pending_advisor')) as enrolled_count
      FROM courses c 
      LEFT JOIN course_sections s ON s.course_id = c.id
      ORDER BY c.semester_number ASC
    `);

    // 2. Get student's passed courses (for prerequisites)
    const passedRes = await pool.query(`
      SELECT c.id FROM grades g 
      JOIN course_sections s ON s.id = g.section_id 
      JOIN courses c ON c.id = s.course_id 
      WHERE g.student_id = $1 AND g.letter_grade NOT IN ('F', 'N/A') AND g.is_published = true
    `, [req.session.user.id]);
    const passedCourseIds = passedRes.rows.map(r => r.id);

    // 3. Get student's current cart and enrolled schedule (for conflicts)
    const enrolledRes = await pool.query(`
      SELECT c.id, s.day_of_week, s.start_time, s.end_time 
      FROM enrollments e JOIN courses c ON c.id = e.course_id LEFT JOIN course_sections s ON s.id = e.section_id WHERE e.user_id = $1
      UNION
      SELECT c.id, s.day_of_week, s.start_time, s.end_time 
      FROM course_registrations cr JOIN courses c ON c.id = cr.course_id LEFT JOIN course_sections s ON s.id = c.id WHERE cr.student_id = $1 AND cr.status IN ('draft', 'pending_advisor')
    `, [req.session.user.id]);

    const cartRes = await pool.query(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'draft'`, [req.session.user.id]);
    const pendingRes = await pool.query(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'pending_advisor'`, [req.session.user.id]);

    // 4. Calculate eligibility for each course
    const processedCourses = coursesRes.rows.map(course => {
      let isEligible = true;
      let reason = '';

      // Check Quota
      if (course.enrolled_count >= course.quota) {
        isEligible = false;
        reason = 'Section Full';
      }

      // Check Prerequisite
      if (course.prerequisite_id && !passedCourseIds.includes(course.prerequisite_id)) {
        isEligible = false;
        reason = 'Missing Prerequisite';
      }

      // Check Schedule Conflict
      if (course.day_of_week && course.start_time) {
        const conflict = enrolledRes.rows.find(e => 
          e.id !== course.id && 
          e.day_of_week === course.day_of_week && 
          e.start_time === course.start_time
        );
        if (conflict) {
          isEligible = false;
          reason = 'Schedule Conflict';
        }
      }

      return { ...course, isEligible, reason };
    });

    res.render('registration', { user: req.session.user, courses: processedCourses, cart: cartRes.rows, pending: pendingRes.rows, hasRegistered });
  } catch (err) { res.status(500).send("Registration Error: " + err.message); }
});

app.post('/sis/my/registration/add', requireRole('student'), async (req, res) => {
  const courseId = Number(req.body.course_id);
  try {
    // 1. Fetch course rules
    const courseRes = await pool.query(`
      SELECT c.*, COALESCE(c.quota, 40) as quota, s.day_of_week, s.start_time, s.end_time,
             (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) + 
             (SELECT COUNT(*) FROM course_registrations cr WHERE cr.course_id = c.id AND cr.status = 'pending_advisor') as enrolled_count
      FROM courses c LEFT JOIN course_sections s ON s.course_id = c.id WHERE c.id = $1 LIMIT 1
    `, [courseId]);
    
    if (courseRes.rows.length === 0) return res.redirect('/sis/my/registration');
    const course = courseRes.rows[0];

    // 2. Check Quota
    if (course.enrolled_count >= course.quota) {
      req.flash('error', 'Cannot add course: Section is full.');
      return res.redirect('/sis/my/registration');
    }

    // 3. Check Prerequisite
    if (course.prerequisite_id) {
      const passedCheck = await pool.query(`
        SELECT g.id FROM grades g JOIN course_sections s ON s.id = g.section_id
        WHERE g.student_id = $1 AND s.course_id = $2 AND g.letter_grade NOT IN ('F', 'N/A') AND g.is_published = true
      `, [req.session.user.id, course.prerequisite_id]);
      
      if (passedCheck.rows.length === 0) {
        req.flash('error', 'Cannot add course: Missing prerequisite.');
        return res.redirect('/sis/my/registration');
      }
    }

    // 4. Check Schedule Conflict
    if (course.day_of_week && course.start_time) {
      const conflictCheck = await pool.query(`
        SELECT e.id FROM enrollments e JOIN course_sections s ON s.id = e.section_id
        WHERE e.user_id = $1 AND s.day_of_week = $2 AND s.start_time = $3
        UNION
        SELECT cr.id FROM course_registrations cr JOIN courses c ON c.id = cr.course_id LEFT JOIN course_sections s ON s.course_id = c.id
        WHERE cr.student_id = $1 AND cr.status IN ('draft', 'pending_advisor') AND s.day_of_week = $2 AND s.start_time = $3
      `, [req.session.user.id, course.day_of_week, course.start_time]);

      if (conflictCheck.rows.length > 0) {
        req.flash('error', 'Cannot add course: Schedule conflict with another course.');
        return res.redirect('/sis/my/registration');
      }
    }

    // 5. Add to cart
    const existing = await pool.query(`SELECT id FROM course_registrations WHERE student_id = $1 AND course_id = $2`, [req.session.user.id, courseId]);
    if (existing.rows.length === 0) {
      await pool.query(`INSERT INTO course_registrations (student_id, course_id, status) VALUES ($1, $2, 'draft')`, [req.session.user.id, courseId]);
      req.flash('success', 'Course added to cart.');
    }
    
    res.redirect('/sis/my/registration');
  } catch (err) { res.status(500).send("Error adding: " + err.message); }
});


app.post('/sis/my/registration/remove', requireRole('student'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM course_registrations WHERE id = $1 AND student_id = $2 AND status = 'draft'`, [Number(req.body.cart_id), req.session.user.id]);
    res.redirect('/sis/my/registration');
  } catch (err) { res.status(500).send("Error removing: " + err.message); }
});

app.post('/sis/my/registration/submit', requireRole('student'), async (req, res) => {
  try {
    await pool.query(`UPDATE course_registrations SET status = 'pending_advisor' WHERE student_id = $1 AND status = 'draft'`, [req.session.user.id]);
    res.redirect('/sis/my/registration');
  } catch (err) { res.status(500).send("Error submitting: " + err.message); }
});

// ============================================
// --- STUDENT: DOCUMENT REQUESTS ---
// ============================================
app.get('/sis/my/documents', requireRole('student'), async (req, res) => {
  try {
    await pool.query(`UPDATE document_requests SET seen_by_student = true WHERE student_id = $1 AND status != 'pending'`, [req.session.user.id]);
    const requestsRes = await pool.query(`SELECT * FROM document_requests WHERE student_id = $1 ORDER BY requested_at DESC`, [req.session.user.id]);
    res.render('student-documents', { user: req.session.user, requests: requestsRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.post('/sis/my/documents/request', requireRole('student'), async (req, res) => {
  const { document_type, notes } = req.body;
  try {
    await pool.query(`INSERT INTO document_requests (student_id, document_type, status, notes) VALUES ($1, $2, 'pending', $3)`, [req.session.user.id, document_type, notes || null]);
    req.flash('success', 'Document request submitted successfully.');
    res.redirect('/sis/my/documents');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.get('/sis/my/documents/view/:id', requireRole('student'), async (req, res) => {
  try {
    const reqRes = await pool.query(`SELECT * FROM document_requests WHERE id = $1 AND student_id = $2 AND status = 'ready'`, [req.params.id, req.session.user.id]);
    if (reqRes.rows.length === 0) return res.send("Document not ready or unauthorized.");

    const profileRes = await pool.query(`SELECT u.full_name, u.username, u.email, sp.admission_number, sp.class_level, sp.current_semester FROM users u JOIN student_profiles sp ON sp.user_id = u.id WHERE u.id = $1`, [req.session.user.id]);
    const coursesRes = await pool.query(`SELECT c.code, c.title, c.credits, g.midterm_grade, g.final_grade, g.letter_grade, g.gpa_points FROM enrollments e JOIN courses c ON c.id = e.course_id LEFT JOIN grades g ON g.student_id = e.user_id AND g.section_id = e.section_id WHERE e.user_id = $1`, [req.session.user.id]);

    res.render('document-template', { user: req.session.user, profile: profileRes.rows[0], courses: coursesRes.rows, document: reqRes.rows[0], today: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- STUDENT FINANCE & SCHOLARSHIP ENGINE ---
// ============================================
app.get('/sis/my/finance', requireRole('student'), async (req, res) => {
  try {
    const profileRes = await pool.query(`SELECT u.full_name, sp.class_level, sp.current_semester, sp.is_international, sp.high_school_gpa FROM users u JOIN student_profiles sp ON sp.user_id = u.id WHERE u.id = $1`, [req.session.user.id]);
    const student = profileRes.rows[0];

    let scholarshipPercentage = 0;
    let scholarshipName = 'None';

    if (student.is_international) { scholarshipPercentage = 50; scholarshipName = 'International Undergraduate Scholarship'; }
    if (student.high_school_gpa && student.high_school_gpa >= 3.5) { scholarshipPercentage = 100; scholarshipName = 'High Honor Merit Scholarship'; }

    const feeRes = await pool.query(`SELECT amount FROM fee_structure WHERE LOWER(program) = LOWER($1) AND semester = $2`, [student.class_level, student.current_semester]);
    
    const baseTuition = feeRes.rows.length > 0 ? Number(feeRes.rows[0].amount) : 0;
    const scholarshipAmount = (baseTuition * scholarshipPercentage) / 100;
    const netTuition = baseTuition - scholarshipAmount;

    const paidRes = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE student_id = $1`, [req.session.user.id]);
    const totalPaid = Number(paidRes.rows[0].total);
    const debt = netTuition - totalPaid;

    res.render('student-finance', { user: req.session.user, student: student, baseTuition: baseTuition, scholarshipName: scholarshipName, scholarshipPercentage: scholarshipPercentage, scholarshipAmount: scholarshipAmount, netTuition: netTuition, totalPaid: totalPaid, debt: debt });
  } catch (err) { res.status(500).send("Finance Error: " + err.message); }
});

app.post('/sis/my/finance/pay', requireRole('student'), async (req, res) => {
  try {
    await pool.query(`INSERT INTO payments (student_id, amount) VALUES ($1, $2)`, [req.session.user.id, Number(req.body.amount)]);
    req.flash('success', `Payment of $${req.body.amount} processed successfully.`);
    res.redirect('/sis/my/finance');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- ADVISOR: MY ADVISEES & ACADEMIC PROGRESS ---
// ============================================
app.get('/sis/advisor/advisees', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const adviseesRes = await pool.query(`
      SELECT u.id, u.full_name, u.email, sp.admission_number, sp.class_level, sp.current_semester,
             COALESCE((SELECT ROUND(SUM(g.gpa_points * c.credits) / NULLIF(SUM(c.credits), 0), 2)
                       FROM grades g JOIN course_sections s ON s.id = g.section_id JOIN courses c ON c.id = s.course_id
                       WHERE g.student_id = u.id AND g.is_published = true), 0.00) as cgpa,
             COALESCE((SELECT SUM(c.credits)
                       FROM grades g JOIN course_sections s ON s.id = g.section_id JOIN courses c ON c.id = s.course_id
                       WHERE g.student_id = u.id AND g.letter_grade NOT IN ('F', 'N/A') AND g.is_published = true), 0) as credits_earned
      FROM student_profiles sp
      JOIN users u ON u.id = sp.user_id
      WHERE sp.advisor_id = $1
      ORDER BY u.full_name ASC
    `, [req.session.user.id]);

    const advisees = adviseesRes.rows;
    const totalAdvisees = advisees.length;
    const avgCGPA = totalAdvisees > 0 ? (advisees.reduce((sum, s) => sum + Number(s.cgpa), 0) / totalAdvisees).toFixed(2) : '0.00';
    const atRiskCount = advisees.filter(s => Number(s.cgpa) < 2.0).length;

    res.render('advisor-advisees', { 
      user: req.session.user, 
      advisees, 
      totalAdvisees, 
      avgCGPA, 
      atRiskCount,
      greeting: getGreeting() 
    });
  } catch (err) { res.status(500).send("Advisees Error: " + err.message); }
});

app.get('/sis/advisor/advisees/:student_id', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const studentRes = await pool.query(`
      SELECT u.id, u.full_name, u.email, sp.admission_number, sp.class_level, sp.current_semester
      FROM users u JOIN student_profiles sp ON sp.user_id = u.id
      WHERE u.id = $1 AND sp.advisor_id = $2
    `, [req.params.student_id, req.session.user.id]);
    
    if (studentRes.rows.length === 0) return res.redirect('/sis/advisor/advisees');
    const student = studentRes.rows[0];

    const gradesRes = await pool.query(`
      SELECT c.code, c.title, c.credits, c.semester_number, g.letter_grade, g.gpa_points
      FROM grades g
      JOIN course_sections s ON s.id = g.section_id
      JOIN courses c ON c.id = s.course_id
      WHERE g.student_id = $1 AND g.is_published = true
      ORDER BY c.semester_number ASC, c.code ASC
    `, [student.id]);

    const enrollmentsRes = await pool.query(`
      SELECT c.code, c.title, c.credits, s.day_of_week, s.start_time, u.full_name as teacher_name
      FROM enrollments e
      JOIN courses c ON c.id = e.course_id
      LEFT JOIN course_sections s ON s.id = e.section_id
      LEFT JOIN users u ON u.id = s.teacher_id
      WHERE e.user_id = $1
    `, [student.id]);

    let totalPoints = 0, totalCredits = 0;
    gradesRes.rows.forEach(g => {
      totalCredits += Number(g.credits);
      totalPoints += (Number(g.gpa_points) * Number(g.credits));
    });
    const cgpa = totalCredits > 0 ? (totalPoints / totalCredits).toFixed(2) : '0.00';

    const transcript = {};
    gradesRes.rows.forEach(g => {
      const sem = g.semester_number || 1;
      if (!transcript[sem]) transcript[sem] = [];
      transcript[sem].push(g);
    });

    res.render('advisor-student-progress', { 
      user: req.session.user, 
      student, 
      transcript, 
      enrollments: enrollmentsRes.rows,
      cgpa,
      totalCredits,
      greeting: getGreeting() 
    });
  } catch (err) { res.status(500).send("Progress Error: " + err.message); }
});

app.get('/sis/advisor', requireRole('advisor'), async (req, res) => {
  try {
    const adviseesRes = await pool.query(`
      SELECT u.id, u.full_name, sp.admission_number, sp.current_semester,
             COALESCE(ROUND(SUM(g.gpa_points * c.credits) / NULLIF(SUM(c.credits), 0), 2), 0.00) AS cgpa
      FROM student_profiles sp
      JOIN users u ON u.id = sp.user_id
      LEFT JOIN enrollments e ON e.user_id = u.id
      LEFT JOIN courses c ON c.id = e.course_id
      LEFT JOIN grades g ON g.student_id = u.id AND g.section_id = e.section_id AND g.is_published = true
      WHERE sp.advisor_id = $1
      GROUP BY u.id, u.full_name, sp.admission_number, sp.current_semester
    `, [req.session.user.id]);

    const pendingRegs = await pool.query(`SELECT COUNT(*) FROM course_registrations WHERE status = 'pending_advisor'`);
    
    const coursesRes = await pool.query(`
      SELECT s.id as section_id, c.code, c.title, s.group_name, s.day_of_week, s.start_time, 
             (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = s.id) as student_count 
      FROM course_sections s 
      JOIN courses c ON c.id = s.course_id 
      WHERE s.teacher_id = $1
    `, [req.session.user.id]);

    res.render('advisor-dashboard', {
      user: req.session.user,
      advisees: adviseesRes.rows,
      pendingCount: pendingRegs.rows[0].count,
      courses: coursesRes.rows,
      greeting: getGreeting()
    });
  } catch (err) { res.status(500).send("Advisor Dashboard Error: " + err.message); }
});

// ============================================
// --- ADVISOR ROUTES ---
// ============================================
app.get('/sis/advisor/approvals', requireRole('advisor'), async (req, res) => {
  try {
    const studentsRes = await pool.query(`SELECT u.id, u.full_name, u.username, COUNT(cr.id) as total_courses FROM course_registrations cr JOIN users u ON u.id = cr.student_id WHERE cr.status = 'pending_advisor' GROUP BY u.id, u.full_name, u.username`);
    const coursesRes = await pool.query(`SELECT cr.student_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.status = 'pending_advisor'`);
    res.render('advisor', { user: req.session.user, greeting: getGreeting(), pendingStudents: studentsRes.rows, pendingCourses: coursesRes.rows });
  } catch (err) { res.status(500).send("Advisor Error: " + err.message); }
});

app.post('/sis/advisor/approvals/approve', requireRole('advisor'), async (req, res) => {
  const studentId = Number(req.body.student_id);
  try {
    // 1. Get courses to approve
    const courses = await pool.query(`SELECT course_id FROM course_registrations WHERE student_id = $1 AND status = 'pending_advisor'`, [studentId]);
    
    for (const c of courses.rows) {
      const sec = await pool.query(`SELECT id FROM course_sections WHERE course_id = $1 LIMIT 1`, [c.course_id]);
      const sectionId = sec.rows.length > 0 ? sec.rows[0].id : null;
      await pool.query(`INSERT INTO enrollments (user_id, course_id, section_id) VALUES ($1, $2, $3)`, [studentId, c.course_id, sectionId]);
    }
    
    // 2. Update status
    await pool.query(`UPDATE course_registrations SET status = 'approved' WHERE student_id = $1 AND status = 'pending_advisor'`, [studentId]);

    // 3. Fetch student info to email them
    const studentRes = await pool.query(`SELECT email, full_name FROM users WHERE id = $1`, [studentId]);
    
    if (studentRes.rows.length > 0) {
      const student = studentRes.rows[0];
      try {
        await resend.emails.send({
          from: 'LuxMind Registrar <onboarding@resend.dev>',
          to: student.email,
          subject: `Registration Approved - LuxMind SIS`,
          html: `<div style="font-family: Arial, sans-serif; padding: 20px; background: #f7fafd; border: 1px solid #d9e6f2; border-radius: 8px;">
                  <h2 style="color: #0a1e32;">LuxMind University</h2>
                  <p>Dear <strong>${student.full_name}</strong>,</p>
                  <p>Your course registration has been <strong style="color: green;">APPROVED</strong> by your advisor.</p>
                  <p>You can now view your active timetable in the Student Portal.</p>
                  <a href="${process.env.APP_URL}/sis/my/timetable" style="display: inline-block; padding: 12px 24px; background: #0a1e32; color: #fff; text-decoration: none; border-radius: 6px; margin-top: 15px;">View Timetable</a>
                 </div>`
        });
      } catch (mailErr) { console.error('Resend API Error:', mailErr); }
    }

    req.flash('success', 'Registration approved and student notified via email.');
    res.redirect('/sis/advisor/approvals');
  } catch (err) { res.status(500).send("Error approving: " + err.message); }
});
// ============================================
// --- FACULTY ROUTES ---
// ============================================
app.get('/sis/faculty', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const globalAnnCount = await pool.query(`
      SELECT COUNT(*) FROM global_announcements WHERE created_at > NOW() - INTERVAL '7 days'
    `);
    const coursesRes = await pool.query(`SELECT s.id as section_id, c.code, c.title, s.group_name, s.day_of_week, s.start_time, (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = s.id) as student_count FROM course_sections s JOIN courses c ON c.id = s.course_id WHERE s.teacher_id = $1`, [req.session.user.id]);
    

    const targetedRes = await pool.query(`
      SELECT * FROM targeted_announcements 
      WHERE target_role IN ('teacher', 'advisor', 'all') 
      ORDER BY created_at DESC LIMIT 5
    `);





res.render('faculty-dashboard', { 
      user: req.session.user, 
      greeting: getGreeting(), 
      courses: coursesRes.rows,
      globalAnnouncementCount: parseInt(globalAnnCount.rows[0].count) || 0,
      targetedMessages: targetedRes.rows
    });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.get('/sis/faculty/attendance/:section_id', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const coursesRes = await pool.query(`SELECT s.id as section_id, c.code, c.title, s.group_name, s.day_of_week, s.start_time FROM course_sections s JOIN courses c ON c.id = s.course_id WHERE s.teacher_id = $1`, [req.session.user.id]);
    const sectionRes = await pool.query(`SELECT s.id, c.code, c.title, s.group_name FROM course_sections s JOIN courses c ON c.id = s.course_id WHERE s.id = $1 AND s.teacher_id = $2`, [req.params.section_id, req.session.user.id]);
    if (sectionRes.rows.length === 0) return res.redirect('/sis/faculty/attendance');
    const studentsRes = await pool.query(`SELECT u.id as user_id, u.full_name, u.username, a.status as current_status FROM enrollments e JOIN users u ON u.id = e.user_id LEFT JOIN attendance a ON a.student_id = u.id AND a.section_id = $1 AND a.date = CURRENT_DATE WHERE e.section_id = $1`, [req.params.section_id]);
    res.render('faculty-attendance', { user: req.session.user, courses: coursesRes.rows, section: sectionRes.rows[0], students: studentsRes.rows, today: new Date().toISOString().slice(0, 10), hours: [1, 2, 3, 4] });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.post('/sis/faculty/attendance/:section_id', requireRole('teacher', 'advisor'), async (req, res) => {
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
  } catch (err) { res.status(500).send("Error saving attendance: " + err.message); }
});

app.get('/sis/faculty/grades', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const coursesRes = await pool.query(`SELECT s.id as section_id, c.code, c.title, s.group_name FROM course_sections s JOIN courses c ON c.id = s.course_id WHERE s.teacher_id = $1`, [req.session.user.id]);
    res.render('faculty-grades', { user: req.session.user, courses: coursesRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.get('/sis/faculty/grades/:section_id', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const sectionRes = await pool.query(`SELECT s.id, c.code, c.title, s.group_name FROM course_sections s JOIN courses c ON c.id = s.course_id WHERE s.id = $1 AND s.teacher_id = $2`, [req.params.section_id, req.session.user.id]);
    if (sectionRes.rows.length === 0) return res.redirect('/sis/faculty/grades');
    const studentsRes = await pool.query(`SELECT u.id as user_id, u.full_name, u.username, g.midterm_grade, g.final_grade, g.letter_grade, g.gpa_points, g.is_published FROM enrollments e JOIN users u ON u.id = e.user_id LEFT JOIN grades g ON g.student_id = u.id AND g.section_id = $1 WHERE e.section_id = $1`, [req.params.section_id]);
    res.render('faculty-grades-entry', { user: req.session.user, section: sectionRes.rows[0], students: studentsRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.post('/sis/faculty/grades/:section_id', requireRole('teacher', 'advisor'), async (req, res) => {
  const sectionId = req.params.section_id;
  try {
    const secInfoRes = await pool.query(`
      SELECT midterm_weight, final_weight, weights_locked
      FROM course_sections
      WHERE id = $1 AND teacher_id = $2
    `, [sectionId, req.session.user.id]);

    if (secInfoRes.rows.length === 0) return res.redirect('/sis/faculty/grades');

    const secInfo = secInfoRes.rows[0];
    const mw = Number(secInfo.midterm_weight) || 50;
    const fw = Number(secInfo.final_weight) || 50;

    let gradesSaved = 0;
    for (const key in req.body) {
      if (key.startsWith('midterm_')) {
        const studentId = key.split('_')[1];
        const midterm = Number(req.body[key]) || 0;
        const final = Number(req.body['final_' + studentId]) || 0;

        const total = (midterm * mw / 100) + (final * fw / 100);

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
          INSERT INTO grades (student_id, section_id, midterm_grade, final_grade, letter_grade, gpa_points, is_published) 
          VALUES ($1, $2, $3, $4, $5, $6, false) 
          ON CONFLICT (student_id, section_id) DO UPDATE 
          SET midterm_grade = EXCLUDED.midterm_grade, 
              final_grade = EXCLUDED.final_grade, 
              letter_grade = EXCLUDED.letter_grade, 
              gpa_points = EXCLUDED.gpa_points
        `, [studentId, sectionId, midterm, final, letter, gpa]);
        gradesSaved++;
      }
    }

    let lockMsg = '';
    if (gradesSaved > 0 && !secInfo.weights_locked) {
      await pool.query(`
        UPDATE course_sections
        SET weights_locked = true, weights_locked_at = NOW(), weights_locked_by = $1
        WHERE id = $2
      `, [req.session.user.id, sectionId]);
      lockMsg = ' Weights are now locked.';
    }

    req.flash('success', `Grades saved successfully using weights: Midterm ${mw}%, Final ${fw}%.${lockMsg}`);
    res.redirect('/sis/faculty/grades/' + sectionId);
  } catch (err) { res.status(500).send("Error saving grades: " + err.message); }
});

// ============================================
// --- ADMIN ROUTES ---
// ============================================
app.get('/sis/admin', requireRole('admin'), async (req, res) => {
  try {
    // 1. Basic Stats
    const studentsCount = await pool.query(`SELECT COUNT(*) FROM users WHERE role = 'student'`);
    const teachersCount = await pool.query(`SELECT COUNT(*) FROM users WHERE role = 'teacher'`);
    const coursesCount = await pool.query(`SELECT COUNT(*) FROM courses`);
    const pendingRegs = await pool.query(`SELECT COUNT(*) FROM course_registrations WHERE status = 'pending_advisor'`);
    const pendingDocs = await pool.query(`SELECT COUNT(*) FROM document_requests WHERE status = 'pending'`);

    // 2. Chart Data: Students by Faculty
    const facultyRes = await pool.query(`
      SELECT sp.class_level AS faculty, COUNT(*) AS count
      FROM users u
      JOIN student_profiles sp ON sp.user_id = u.id
      WHERE u.role = 'student'
      GROUP BY sp.class_level
      ORDER BY count DESC
    `);
    const facultyLabels = facultyRes.rows.map(r => r.faculty || 'General');
    const facultyData = facultyRes.rows.map(r => Number(r.count));

    // 3. Chart Data: Financials (Billed vs Paid)
    const finRes = await pool.query(`
      WITH StudentBilling AS (
        SELECT 
          u.id,
          COALESCE(fs.amount, 0) AS amount_billed,
          COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.student_id = u.id), 0) AS amount_paid
        FROM users u
        JOIN student_profiles sp ON sp.user_id = u.id
        LEFT JOIN fee_structure fs ON LOWER(fs.program) = LOWER(sp.class_level) AND fs.semester = sp.current_semester
        WHERE u.role = 'student'
      )
      SELECT SUM(amount_billed) AS total_billed, SUM(amount_paid) AS total_paid FROM StudentBilling
    `);
    
    const totalBilled = Number(finRes.rows[0].total_billed) || 0;
    const totalPaid = Number(finRes.rows[0].total_paid) || 0;
    const totalOutstanding = totalBilled - totalPaid;

        const targetedRes = await pool.query(`
      SELECT * FROM targeted_announcements 
      WHERE sender_id = $1 ORDER BY created_at DESC LIMIT 5
    `, [req.session.user.id]);

    res.render('admin-dashboard', { 
      user: req.session.user, 
      greeting: getGreeting(), 
      stats: { 
        students: studentsCount.rows[0].count, 
        teachers: teachersCount.rows[0].count, 
        courses: coursesCount.rows[0].count, 
        pending: pendingRegs.rows[0].count 
      },
      targetedMessages: targetedRes.rows
    });
  } catch (err) { res.status(500).send("Admin Error: " + err.message); }
});

app.get('/sis/admin/students', requireRole('admin'), async (req, res) => {
  try {
    const studentsRes = await pool.query(`SELECT u.id, u.full_name, u.username, u.email, sp.admission_number, sp.class_level, sp.current_semester, adv.full_name as advisor_name FROM users u LEFT JOIN student_profiles sp ON sp.user_id = u.id LEFT JOIN users adv ON adv.id = sp.advisor_id WHERE u.role = 'student' ORDER BY u.created_at DESC`);
    res.render('admin-students', { user: req.session.user, students: studentsRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.get('/sis/admin/students/new', requireRole('admin'), async (req, res) => {
  try {
    const advisorsRes = await pool.query(`SELECT id, full_name FROM users WHERE role = 'advisor'`);
    res.render('admin-student-new', { user: req.session.user, advisors: advisorsRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.post('/sis/admin/students/new', requireRole('admin'), async (req, res) => {
  const { full_name, username, email, class_level, advisor_id, admission_number, is_international, high_school_gpa } = req.body;
  const defaultPassword = 'Student2026!';
  const generatedId = admission_number || 'LUX-' + Math.floor(100000 + Math.random() * 900000);
  try {
    const userRes = await pool.query(`INSERT INTO users (full_name, username, email, password, role) VALUES ($1, $2, $3, $4, 'student') RETURNING id`, [full_name, username, email || username + '@luxmind.edu', defaultPassword]);
    const userId = userRes.rows[0].id;
    await pool.query(`INSERT INTO student_profiles (user_id, admission_number, class_level, current_semester, advisor_id, is_international, high_school_gpa) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [userId, generatedId, class_level || 'Computer Engineering', 1, advisor_id ? Number(advisor_id) : null, is_international === 'true', high_school_gpa ? Number(high_school_gpa) : null]);
    req.flash('success', `Student ${full_name} created! Password: ${defaultPassword}`);
    res.redirect('/sis/admin/students');
  } catch (err) {
    req.flash('error', 'Error creating student: ' + err.message);
    res.redirect('/sis/admin/students/new');
  }
});

app.get('/sis/admin/teachers', requireRole('admin'), async (req, res) => {
  try {
    const teachersRes = await pool.query(`SELECT id, full_name, username, email, created_at FROM users WHERE role = 'teacher' ORDER BY created_at DESC`);
    res.render('admin-teachers', { user: req.session.user, teachers: teachersRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.get('/sis/admin/teachers/new', requireRole('admin'), (req, res) => {
  res.render('admin-teacher-new', { user: req.session.user });
});

app.post('/sis/admin/teachers/new', requireRole('admin'), async (req, res) => {
  const { full_name, username, email } = req.body;
  const defaultPassword = 'Teacher2026!';
  try {
    await pool.query(`INSERT INTO users (full_name, username, email, password, role) VALUES ($1, $2, $3, $4, 'teacher')`, [full_name, username, email || username + '@luxmind.edu', defaultPassword]);
    req.flash('success', `Teacher ${full_name} created! Password: ${defaultPassword}`);
    res.redirect('/sis/admin/teachers');
  } catch (err) {
    req.flash('error', 'Error creating teacher: ' + err.message);
    res.redirect('/sis/admin/teachers/new');
  }
});



// ============================================
// --- ADMIN: COURSE CATALOG ---
// ============================================
app.get('/sis/admin/courses', requireRole('admin'), async (req, res) => {
  try {
    // Fetch all courses and their prerequisites
    const coursesRes = await pool.query(`
      SELECT c.*, p.code as prereq_code 
      FROM courses c
      LEFT JOIN courses p ON p.id = c.prerequisite_id
      ORDER BY c.semester_number ASC, c.code ASC
    `);
    res.render('admin-courses', { user: req.session.user, courses: coursesRes.rows });
  } catch (err) { res.status(500).send("Course Catalog Error: " + err.message); }
});

app.post('/sis/admin/courses/new', requireRole('admin'), async (req, res) => {
  const { code, title, credits, semester_number, prerequisite_id, quota } = req.body;
  try {
    await pool.query(`
      INSERT INTO courses (code, title, credits, semester_number, prerequisite_id, quota) 
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [code, title, Number(credits), Number(semester_number), prerequisite_id ? Number(prerequisite_id) : null, quota ? Number(quota) : 40]);
    req.flash('success', 'Course added successfully.');
    res.redirect('/sis/admin/courses');
  } catch (err) {
    req.flash('error', 'Error adding course: ' + err.message);
    res.redirect('/sis/admin/courses');
  }
});




app.get('/sis/admin/sections', requireRole('admin'), async (req, res) => {
  try {
    const coursesRes = await pool.query(`SELECT * FROM courses ORDER BY semester_number ASC, code ASC`);
    const sectionsRes = await pool.query(`SELECT s.*, u.full_name as teacher_name FROM course_sections s LEFT JOIN users u ON u.id = s.teacher_id`);
    const sectionsByCourse = {};
    sectionsRes.rows.forEach(sec => {
      if (!sectionsByCourse[sec.course_id]) sectionsByCourse[sec.course_id] = [];
      sectionsByCourse[sec.course_id].push(sec);
    });
    res.render('admin-sections', { user: req.session.user, courses: coursesRes.rows, sectionsByCourse: sectionsByCourse });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.get('/sis/admin/sections/:course_id/new', requireRole('admin'), async (req, res) => {
  try {
    const courseRes = await pool.query(`SELECT * FROM courses WHERE id = $1`, [req.params.course_id]);
    if (courseRes.rows.length === 0) return res.redirect('/sis/admin/sections');
    const teachersRes = await pool.query(`SELECT id, full_name FROM users WHERE role = 'teacher' ORDER BY full_name`);
    res.render('admin-section-new', { user: req.session.user, course: courseRes.rows[0], teachers: teachersRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.post('/sis/admin/sections/:course_id/new', requireRole('admin'), async (req, res) => {
  const courseId = Number(req.params.course_id);
  const { group_name, teacher_id, day_of_week, start_time, end_time, room, quota } = req.body;
  try {
    await pool.query(`INSERT INTO course_sections (course_id, group_name, teacher_id, day_of_week, start_time, end_time, room, max_capacity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [courseId, group_name, teacher_id ? Number(teacher_id) : null, day_of_week, start_time, end_time, room, quota ? Number(quota) : 40]);
    req.flash('success', 'New group created successfully.');
    res.redirect('/sis/admin/sections');
  } catch (err) {
    req.flash('error', 'Error creating group: ' + err.message);
    res.redirect('/sis/admin/sections/' + courseId + '/new');
  }
});

app.get('/sis/admin/registrations', requireRole('admin'), async (req, res) => {
  try {
    const registrationsRes = await pool.query(`SELECT cr.id, cr.status, cr.requested_at, u.full_name as student_name, u.username, c.code as course_code, c.title as course_title FROM course_registrations cr JOIN users u ON u.id = cr.student_id JOIN courses c ON c.id = cr.course_id ORDER BY cr.requested_at DESC`);
    res.render('admin-registrations', { user: req.session.user, registrations: registrationsRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.get('/sis/admin/finance', requireRole('admin'), async (req, res) => {
  try {
    const feesRes = await pool.query(`SELECT * FROM fee_structure ORDER BY program, semester`);
    const studentsRes = await pool.query(`SELECT u.id, u.full_name, u.username, sp.class_level, sp.current_semester FROM users u JOIN student_profiles sp ON sp.user_id = u.id WHERE u.role = 'student'`);
    const balances = [];
    for (const student of studentsRes.rows) {
      const matchingFee = feesRes.rows.find(f => f.program.toLowerCase().trim() === student.class_level.toLowerCase().trim() && Number(f.semester) === Number(student.current_semester));
      const totalFee = matchingFee ? Number(matchingFee.amount) : 0;
      const paidRes = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE student_id = $1`, [student.id]);
      const totalPaid = Number(paidRes.rows[0].total);
      balances.push({ ...student, total_fee: totalFee, total_paid: totalPaid, balance: totalFee - totalPaid });
    }
    res.render('admin-finance', { user: req.session.user, fees: feesRes.rows, balances });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.post('/sis/admin/finance/new', requireRole('admin'), async (req, res) => {
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

app.get('/sis/admin/documents', requireRole('admin'), async (req, res) => {
  try {
    const requestsRes = await pool.query(`SELECT dr.*, u.full_name as student_name, u.username FROM document_requests dr JOIN users u ON u.id = dr.student_id ORDER BY dr.requested_at DESC`);
    res.render('admin-documents', { user: req.session.user, requests: requestsRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.post('/sis/admin/documents/:id/status', requireRole('admin'), async (req, res) => {
  const { status, admin_notes } = req.body; 
  const requestId = req.params.id;
  try {
    await pool.query(`UPDATE document_requests SET status = $1, admin_notes = $2, seen_by_student = false WHERE id = $3`, [status, admin_notes || null, requestId]);
    const infoRes = await pool.query(`SELECT u.email, u.full_name, dr.document_type FROM document_requests dr JOIN users u ON u.id = dr.student_id WHERE dr.id = $1`, [requestId]);
    if (infoRes.rows.length > 0) {
      const s = infoRes.rows[0];
      const statusLabel = status === 'ready' ? 'APPROVED ✅' : 'REJECTED ❌';
      try {
        await resend.emails.send({
          from: 'LuxMind Registrar <onboarding@resend.dev>',
          to: s.email,
          subject: `LuxMind SIS - Document Request ${statusLabel}`,
          html: `<div style="font-family: Arial, sans-serif; padding: 20px; background: #f7fafd; border: 1px solid #d9e6f2; border-radius: 8px;"><h2 style="color: #0a1e32;">LuxMind University</h2><p>Dear <strong>${s.full_name}</strong>,</p><p>Your document request for <strong>${s.document_type}</strong> has been <strong style="color:${status === 'ready' ? 'green' : 'red'};">${statusLabel}</strong>.</p>${admin_notes ? `<p><strong>Message from the Registrar:</strong> ${admin_notes}</p>` : ''}<p>Please log in to your Student Portal to view and download your document.</p><a href="${process.env.APP_URL}/sis/my/documents" style="display: inline-block; padding: 12px 24px; background: #0a1e32; color: #fff; text-decoration: none; border-radius: 6px; margin-top: 15px;">Go to Student Portal</a></div>`
        });
      } catch (mailErr) { console.error('Resend API Error:', mailErr); }
    }
    req.flash('success', 'Request status updated and email sent.');
    res.redirect('/sis/admin/documents');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- ADMIN: EXAM PROGRAM ---
// ============================================
app.get('/sis/admin/exams', requireRole('admin'), async (req, res) => {
  try {
    const examsRes = await pool.query(`SELECT e.*, c.code, c.title FROM exams e JOIN courses c ON c.id = e.course_id ORDER BY e.exam_date ASC`);
    const coursesRes = await pool.query(`SELECT id, code, title FROM courses ORDER BY code`);
    res.render('admin-exams', { user: req.session.user, exams: examsRes.rows, courses: coursesRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.post('/sis/admin/exams/new', requireRole('admin'), async (req, res) => {
  const { course_id, exam_type, exam_date, start_time, room } = req.body;
  try {
    await pool.query(`INSERT INTO exams (course_id, exam_type, exam_date, start_time, room) VALUES ($1, $2, $3, $4, $5)`, [Number(course_id), exam_type, exam_date, start_time, room]);
    req.flash('success', 'Exam scheduled successfully.');
    res.redirect('/sis/admin/exams');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- STUDENT: EXAM PROGRAM ---
// ============================================
app.get('/sis/my/exams', requireRole('student'), async (req, res) => {
  try {
    const examsRes = await pool.query(`SELECT e.*, c.code, c.title FROM exams e JOIN courses c ON c.id = e.course_id JOIN enrollments en ON en.course_id = c.id WHERE en.user_id = $1 ORDER BY e.exam_date ASC`, [req.session.user.id]);
    res.render('student-exams', { user: req.session.user, exams: examsRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- STUDENT: EXAM RESULTS ---
// ============================================
app.get('/sis/my/exam-results', requireRole('student'), async (req, res) => {
  try {
    const resultsRes = await pool.query(`SELECT c.code, c.title, c.credits, g.midterm_grade, g.final_grade, g.letter_grade, g.gpa_points FROM grades g JOIN course_sections s ON s.id = g.section_id JOIN courses c ON c.id = s.course_id WHERE g.student_id = $1 AND g.is_published = true ORDER BY c.code ASC`, [req.session.user.id]);
    let totalPoints = 0;
    let totalCredits = 0;
    resultsRes.rows.forEach(r => {
      totalCredits += Number(r.credits);
      totalPoints += (Number(r.gpa_points) * Number(r.credits));
    });
    const semesterGPA = totalCredits > 0 ? (totalPoints / totalCredits).toFixed(2) : '0.00';
    res.render('student-exam-results', { user: req.session.user, results: resultsRes.rows, semesterGPA: semesterGPA });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- FACULTY: MY COURSES ---
// ============================================
app.get('/sis/faculty/courses', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const coursesRes = await pool.query(`SELECT s.id as section_id, c.id as course_id, c.code, c.title, c.credits, s.group_name, s.day_of_week, s.start_time, s.room, (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = s.id) as student_count FROM course_sections s JOIN courses c ON c.id = s.course_id WHERE s.teacher_id = $1`, [req.session.user.id]);
    res.render('faculty-courses', { user: req.session.user, courses: coursesRes.rows, greeting: getGreeting() });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- STUDENT: COURSE MATERIALS ---
// ============================================
app.get('/sis/my/materials', requireRole('student'), async (req, res) => {
  try {
    const sectionsRes = await pool.query(`
      SELECT s.id AS section_id, c.code, c.title, c.credits, s.group_name, u.full_name AS teacher_name
      FROM enrollments e
      JOIN course_sections s ON s.id = e.section_id
      JOIN courses c ON c.id = s.course_id
      LEFT JOIN users u ON u.id = s.teacher_id
      WHERE e.user_id = $1
      ORDER BY c.code ASC
    `, [req.session.user.id]);

    res.render('student-materials-hub', { 
      user: req.session.user, 
      sections: sectionsRes.rows,
      greeting: getGreeting()
    });
  } catch (err) { res.status(500).send("Materials Hub Error: " + err.message); }
});

app.get('/sis/my/materials/:section_id', requireRole('student'), async (req, res) => {
  try {
    const enrollCheck = await pool.query(`
      SELECT s.id, c.code, c.title, c.credits, s.group_name, s.moodle_url, u.full_name AS teacher_name
      FROM enrollments e
      JOIN course_sections s ON s.id = e.section_id
      JOIN courses c ON c.id = s.course_id
      LEFT JOIN users u ON u.id = s.teacher_id
      WHERE e.user_id = $1 AND s.id = $2
    `, [req.session.user.id, req.params.section_id]);

    if (enrollCheck.rows.length === 0) return res.redirect('/sis/my/materials');
    const section = enrollCheck.rows[0];

    const syllabusRes = await pool.query(`
      SELECT * FROM syllabus_versions WHERE section_id = $1 AND is_current = true LIMIT 1
    `, [req.params.section_id]);

    const notesRes = await pool.query(`
      SELECT * FROM course_materials WHERE section_id = $1 ORDER BY week_number ASC, uploaded_at DESC
    `, [req.params.section_id]);

    const notesByWeek = {};
    for (let i = 1; i <= 14; i++) notesByWeek[i] = [];
    notesRes.rows.forEach(n => {
      if (notesByWeek[n.week_number]) notesByWeek[n.week_number].push(n);
    });

    res.render('student-materials-detail', {
      user: req.session.user,
      section,
      syllabus: syllabusRes.rows[0] || null,
      notesByWeek,
      greeting: getGreeting()
    });
  } catch (err) { res.status(500).send("Materials Detail Error: " + err.message); }
});

// ============================================
// --- FACULTY: CLASS ROSTER ---
// ============================================
app.get('/sis/faculty/class-roster', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const sectionsRes = await pool.query(`
      SELECT 
        s.id AS section_id,
        c.code, c.title, c.credits,
        s.group_name,
        s.day_of_week, s.start_time, s.end_time, s.room,
        (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = s.id) AS student_count
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      WHERE s.teacher_id = $1
      ORDER BY c.code ASC, s.group_name ASC
    `, [req.session.user.id]);

    const totalStudents = sectionsRes.rows.reduce((sum, s) => sum + Number(s.student_count), 0);
    const totalCredits = sectionsRes.rows.reduce((sum, s) => sum + Number(s.credits), 0);

    res.render('faculty-class-roster', {
      user: req.session.user,
      sections: sectionsRes.rows,
      totalStudents,
      totalCredits,
      greeting: getGreeting()
    });
  } catch (err) { res.status(500).send("Class Roster Error: " + err.message); }
});

app.get('/sis/faculty/class-roster/:section_id', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const sectionRes = await pool.query(`
      SELECT s.id, c.code, c.title, c.credits, s.group_name,
             s.day_of_week, s.start_time, s.end_time, s.room
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      WHERE s.id = $1 AND s.teacher_id = $2
    `, [req.params.section_id, req.session.user.id]);

    if (sectionRes.rows.length === 0) return res.redirect('/sis/faculty/class-roster');

    const rosterRes = await pool.query(`
      SELECT 
        u.id AS user_id,
        u.full_name,
        u.email,
        sp.admission_number,
        sp.class_level,
        sp.current_semester,
        sp.phone,
        COUNT(DISTINCT CASE WHEN a.status = 'Present' THEN a.id END) AS present_count,
        COUNT(DISTINCT a.id) AS total_attendance,
        g.midterm_grade,
        g.final_grade,
        g.letter_grade,
        g.gpa_points
      FROM enrollments e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN student_profiles sp ON sp.user_id = u.id
      LEFT JOIN attendance a ON a.student_id = u.id AND a.section_id = e.section_id
      LEFT JOIN grades g ON g.student_id = u.id AND g.section_id = e.section_id
      WHERE e.section_id = $1
      GROUP BY u.id, u.full_name, u.email, sp.admission_number, sp.class_level,
               sp.current_semester, sp.phone, g.midterm_grade, g.final_grade,
               g.letter_grade, g.gpa_points
      ORDER BY u.full_name ASC
    `, [req.params.section_id]);

    const roster = rosterRes.rows.map(r => {
      const present = Number(r.present_count || 0);
      const total = Number(r.total_attendance || 0);
      return {
        ...r,
        attendance_pct: total > 0 ? Math.round((present / total) * 100) : null,
        present_count: present,
        total_attendance: total
      };
    });

    const withAttendance = roster.filter(r => r.attendance_pct !== null);
    const avgAttendance = withAttendance.length > 0
      ? Math.round(withAttendance.reduce((s, r) => s + r.attendance_pct, 0) / withAttendance.length)
      : null;
    const atRiskCount = roster.filter(r => r.attendance_pct !== null && r.attendance_pct < 70).length;
    const gradedCount = roster.filter(r => r.letter_grade).length;

    res.render('faculty-class-roster-detail', {
      user: req.session.user,
      section: sectionRes.rows[0],
      roster,
      avgAttendance,
      atRiskCount,
      gradedCount,
      greeting: getGreeting()
    });
  } catch (err) { res.status(500).send("Roster Detail Error: " + err.message); }
});

// ============================================
// --- FACULTY: PUBLISH GRADES ---
// ============================================
app.get('/sis/faculty/publish-results', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const sectionsRes = await pool.query(`
      SELECT s.id AS section_id, c.code, c.title, s.group_name,
             (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = s.id) AS student_count,
             (SELECT COUNT(*) FROM grades g WHERE g.section_id = s.id AND g.letter_grade IS NOT NULL) AS graded_count,
             (SELECT COUNT(*) FROM grades g WHERE g.section_id = s.id AND g.is_published = true AND g.letter_grade IS NOT NULL) AS published_count,
             (SELECT MAX(published_at) FROM grades g WHERE g.section_id = s.id AND g.is_published = true) AS last_published
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      WHERE s.teacher_id = $1
      ORDER BY c.code ASC, s.group_name ASC
    `, [req.session.user.id]);

    res.render('faculty-publish-results', { user: req.session.user, sections: sectionsRes.rows, greeting: getGreeting() });
  } catch (err) { res.status(500).send("Publish Hub Error: " + err.message); }
});

app.post('/sis/faculty/grades/:section_id/publish', requireRole('teacher', 'advisor'), async (req, res) => {
  const sectionId = req.params.section_id;
  try {
    const secRes = await pool.query(`SELECT id FROM course_sections WHERE id = $1 AND teacher_id = $2`, [sectionId, req.session.user.id]);
    if (secRes.rows.length === 0) return res.redirect('/sis/faculty/publish-results');

    // 1. Publish the grades
    await pool.query(`
      UPDATE grades 
      SET is_published = true, published_at = NOW() 
      WHERE section_id = $1 AND is_published = false
    `, [sectionId]);

    // 2. Fetch students in this section to email them
    const studentsRes = await pool.query(`
      SELECT u.email, u.full_name, c.code, c.title 
      FROM enrollments e
      JOIN users u ON u.id = e.user_id
      JOIN course_sections s ON s.id = e.section_id
      JOIN courses c ON c.id = s.course_id
      WHERE e.section_id = $1
    `, [sectionId]);

    // 3. Send emails in the background (don't block the redirect)
    if (studentsRes.rows.length > 0) {
      const course = studentsRes.rows[0];
      
      // Use Promise.all to send emails concurrently
      Promise.all(studentsRes.rows.map(student => {
        return resend.emails.send({
          from: 'LuxMind Registrar <onboarding@resend.dev>', // Use your verified domain in production
          to: student.email,
          subject: `Grades Published for ${course.code}`,
          html: `<div style="font-family: Arial, sans-serif; padding: 20px; background: #f7fafd; border: 1px solid #d9e6f2; border-radius: 8px;">
                  <h2 style="color: #0a1e32;">LuxMind University</h2>
                  <p>Dear <strong>${student.full_name}</strong>,</p>
                  <p>Your grades for <strong>${course.code} - ${course.title}</strong> have now been published.</p>
                  <p>Please log in to your Student Portal to view your results.</p>
                  <a href="${process.env.APP_URL}/sis/my/exam-results" style="display: inline-block; padding: 12px 24px; background: #0a1e32; color: #fff; text-decoration: none; border-radius: 6px; margin-top: 15px;">View Grades</a>
                 </div>`
        }).catch(err => console.error(`Failed to email ${student.email}:`, err));
      }));
    }

    req.flash('success', 'All grades for this section have been published, and students have been notified via email.');
    res.redirect('/sis/faculty/publish-results');
  } catch (err) { res.status(500).send("Publish Error: " + err.message); }
});

app.post('/sis/faculty/grades/:section_id/unpublish', requireRole('teacher', 'advisor'), async (req, res) => {
  const sectionId = req.params.section_id;
  try {
    const secRes = await pool.query(`SELECT id FROM course_sections WHERE id = $1 AND teacher_id = $2`, [sectionId, req.session.user.id]);
    if (secRes.rows.length === 0) return res.redirect('/sis/faculty/publish-results');

    await pool.query(`
      UPDATE grades 
      SET is_published = false, published_at = NULL 
      WHERE section_id = $1
    `, [sectionId]);

    req.flash('success', 'Grades unpublished. Students can no longer see them until re-published.');
    res.redirect('/sis/faculty/publish-results');
  } catch (err) { res.status(500).send("Unpublish Error: " + err.message); }
});

app.get('/sis/faculty/course-weights', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const sectionsRes = await pool.query(`
      SELECT 
        s.id AS section_id,
        c.code, c.title, c.credits,
        s.group_name,
        s.midterm_weight, s.final_weight,
        s.weights_locked, s.weights_locked_at,
        (SELECT COUNT(*) FROM grades g WHERE g.section_id = s.id AND g.letter_grade IS NOT NULL) AS grade_count,
        (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = s.id) AS student_count
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      WHERE s.teacher_id = $1
      ORDER BY c.code ASC, s.group_name ASC
    `, [req.session.user.id]);

    const stats = {
      total: sectionsRes.rows.length,
      locked: sectionsRes.rows.filter(r => r.weights_locked).length,
      unlocked: sectionsRes.rows.filter(r => !r.weights_locked).length,
      custom: sectionsRes.rows.filter(r => Number(r.midterm_weight) !== 50 || Number(r.final_weight) !== 50).length
    };

    res.render('faculty-course-weights', {
      user: req.session.user,
      sections: sectionsRes.rows,
      stats,
      greeting: getGreeting()
    });
  } catch (err) { res.status(500).send("Weights Hub Error: " + err.message); }
});

app.get('/sis/faculty/course-weights/:section_id', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const sectionRes = await pool.query(`
      SELECT s.id, c.code, c.title, c.credits, s.group_name,
             s.midterm_weight, s.final_weight,
             s.weights_locked, s.weights_locked_at,
             (SELECT COUNT(*) FROM grades g WHERE g.section_id = s.id AND g.letter_grade IS NOT NULL) AS grade_count,
             (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = s.id) AS student_count,
             u.full_name AS locked_by_name
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      LEFT JOIN users u ON u.id = s.weights_locked_by
      WHERE s.id = $1 AND s.teacher_id = $2
    `, [req.params.section_id, req.session.user.id]);

    if (sectionRes.rows.length === 0) return res.redirect('/sis/faculty/course-weights');
    const section = sectionRes.rows[0];

    const auditRes = await pool.query(`
      SELECT a.*, u.full_name AS changed_by_name
      FROM weight_audit_log a
      JOIN users u ON u.id = a.changed_by
      WHERE a.section_id = $1
      ORDER BY a.changed_at DESC
      LIMIT 10
    `, [req.params.section_id]);

    const distRes = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE letter_grade IN ('A+','A','A-')) AS a_count,
        COUNT(*) FILTER (WHERE letter_grade IN ('B+','B','B-')) AS b_count,
        COUNT(*) FILTER (WHERE letter_grade IN ('C+','C','C-')) AS c_count,
        COUNT(*) FILTER (WHERE letter_grade IN ('D+','D','D-')) AS d_count,
        COUNT(*) FILTER (WHERE letter_grade = 'F') AS f_count,
        COUNT(*) FILTER (WHERE letter_grade IS NOT NULL) AS total_graded
      FROM grades
      WHERE section_id = $1
    `, [req.params.section_id]);

    res.render('faculty-course-weights-detail', {
      user: req.session.user,
      section,
      audit: auditRes.rows,
      distribution: distRes.rows[0],
      greeting: getGreeting()
    });
  } catch (err) { res.status(500).send("Weights Detail Error: " + err.message); }
});

app.post('/sis/faculty/course-weights/:section_id', requireRole('teacher', 'advisor'), async (req, res) => {
  const sectionId = req.params.section_id;

  try {
    const sectionRes = await pool.query(`
      SELECT s.midterm_weight, s.final_weight, s.weights_locked,
             (SELECT COUNT(*) FROM grades g WHERE g.section_id = s.id AND g.letter_grade IS NOT NULL) AS grade_count
      FROM course_sections s
      WHERE s.id = $1 AND s.teacher_id = $2
    `, [sectionId, req.session.user.id]);

    if (sectionRes.rows.length === 0) return res.redirect('/sis/faculty/course-weights');
    const section = sectionRes.rows[0];

    if (section.weights_locked) {
      req.flash('error', 'Weights are locked because grades have been entered. Contact the registrar to unlock.');
      return res.redirect('/sis/faculty/course-weights/' + sectionId);
    }

    if (Number(section.grade_count) > 0) {
      await pool.query(`
        UPDATE course_sections
        SET weights_locked = true, weights_locked_at = NOW(), weights_locked_by = $1
        WHERE id = $2
      `, [req.session.user.id, sectionId]);
      req.flash('error', 'Weights auto-locked because grades exist. Contact the registrar to unlock.');
      return res.redirect('/sis/faculty/course-weights/' + sectionId);
    }

    const midtermWeight = Number(req.body.midterm_weight);
    const finalWeight = Number(req.body.final_weight);

    if (!Number.isInteger(midtermWeight) || !Number.isInteger(finalWeight) ||
        midtermWeight < 0 || finalWeight < 0 ||
        midtermWeight > 100 || finalWeight > 100) {
      req.flash('error', 'Weights must be whole numbers between 0 and 100.');
      return res.redirect('/sis/faculty/course-weights/' + sectionId);
    }

    if (midtermWeight + finalWeight !== 100) {
      req.flash('error', `Weights must sum to exactly 100%. You entered ${midtermWeight} + ${finalWeight} = ${midtermWeight + finalWeight}%.`);
      return res.redirect('/sis/faculty/course-weights/' + sectionId);
    }

    await pool.query(`
      UPDATE course_sections
      SET midterm_weight = $1, final_weight = $2
      WHERE id = $3
    `, [midtermWeight, finalWeight, sectionId]);

    await pool.query(`
      INSERT INTO weight_audit_log (section_id, changed_by, old_midterm, old_final, new_midterm, new_final, reason)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [sectionId, req.session.user.id, section.midterm_weight, section.final_weight, midtermWeight, finalWeight, req.body.reason || null]);

    req.flash('success', `Weights updated to Midterm ${midtermWeight}% / Final ${finalWeight}%.`);
    res.redirect('/sis/faculty/course-weights/' + sectionId);
  } catch (err) { res.status(500).send("Save Weights Error: " + err.message); }
});

// ============================================
// --- FACULTY: PROFILE & PASSWORD ---
// ============================================
app.get('/sis/faculty/profile', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const profileRes = await pool.query(`
      SELECT u.id, u.full_name, u.email, u.username, u.role, 
             u.profile_picture_url, u.phone, u.office_hours, u.bio, u.cv_url
      FROM users u WHERE u.id = $1
    `, [req.session.user.id]);
    
    if (profileRes.rows.length === 0) return res.redirect('/login');
    res.render('faculty-profile', { user: profileRes.rows[0], greeting: getGreeting() });
  } catch (err) { res.status(500).send("Profile Error: " + err.message); }
});

app.post('/sis/faculty/profile', requireRole('teacher', 'advisor'), upload.single('profile_picture'), async (req, res) => {
  const { phone, office_hours, bio, cv_url } = req.body;
  
  try {
    let updateQuery = `UPDATE users SET phone = $1, office_hours = $2, bio = $3, cv_url = $4 WHERE id = $5`;
    let queryParams = [phone, office_hours, bio, cv_url, req.session.user.id];

    if (req.file) {
      const b64 = req.file.buffer.toString('base64');
      const mime = req.file.mimetype;
      const dataUrl = `data:${mime};base64,${b64}`;
      updateQuery = `UPDATE users SET phone = $1, office_hours = $2, bio = $3, cv_url = $4, profile_picture_url = $5 WHERE id = $6`;
      queryParams = [phone, office_hours, bio, cv_url, dataUrl, req.session.user.id];
      
      req.session.user.profile_picture_url = dataUrl;
    }

    await pool.query(updateQuery, queryParams);
    req.flash('success', 'Profile updated successfully.');
    res.redirect('/sis/faculty/profile');
  } catch (err) { res.status(500).send("Update Profile Error: " + err.message); }
});

app.post('/sis/faculty/change-password', requireRole('teacher', 'advisor'), async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;

  try {
    if (new_password !== confirm_password) {
      req.flash('error', 'New passwords do not match.');
      return res.redirect('/sis/faculty/profile#security');
    }
    if (new_password.length < 8) {
      req.flash('error', 'New password must be at least 8 characters.');
      return res.redirect('/sis/faculty/profile#security');
    }

    const userRes = await pool.query(`SELECT password FROM users WHERE id = $1`, [req.session.user.id]);
    if (userRes.rows[0].password !== current_password) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect('/sis/faculty/profile#security');
    }

    await pool.query(`UPDATE users SET password = $1 WHERE id = $2`, [new_password, req.session.user.id]);
    req.flash('success', 'Password changed successfully.');
    res.redirect('/sis/faculty/profile#security');
  } catch (err) { res.status(500).send("Password Error: " + err.message); }
});

// ============================================
// --- FACULTY: CONTENT & MATERIALS DETAIL ---
// ============================================
app.get('/sis/faculty/course-materials/:section_id', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const sectionRes = await pool.query(`
      SELECT s.id, c.code, c.title, c.credits, s.group_name, s.moodle_url,
             (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = s.id) as student_count
      FROM course_sections s JOIN courses c ON c.id = s.course_id
      WHERE s.id = $1 AND s.teacher_id = $2
    `, [req.params.section_id, req.session.user.id]);

    if (sectionRes.rows.length === 0) return res.redirect('/sis/faculty/course-materials');

    const syllabusRes = await pool.query(`
      SELECT * FROM syllabus_versions WHERE section_id = $1 ORDER BY version_number DESC
    `, [req.params.section_id]);

    const notesRes = await pool.query(`
      SELECT * FROM course_materials WHERE section_id = $1 ORDER BY week_number ASC, uploaded_at DESC
    `, [req.params.section_id]);
    
    const notesByWeek = {};
    for (let i = 1; i <= 14; i++) notesByWeek[i] = [];
    notesRes.rows.forEach(n => {
      if (notesByWeek[n.week_number]) notesByWeek[n.week_number].push(n);
    });

    res.render('faculty-materials-detail', {
      user: req.session.user,
      section: sectionRes.rows[0],
      syllabus: syllabusRes.rows,
      notesByWeek
    });
  } catch (err) { res.status(500).send("Materials Error: " + err.message); }
});

app.post('/sis/faculty/course-materials/:section_id/syllabus', requireRole('teacher', 'advisor'), upload.single('syllabus'), async (req, res) => {
  const sectionId = req.params.section_id;
  try {
    if (!req.file) {
      req.flash('error', 'Please select a file to upload.');
      return res.redirect('/sis/faculty/course-materials/' + sectionId);
    }

    const fileExt = req.file.originalname.split('.').pop();
    const fileName = `syllabus/${sectionId}_${Date.now()}.${fileExt}`;
    
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('course-materials')
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = supabase.storage.from('course-materials').getPublicUrl(fileName);

    const vRes = await pool.query(`SELECT MAX(version_number) as max_v FROM syllabus_versions WHERE section_id = $1`, [sectionId]);
    const nextVersion = (vRes.rows[0].max_v || 0) + 1;

    await pool.query(`UPDATE syllabus_versions SET is_current = false WHERE section_id = $1`, [sectionId]);

    await pool.query(`
      INSERT INTO syllabus_versions (section_id, version_number, file_name, file_type, file_url, uploaded_by, is_current)
      VALUES ($1, $2, $3, $4, $5, $6, true)
    `, [sectionId, nextVersion, req.file.originalname, req.file.mimetype, publicUrl, req.session.user.id]);

    req.flash('success', `Syllabus Version ${nextVersion} uploaded successfully!`);
    res.redirect('/sis/faculty/course-materials/' + sectionId);
  } catch (err) { res.status(500).send("Syllabus Upload Error: " + err.message); }
});

app.post('/sis/faculty/course-materials/:section_id/notes', requireRole('teacher', 'advisor'), upload.single('material'), async (req, res) => {
  const sectionId = req.params.section_id;
  const { week_number, title } = req.body;
  try {
    if (!req.file) {
      req.flash('error', 'Please select a file to upload.');
      return res.redirect('/sis/faculty/course-materials/' + sectionId);
    }
    
    const fileExt = req.file.originalname.split('.').pop();
    const fileName = `notes/${sectionId}_week${week_number}_${Date.now()}.${fileExt}`;
    
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('course-materials')
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = supabase.storage.from('course-materials').getPublicUrl(fileName);

    await pool.query(`
      INSERT INTO course_materials (section_id, week_number, title, file_name, file_type, file_url, uploaded_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [sectionId, Number(week_number), title, req.file.originalname, req.file.mimetype, publicUrl, req.session.user.id]);

    req.flash('success', 'Lecture material uploaded successfully!');
    res.redirect('/sis/faculty/course-materials/' + sectionId);
  } catch (err) { res.status(500).send("Note Upload Error: " + err.message); }
});

app.post('/sis/faculty/course-materials/:section_id/moodle', requireRole('teacher', 'advisor'), async (req, res) => {
  const { moodle_url } = req.body;
  try {
    await pool.query(`UPDATE course_sections SET moodle_url = $1 WHERE id = $2`, [moodle_url, req.params.section_id]);
    req.flash('success', 'Moodle link updated successfully!');
    res.redirect('/sis/faculty/course-materials/' + req.params.section_id);
  } catch (err) { res.status(500).send("Moodle Update Error: " + err.message); }
});

app.get('/sis/faculty/course-materials', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const sectionsRes = await pool.query(`
      SELECT 
        s.id AS section_id,
        c.id AS course_id,
        c.code, c.title, c.credits,
        c.syllabus_url, c.moodle_url,
        s.group_name,
        s.day_of_week, s.start_time, s.room,
        (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = s.id) AS student_count
      FROM course_sections s
      JOIN courses c ON c.id = s.course_id
      WHERE s.teacher_id = $1
      ORDER BY c.code ASC, s.group_name ASC
    `, [req.session.user.id]);

    const rows = sectionsRes.rows;
    const stats = {
      total: rows.length,
      withSyllabus: rows.filter(r => r.syllabus_url).length,
      withMoodle: rows.filter(r => r.moodle_url).length,
      needsAttention: rows.filter(r => !r.syllabus_url || !r.moodle_url).length
    };

    res.render('faculty-course-materials-hub', {
      user: req.session.user,
      sections: rows,
      stats,
      greeting: getGreeting()
    });
  } catch (err) { res.status(500).send("Materials Hub Error: " + err.message); }
});

// ============================================
// --- FACULTY: ATTENDANCE HISTORY ---
// ============================================
app.get('/sis/faculty/attendance-history/:section_id', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const sectionRes = await pool.query(`SELECT s.id, c.code, c.title, s.group_name FROM course_sections s JOIN courses c ON c.id = s.course_id WHERE s.id = $1 AND s.teacher_id = $2`, [req.params.section_id, req.session.user.id]);
    if (sectionRes.rows.length === 0) return res.redirect('/sis/faculty/courses');
    const historyRes = await pool.query(`SELECT date, COUNT(CASE WHEN status = 'Present' THEN 1 END) as present_count, COUNT(CASE WHEN status = 'Absent' THEN 1 END) as absent_count, COUNT(CASE WHEN status = 'Late' THEN 1 END) as late_count, COUNT(*) as total_students FROM attendance WHERE section_id = $1 GROUP BY date ORDER BY date DESC`, [req.params.section_id]);
    res.render('faculty-attendance-history', { user: req.session.user, section: sectionRes.rows[0], history: historyRes.rows, greeting: getGreeting() });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.get('/sis/faculty/attendance-history/:section_id/:date', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const sectionRes = await pool.query(`SELECT s.id, c.code, c.title, s.group_name FROM course_sections s JOIN courses c ON c.id = s.course_id WHERE s.id = $1 AND s.teacher_id = $2`, [req.params.section_id, req.session.user.id]);
    if (sectionRes.rows.length === 0) return res.redirect('/sis/faculty/courses');
    const rosterRes = await pool.query(`SELECT u.full_name, u.username, a.status FROM attendance a JOIN users u ON u.id = a.student_id WHERE a.section_id = $1 AND a.date = $2 ORDER BY u.full_name ASC`, [req.params.section_id, req.params.date]);
    res.render('faculty-attendance-detail', { user: req.session.user, section: sectionRes.rows[0], roster: rosterRes.rows, date: req.params.date, greeting: getGreeting() });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- FACULTY: GRADE DISTRIBUTION ---
// ============================================
app.get('/sis/faculty/grades/:section_id/summary', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const sectionRes = await pool.query(`SELECT s.id, c.code, c.title, s.group_name FROM course_sections s JOIN courses c ON c.id = s.course_id WHERE s.id = $1 AND s.teacher_id = $2`, [req.params.section_id, req.session.user.id]);
    if (sectionRes.rows.length === 0) return res.redirect('/sis/faculty/courses');
    const distRes = await pool.query(`SELECT letter_grade, COUNT(*) as count FROM grades WHERE section_id = $1 AND letter_grade IS NOT NULL GROUP BY letter_grade`, [req.params.section_id]);
    const distribution = { 'A+': 0, 'A': 0, 'A-': 0, 'B+': 0, 'B': 0, 'B-': 0, 'C+': 0, 'C': 0, 'C-': 0, 'D+': 0, 'D': 0, 'D-': 0, 'F': 0 };
    distRes.rows.forEach(row => { if (distribution[row.letter_grade] !== undefined) distribution[row.letter_grade] = Number(row.count); });
    res.render('faculty-grades-summary', { user: req.session.user, section: sectionRes.rows[0], distribution: distribution, greeting: getGreeting() });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- FACULTY: CLASS ANNOUNCEMENTS ---
// ============================================
app.get('/sis/faculty/announcements', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const annRes = await pool.query(`SELECT a.*, c.code, c.title, s.group_name FROM course_announcements a JOIN course_sections s ON s.id = a.section_id JOIN courses c ON c.id = s.course_id WHERE a.teacher_id = $1 ORDER BY a.created_at DESC`, [req.session.user.id]);
    res.render('faculty-announcements', { user: req.session.user, announcements: annRes.rows, greeting: getGreeting() });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.get('/sis/faculty/announcements/new', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const coursesRes = await pool.query(`SELECT s.id as section_id, c.code, c.title, s.group_name FROM course_sections s JOIN courses c ON c.id = s.course_id WHERE s.teacher_id = $1`, [req.session.user.id]);
    res.render('faculty-announcement-new', { user: req.session.user, courses: coursesRes.rows, greeting: getGreeting() });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.post('/sis/faculty/announcements/new', requireRole('teacher', 'advisor'), async (req, res) => {
  const { section_id, title, message } = req.body;
  try {
    await pool.query(`INSERT INTO course_announcements (section_id, teacher_id, title, message) VALUES ($1, $2, $3, $4)`, [Number(section_id), req.session.user.id, title, message]);
    req.flash('success', 'Announcement posted successfully.');
    res.redirect('/sis/faculty/announcements');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- STUDENT: ANNOUNCEMENTS PAGE ---
// ============================================
app.get('/sis/my/announcements', requireRole('student'), async (req, res) => {
  try {
    const annRes = await pool.query(`SELECT a.*, c.code as course_code, c.title as course_title, u.full_name as teacher_name FROM course_announcements a JOIN course_sections s ON s.id = a.section_id JOIN courses c ON c.id = s.course_id JOIN users u ON u.id = a.teacher_id JOIN enrollments e ON e.section_id = s.id WHERE e.user_id = $1 ORDER BY a.created_at DESC`, [req.session.user.id]);
    res.render('student-announcements', { user: req.session.user, announcements: annRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- MESSAGING SYSTEM ---
// ============================================

// 1. Teacher: View Inbox & List of Students to Message
app.get('/sis/faculty/messages', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const inboxRes = await pool.query(`
      SELECT m.*, u.full_name as sender_name
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.receiver_id = $1
      ORDER BY m.created_at DESC
    `, [req.session.user.id]);

    const studentsRes = await pool.query(`
      SELECT DISTINCT u.id, u.full_name, c.code, s.group_name
      FROM enrollments e
      JOIN course_sections s ON s.id = e.section_id
      JOIN courses c ON c.id = s.course_id
      JOIN users u ON u.id = e.user_id
      WHERE s.teacher_id = $1
      ORDER BY u.full_name
    `, [req.session.user.id]);

    res.render('faculty-messages', { 
      user: req.session.user, 
      inbox: inboxRes.rows, 
      students: studentsRes.rows,
      greeting: getGreeting()
    });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 2. Teacher: Send Message
app.post('/sis/faculty/messages/send', requireRole('teacher', 'advisor'), async (req, res) => {
  const { receiver_id, subject, body } = req.body;
  try {
    await pool.query(`
      INSERT INTO messages (sender_id, receiver_id, subject, body)
      VALUES ($1, $2, $3, $4)
    `, [req.session.user.id, Number(receiver_id), subject, body]);
    req.flash('success', 'Message sent successfully.');
    res.redirect('/sis/faculty/messages');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 3. Student: View Inbox
app.get('/sis/my/messages', requireRole('student'), async (req, res) => {
  try {
    await pool.query(`UPDATE messages SET is_read = true WHERE receiver_id = $1`, [req.session.user.id]);
    
    const inboxRes = await pool.query(`
      SELECT m.*, u.full_name as sender_name
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.receiver_id = $1
      ORDER BY m.created_at DESC
    `, [req.session.user.id]);

    res.render('student-messages', { 
      user: req.session.user, 
      inbox: inboxRes.rows 
    });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 4. Student: Reply to Message
app.post('/sis/my/messages/reply', requireRole('student'), async (req, res) => {
  const { receiver_id, subject, body } = req.body;
  try {
    await pool.query(`
      INSERT INTO messages (sender_id, receiver_id, subject, body)
      VALUES ($1, $2, $3, $4)
    `, [req.session.user.id, Number(receiver_id), `Re: ${subject}`, body]);
    req.flash('success', 'Reply sent successfully.');
    res.redirect('/sis/my/messages');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- ADMIN: GLOBAL ANNOUNCEMENTS ---
// ============================================

// 1. Admin View & Create

app.post('/sis/announcements/send-targeted', requireRole('rectorate', 'admin'), async (req, res) => {
  const { target_role, title, message, redirect_to } = req.body;
  try {
    await pool.query(`
      INSERT INTO targeted_announcements (sender_id, target_role, title, message)
      VALUES ($1, $2, $3, $4)
    `, [req.session.user.id, target_role, title, message]);

    req.flash('success', 'Targeted announcement sent successfully.');
    res.redirect(redirect_to || '/sis/rectorate');
  } catch (err) { res.status(500).send("Targeted Announcement Error: " + err.message); }
});





app.get('/sis/admin/announcements', requireRole('admin'), async (req, res) => {
  try {
    const annRes = await pool.query(`SELECT * FROM global_announcements ORDER BY created_at DESC`);
    res.render('admin-announcements', { user: req.session.user, announcements: annRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.post('/sis/admin/announcements/new', requireRole('admin'), async (req, res) => {
  const { title, message } = req.body;
  try {
    await pool.query(`INSERT INTO global_announcements (title, message) VALUES ($1, $2)`, [title, message]);
    req.flash('success', 'Global announcement posted successfully.');
    res.redirect('/sis/admin/announcements');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- STUDENT/TEACHER: READ GLOBAL ANNOUNCEMENTS ---
// ============================================
app.get('/sis/announcements', requireLogin, async (req, res) => {
  try {
    const annRes = await pool.query(`SELECT * FROM global_announcements ORDER BY created_at DESC`);
    res.render('global-announcements', { user: req.session.user, announcements: annRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- COURSE WITHDRAWAL SYSTEM ---
// ============================================

// 1. Student View & Request Form
app.get('/sis/my/withdrawal', requireRole('student'), async (req, res) => {
  try {
    const enrolledRes = await pool.query(`
      SELECT c.id, c.code, c.title 
      FROM enrollments e
      JOIN courses c ON c.id = e.course_id
      WHERE e.user_id = $1
    `, [req.session.user.id]);

    const requestsRes = await pool.query(`
      SELECT w.*, c.code, c.title 
      FROM course_withdrawals w
      JOIN courses c ON c.id = w.course_id
      WHERE w.student_id = $1
      ORDER BY w.requested_at DESC
    `, [req.session.user.id]);

    res.render('student-withdrawal', { 
      user: req.session.user, 
      enrolled: enrolledRes.rows, 
      requests: requestsRes.rows 
    });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 2. Student Submit Request
app.post('/sis/my/withdrawal/request', requireRole('student'), async (req, res) => {
  const { course_id, reason } = req.body;
  try {
    const existing = await pool.query(`SELECT id FROM course_withdrawals WHERE student_id = $1 AND course_id = $2 AND status = 'pending'`, [req.session.user.id, Number(course_id)]);
    if (existing.rows.length > 0) {
      req.flash('error', 'You already have a pending request for this course.');
      return res.redirect('/sis/my/withdrawal');
    }
    await pool.query(`
      INSERT INTO course_withdrawals (student_id, course_id, reason) 
      VALUES ($1, $2, $3)
    `, [req.session.user.id, Number(course_id), reason]);
    
    req.flash('success', 'Withdrawal request submitted to your Advisor.');
    res.redirect('/sis/my/withdrawal');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 3. Advisor View Requests
app.get('/sis/advisor/withdrawals', requireRole('advisor', 'admin'), async (req, res) => {
  try {
    const requestsRes = await pool.query(`
      SELECT w.*, c.code, c.title, u.full_name as student_name, u.username
      FROM course_withdrawals w
      JOIN courses c ON c.id = w.course_id
      JOIN users u ON u.id = w.student_id
      WHERE w.status = 'pending'
      ORDER BY w.requested_at ASC
    `);
    res.render('advisor-withdrawals', { user: req.session.user, requests: requestsRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 4. Advisor Approve Request
app.post('/sis/advisor/withdrawals/:id/approve', requireRole('advisor', 'admin'), async (req, res) => {
  const requestId = req.params.id;
  try {
    const reqRes = await pool.query(`SELECT student_id, course_id FROM course_withdrawals WHERE id = $1`, [requestId]);
    const { student_id, course_id } = reqRes.rows[0];

    await pool.query(`DELETE FROM enrollments WHERE user_id = $1 AND course_id = $2`, [student_id, course_id]);
    await pool.query(`UPDATE course_withdrawals SET status = 'approved', reviewed_at = NOW() WHERE id = $1`, [requestId]);
    
    req.flash('success', 'Withdrawal approved. Student has been dropped from the course.');
    res.redirect('/sis/advisor/withdrawals');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 5. Advisor Reject Request
app.post('/sis/advisor/withdrawals/:id/reject', requireRole('advisor', 'admin'), async (req, res) => {
  try {
    await pool.query(`UPDATE course_withdrawals SET status = 'rejected', reviewed_at = NOW() WHERE id = $1`, [req.params.id]);
    req.flash('error', 'Withdrawal request rejected.');
    res.redirect('/sis/advisor/withdrawals');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- STUDENT: MY CURRICULUM ---
// ============================================
app.get('/sis/my/curriculum', requireRole('student'), async (req, res) => {
  try {
    const profileRes = await pool.query(`SELECT class_level FROM student_profiles WHERE user_id = $1`, [req.session.user.id]);
    const level = profileRes.rows[0]?.class_level || 'Computer Engineering';

    const currRes = await pool.query(`
      SELECT * FROM curriculum 
      WHERE program_level = $1 
      ORDER BY semester_number, course_name
    `, [level]);

    const passedRes = await pool.query(`
      SELECT c.title, c.credits 
      FROM grades g 
      JOIN course_sections s ON s.id = g.section_id
      JOIN courses c ON c.id = s.course_id
      WHERE g.student_id = $1 AND g.letter_grade NOT IN ('F', 'N/A', NULL)
    `, [req.session.user.id]);

    const enrolledRes = await pool.query(`
      SELECT c.title, c.credits 
      FROM enrollments e
      JOIN courses c ON c.id = e.course_id
      WHERE e.user_id = $1
    `, [req.session.user.id]);

    let totalCredits = 0;
    let earnedCredits = 0;
    
    const curriculum = currRes.rows.map(curr => {
      totalCredits += Number(curr.credits);
      
      const isPassed = passedRes.rows.some(p => p.title.toLowerCase() === curr.course_name.toLowerCase());
      const isEnrolled = enrolledRes.rows.some(e => e.title.toLowerCase() === curr.course_name.toLowerCase());
      
      if (isPassed) earnedCredits += Number(curr.credits);

      let status = 'not_taken';
      if (isPassed) status = 'passed';
      else if (isEnrolled) status = 'enrolled';

      return { ...curr, status };
    });

    const bySem = {};
    for (let i = 1; i <= 8; i++) bySem[i] = [];
    curriculum.forEach(c => {
      const sem = c.semester_number || 1;
      if (bySem[sem]) bySem[sem].push(c);
    });

    res.render('my-curriculum', {
      user: req.session.user,
      curriculum: bySem,
      totalCredits,
      earnedCredits,
      progress: totalCredits > 0 ? Math.round((earnedCredits / totalCredits) * 100) : 0
    });
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// ============================================
// --- EXAM OBJECTION SYSTEM ---
// ============================================

// 1. Student: View Objections Page
app.get('/sis/my/exam-objections', requireRole('student'), async (req, res) => {
  try {
    const gradedRes = await pool.query(`
      SELECT DISTINCT c.id, c.code, c.title, s.id as section_id, g.letter_grade, g.final_grade
      FROM grades g
      JOIN course_sections s ON s.id = g.section_id
      JOIN courses c ON c.id = s.course_id
      WHERE g.student_id = $1 AND g.is_published = true
    `, [req.session.user.id]);

    const objRes = await pool.query(`
      SELECT o.*, c.code, c.title, u.full_name as teacher_name
      FROM exam_objections o
      JOIN course_sections s ON s.id = o.section_id
      JOIN courses c ON c.id = s.course_id
      JOIN users u ON u.id = s.teacher_id
      WHERE o.student_id = $1
      ORDER BY o.requested_at DESC
    `, [req.session.user.id]);

    res.render('student-exam-objections', {
      user: req.session.user,
      graded: gradedRes.rows,
      objections: objRes.rows
    });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 2. Student: Submit Objection
app.post('/sis/my/exam-objections/new', requireRole('student'), async (req, res) => {
  const { section_id, reason } = req.body;
  try {
    const existing = await pool.query(`
      SELECT id FROM exam_objections 
      WHERE student_id = $1 AND section_id = $2 AND status = 'pending'
    `, [req.session.user.id, Number(section_id)]);
    if (existing.rows.length > 0) {
      req.flash('error', 'You already have a pending objection for this course.');
      return res.redirect('/sis/my/exam-objections');
    }

    await pool.query(`
      INSERT INTO exam_objections (student_id, section_id, reason) 
      VALUES ($1, $2, $3)
    `, [req.session.user.id, Number(section_id), reason]);
    
    req.flash('success', 'Objection submitted to your teacher for review.');
    res.redirect('/sis/my/exam-objections');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 3. Teacher: View Objections
app.get('/sis/faculty/exam-objections', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const objRes = await pool.query(`
      SELECT o.*, c.code, c.title, u.full_name as student_name, u.username,
             g.midterm_grade, g.final_grade, g.letter_grade
      FROM exam_objections o
      JOIN course_sections s ON s.id = o.section_id
      JOIN courses c ON c.id = s.course_id
      JOIN users u ON u.id = o.student_id
      LEFT JOIN grades g ON g.student_id = o.student_id AND g.section_id = o.section_id
      WHERE s.teacher_id = $1 AND o.status = 'pending'
      ORDER BY o.requested_at ASC
    `, [req.session.user.id]);
    res.render('faculty-exam-objections', { user: req.session.user, objections: objRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 4. Teacher: Resolve (Correct or Dismiss)
app.post('/sis/faculty/exam-objections/:id/resolve', requireRole('teacher', 'advisor'), async (req, res) => {
  const objectionId = req.params.id;
  const { action, new_final_grade, new_midterm_grade, teacher_response } = req.body;
  
  try {
    const objRes = await pool.query(`
      SELECT o.*, s.teacher_id 
      FROM exam_objections o
      JOIN course_sections s ON s.id = o.section_id
      WHERE o.id = $1
    `, [objectionId]);

    if (objRes.rows.length === 0) return res.redirect('/sis/faculty/exam-objections');
    const obj = objRes.rows[0];
    if (obj.teacher_id !== req.session.user.id) return res.redirect('/sis/faculty/exam-objections');

    if (action === 'resolve' && new_final_grade !== undefined) {
      const mid = Number(new_midterm_grade) || 0;
      const fin = Number(new_final_grade) || 0;
      const total = (mid + fin) / 2;
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

      await pool.query(`
        UPDATE grades SET midterm_grade = $1, final_grade = $2, letter_grade = $3, gpa_points = $4 
        WHERE student_id = $5 AND section_id = $6
      `, [mid, fin, letter, gpa, obj.student_id, obj.section_id]);

      await pool.query(`
        UPDATE exam_objections 
        SET status = 'resolved', teacher_response = $1, resolved_at = NOW() 
        WHERE id = $2
      `, [teacher_response || 'Grade corrected by teacher.', objectionId]);

      req.flash('success', 'Grade corrected and objection resolved.');
    } else {
      await pool.query(`
        UPDATE exam_objections 
        SET status = 'dismissed', teacher_response = $1, resolved_at = NOW() 
        WHERE id = $2
      `, [teacher_response || 'Grade is correct as entered.', objectionId]);
      req.flash('error', 'Objection dismissed.');
    }

    res.redirect('/sis/faculty/exam-objections');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- MAKEUP EXAM SYSTEM ---
// ============================================

// 1. Student: View Makeup Application Page
app.get('/sis/my/makeup-exams', requireRole('student'), async (req, res) => {
  try {
    const enrolledRes = await pool.query(`
      SELECT c.id, c.code, c.title 
      FROM enrollments e
      JOIN courses c ON c.id = e.course_id
      WHERE e.user_id = $1
    `, [req.session.user.id]);

    const requestsRes = await pool.query(`
      SELECT m.*, c.code, c.title 
      FROM makeup_exam_requests m
      JOIN courses c ON c.id = m.course_id
      WHERE m.student_id = $1
      ORDER BY m.created_at DESC
    `, [req.session.user.id]);

    res.render('student-makeup-exams', { 
      user: req.session.user, 
      enrolled: enrolledRes.rows, 
      requests: requestsRes.rows 
    });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 2. Student: Submit Request
app.post('/sis/my/makeup-exams/request', requireRole('student'), async (req, res) => {
  const { course_id, exam_type, reason } = req.body;
  try {
    const existing = await pool.query(`
      SELECT id FROM makeup_exam_requests 
      WHERE student_id = $1 AND course_id = $2 AND exam_type = $3 AND status = 'pending'
    `, [req.session.user.id, Number(course_id), exam_type]);

    if (existing.rows.length > 0) {
      req.flash('error', 'You already have a pending makeup request for this exam.');
      return res.redirect('/sis/my/makeup-exams');
    }

    await pool.query(`
      INSERT INTO makeup_exam_requests (student_id, course_id, exam_type, reason) 
      VALUES ($1, $2, $3, $4)
    `, [req.session.user.id, Number(course_id), exam_type, reason]);
    
    req.flash('success', 'Makeup exam request submitted to your teacher.');
    res.redirect('/sis/my/makeup-exams');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 3. Teacher: View Makeup Queue
app.get('/sis/faculty/makeup-exams', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const requestsRes = await pool.query(`
      SELECT m.*, c.code, c.title, u.full_name as student_name, u.username
      FROM makeup_exam_requests m
      JOIN courses c ON c.id = m.course_id
      JOIN users u ON u.id = m.student_id
      JOIN enrollments e ON e.course_id = c.id AND e.user_id = m.student_id
      JOIN course_sections s ON s.id = e.section_id
      WHERE s.teacher_id = $1 AND m.status = 'pending'
      ORDER BY m.created_at ASC
    `, [req.session.user.id]);
    res.render('faculty-makeup-exams', { user: req.session.user, requests: requestsRes.rows });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 4. Teacher: Approve/Reject Request
app.post('/sis/faculty/makeup-exams/:id/action', requireRole('teacher', 'advisor'), async (req, res) => {
  const requestId = req.params.id;
  const { action, scheduled_date, scheduled_room, teacher_notes } = req.body;
  
  try {
    if (action === 'approve') {
      await pool.query(`
        UPDATE makeup_exam_requests 
        SET status = 'approved', scheduled_date = $1, scheduled_room = $2, teacher_notes = $3 
        WHERE id = $4
      `, [scheduled_date, scheduled_room, teacher_notes, requestId]);
      req.flash('success', 'Makeup exam approved and scheduled.');
    } else {
      await pool.query(`
        UPDATE makeup_exam_requests 
        SET status = 'rejected', teacher_notes = $1 
        WHERE id = $2
      `, [teacher_notes || 'Request rejected.', requestId]);
      req.flash('error', 'Makeup request rejected.');
    }
    res.redirect('/sis/faculty/makeup-exams');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- STUDENT PROFILE & CONTACT INFO ---
// ============================================

// 1. View Profile
app.get('/sis/my/profile', requireRole('student'), async (req, res) => {
  try {
    const profileRes = await pool.query(`
      SELECT 
        u.full_name, u.username, u.email,
        sp.admission_number, sp.class_level, sp.current_semester, 
        sp.phone, sp.home_address, sp.guardian_name, sp.guardian_phone, sp.guardian_relationship,
        adv.full_name as advisor_name
      FROM users u
      LEFT JOIN student_profiles sp ON sp.user_id = u.id
      LEFT JOIN users adv ON adv.id = sp.advisor_id
      WHERE u.id = $1
    `, [req.session.user.id]);

    if (profileRes.rows.length === 0) return res.redirect('/sis/my');

    res.render('my-profile', { 
      user: req.session.user, 
      profile: profileRes.rows[0] 
    });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 2. Update Contact Info
app.post('/sis/my/profile/update', requireRole('student'), async (req, res) => {
  const { phone, home_address, guardian_name, guardian_phone, guardian_relationship } = req.body;
  
  try {
    await pool.query(`
      UPDATE student_profiles 
      SET phone = $1, home_address = $2, guardian_name = $3, guardian_phone = $4, guardian_relationship = $5
      WHERE user_id = $6
    `, [phone, home_address, guardian_name, guardian_phone, guardian_relationship, req.session.user.id]);

    req.flash('success', 'Contact information updated successfully.');
    res.redirect('/sis/my/profile');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- COURSE EVALUATION SYSTEM ---
// ============================================

// 1. Student: View Courses to Evaluate
app.get('/sis/my/evaluations', requireRole('student'), async (req, res) => {
  try {
    const coursesRes = await pool.query(`
      SELECT c.code, c.title, s.id as section_id, u.full_name as teacher_name,
             (SELECT id FROM course_evaluations e WHERE e.student_id = $1 AND e.section_id = s.id) as evaluated
      FROM enrollments en
      JOIN course_sections s ON s.id = en.section_id
      JOIN courses c ON c.id = en.course_id
      LEFT JOIN users u ON u.id = s.teacher_id
      WHERE en.user_id = $1
    `, [req.session.user.id]);

    res.render('student-evaluations', { 
      user: req.session.user, 
      courses: coursesRes.rows 
    });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 2. Student: Submit Evaluation
app.post('/sis/my/evaluations/submit', requireRole('student'), async (req, res) => {
  const { section_id, rating, feedback } = req.body;
  
  try {
    await pool.query(`
      INSERT INTO course_evaluations (student_id, section_id, rating, feedback)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (student_id, section_id) 
      DO UPDATE SET rating = $3, feedback = $4
    `, [req.session.user.id, Number(section_id), Number(rating), feedback]);

    req.flash('success', 'Thank you! Your anonymous evaluation has been submitted.');
    res.redirect('/sis/my/evaluations');
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// 3. Teacher: View Results
app.get('/sis/faculty/evaluations', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const statsRes = await pool.query(`
      SELECT c.code, c.title, s.group_name,
             ROUND(AVG(e.rating), 1) as avg_rating,
             COUNT(e.id) as total_responses
      FROM course_evaluations e
      JOIN course_sections s ON s.id = e.section_id
      JOIN courses c ON c.id = s.course_id
      WHERE s.teacher_id = $1
      GROUP BY c.code, c.title, s.group_name
    `, [req.session.user.id]);

    const feedbackRes = await pool.query(`
      SELECT c.code, e.rating, e.feedback, e.created_at
      FROM course_evaluations e
      JOIN course_sections s ON s.id = e.section_id
      JOIN courses c ON c.id = s.course_id
      WHERE s.teacher_id = $1 AND e.feedback IS NOT NULL AND e.feedback != ''
      ORDER BY e.created_at DESC
    `, [req.session.user.id]);

    res.render('faculty-evaluations', { 
      user: req.session.user, 
      stats: statsRes.rows,
      feedback: feedbackRes.rows
    });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

// ============================================
// --- RECTORATE: EXECUTIVE COMMAND CENTER ---
// ============================================


// ============================================
// --- SYSTEM AUDIT LOG (Rectorate & Admin) ---
// ============================================
app.get('/sis/rectorate/audit', requireRole('rectorate', 'admin'), async (req, res) => {
  try {
    const logsRes = await pool.query(`
      SELECT a.*, u.full_name as user_name, u.role as user_role
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.created_at DESC
      LIMIT 100
    `);

    const logs = logsRes.rows;

    // Map icons and colors based on action type
    const formattedLogs = logs.map(log => {
      let icon = 'fa-info-circle';
      let color = 'text-sky-500';
      let bg = 'bg-sky-500/10';

      if (log.action.includes('GRADE')) { icon = 'fa-pen'; color = 'text-amber-500'; bg = 'bg-amber-500/10'; }
      if (log.action.includes('LOCK')) { icon = 'fa-lock'; color = 'text-rose-500'; bg = 'bg-rose-500/10'; }
      if (log.action.includes('APPROVED')) { icon = 'fa-check-circle'; color = 'text-emerald-500'; bg = 'bg-emerald-500/10'; }
      if (log.action.includes('REJECTED')) { icon = 'fa-times-circle'; color = 'text-rose-500'; bg = 'bg-rose-500/10'; }

      return { ...log, icon, color, bg };
    });

    res.render('rectorate-audit', {
      user: req.session.user,
      logs: formattedLogs
    });
  } catch (err) { res.status(500).send("Audit Log Error: " + err.message); }
});



app.get('/sis/rectorate', requireRole('rectorate'), async (req, res) => {
  try {
    const studentsCount = await pool.query(`SELECT COUNT(*) FROM users WHERE role = 'student'`);
    const teachersCount = await pool.query(`SELECT COUNT(*) FROM users WHERE role = 'teacher'`);
    const tasksRes = await pool.query(`SELECT * FROM rectorate_tasks ORDER BY created_at DESC`);
    
    const tasks = tasksRes.rows;
    const pendingTasks = tasks.filter(t => t.status === 'Pending').length;
    const completedTasks = tasks.filter(t => t.status === 'Completed').length;
    const completionRate = tasks.length > 0 ? Math.round((completedTasks / tasks.length) * 100) : 0;

    res.render('rectorate-dashboard', {
      user: req.session.user,
      stats: {
        students: studentsCount.rows[0].count,
        teachers: teachersCount.rows[0].count,
        pendingTasks,
        completedTasks,
        completionRate
      },
      tasks: tasks
    });
  } catch (err) { res.status(500).send("Rectorate Error: " + err.message); }
});

// Rectorate: Send Global Broadcast
app.post('/sis/rectorate/broadcast', requireRole('rectorate'), async (req, res) => {
  try {
    const { title, message } = req.body;
    await pool.query(`
      INSERT INTO global_announcements (title, message) VALUES ($1, $2)
    `, [title, message]);
    
    req.flash('success', 'Broadcast sent to the entire university.');
    res.redirect('/sis/rectorate');
  } catch (err) { res.status(500).send("Broadcast Error: " + err.message); }
});

// Rectorate: Academic Quality
app.get('/sis/rectorate/academic-quality', requireRole('rectorate'), async (req, res) => {
  try {
    const overallRes = await pool.query(`
      SELECT 
        COUNT(*) AS total_grades,
        COALESCE(ROUND(AVG(gpa_points), 2), 0) AS avg_gpa,
        COUNT(*) FILTER (WHERE letter_grade IN ('A+', 'A', 'A-')) AS a_count,
        COUNT(*) FILTER (WHERE letter_grade = 'F') AS f_count
      FROM grades
      WHERE is_published = true
    `);
    const overall = overallRes.rows[0];
    const totalGrades = Number(overall.total_grades);
    const aCount = Number(overall.a_count);
    const fCount = Number(overall.f_count);
    
    const stats = {
      totalGrades,
      avgGpa: Number(overall.avg_gpa),
      aPercent: totalGrades > 0 ? Math.round((aCount / totalGrades) * 100) : 0,
      fPercent: totalGrades > 0 ? Math.round((fCount / totalGrades) * 100) : 0
    };

    const distRes = await pool.query(`
      SELECT letter_grade, COUNT(*) AS count
      FROM grades
      WHERE is_published = true AND letter_grade IS NOT NULL
      GROUP BY letter_grade
    `);
    const distribution = distRes.rows.map(r => ({ grade: r.letter_grade, count: Number(r.count) }));

    const coursesRes = await pool.query(`
      SELECT 
        c.code, c.title, u.full_name AS teacher_name,
        COUNT(g.id) AS total_graded,
        ROUND(AVG(g.gpa_points), 2) AS avg_gpa,
        COUNT(*) FILTER (WHERE g.letter_grade IN ('A+', 'A', 'A-')) AS a_count,
        COUNT(*) FILTER (WHERE g.letter_grade = 'F') AS f_count
      FROM grades g
      JOIN course_sections s ON s.id = g.section_id
      JOIN courses c ON c.id = s.course_id
      JOIN users u ON u.id = s.teacher_id
      WHERE g.is_published = true
      GROUP BY c.id, c.code, c.title, u.full_name
      ORDER BY avg_gpa ASC
    `);

    const courses = coursesRes.rows.map(c => {
      const total = Number(c.total_graded);
      const a = Number(c.a_count);
      const f = Number(c.f_count);
      return {
        ...c,
        total_graded: total,
        avg_gpa: Number(c.avg_gpa),
        a_percent: total > 0 ? Math.round((a / total) * 100) : 0,
        f_percent: total > 0 ? Math.round((f / total) * 100) : 0
      };
    });

    res.render('rectorate-academic-quality', {
      user: req.session.user,
      stats: stats,
      distribution: distribution,
      courses: courses
    });
  } catch (err) { res.status(500).send("Academic Quality Error: " + err.message); }
});

// Rectorate: KPIs
app.get('/sis/rectorate/kpis', requireRole('rectorate'), async (req, res) => {
  try {
    const deptKpiRes = await pool.query(`
      SELECT 
        assigned_to_dept AS department,
        COUNT(*) AS total_tasks,
        COUNT(*) FILTER (WHERE status = 'Completed') AS completed_tasks,
        COUNT(*) FILTER (WHERE status != 'Completed') AS pending_tasks,
        COUNT(*) FILTER (WHERE status != 'Completed' AND deadline < CURRENT_DATE) AS overdue_tasks
      FROM rectorate_tasks
      GROUP BY assigned_to_dept
      ORDER BY total_tasks DESC
    `);

    const departments = deptKpiRes.rows.map(d => {
      const total = Number(d.total_tasks);
      const completed = Number(d.completed_tasks);
      const rate = total > 0 ? Math.round((completed / total) * 100) : 0;
      return {
        department: d.department,
        total_tasks: total,
        completed_tasks: completed,
        pending_tasks: Number(d.pending_tasks),
        overdue_tasks: Number(d.overdue_tasks),
        completion_rate: rate
      };
    });

    const overallRes = await pool.query(`
      SELECT 
        COUNT(*) AS total_all,
        COUNT(*) FILTER (WHERE status = 'Completed') AS total_completed,
        COUNT(*) FILTER (WHERE status != 'Completed' AND deadline < CURRENT_DATE) AS total_overdue
      FROM rectorate_tasks
    `);

    const overall = overallRes.rows[0];
    const totalAll = Number(overall.total_all);
    const totalCompleted = Number(overall.total_completed);
    
    const stats = {
      overallRate: totalAll > 0 ? Math.round((totalCompleted / totalAll) * 100) : 0,
      totalOverdue: Number(overall.total_overdue),
      activeDepartments: departments.length,
      pendingTasks: totalAll - totalCompleted
    };

    res.render('rectorate-kpis', {
      user: req.session.user,
      stats: stats,
      departments: departments
    });
  } catch (err) { res.status(500).send("KPI Evaluation Error: " + err.message); }
});

// Rectorate: Registrar Oversight
app.get('/sis/rectorate/registrar', requireRole('rectorate'), async (req, res) => {
  try {
    const docStats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_docs,
        COUNT(*) FILTER (WHERE status = 'ready' OR status = 'rejected') AS completed_docs
      FROM document_requests
    `);
    
    const regStats = await pool.query(`
      SELECT COUNT(*) AS pending_regs 
      FROM course_registrations 
      WHERE status = 'pending_advisor'
    `);

    const wdStats = await pool.query(`
      SELECT COUNT(*) AS pending_wds 
      FROM course_withdrawals 
      WHERE status = 'pending'
    `);

    const recentDocs = await pool.query(`
      SELECT dr.id, dr.document_type, dr.status, dr.requested_at, u.full_name AS student_name
      FROM document_requests dr
      JOIN users u ON u.id = dr.student_id
      ORDER BY dr.requested_at DESC
      LIMIT 10
    `);

    const stats = {
      pendingDocs: Number(docStats.rows[0].pending_docs),
      completedDocs: Number(docStats.rows[0].completed_docs),
      pendingRegs: Number(regStats.rows[0].pending_regs),
      pendingWds: Number(wdStats.rows[0].pending_wds)
    };

    res.render('rectorate-registrar', {
      user: req.session.user,
      stats: stats,
      recentDocs: recentDocs.rows
    });
  } catch (err) { res.status(500).send("Registrar Oversight Error: " + err.message); }
});

// Rectorate: HR
app.get('/sis/rectorate/hr', requireRole('rectorate'), async (req, res) => {
  try {
    const staffCount = await pool.query(`SELECT COUNT(*) FROM users WHERE role IN ('teacher', 'advisor')`);
    
    const workloadRes = await pool.query(`
      SELECT 
        u.id, 
        u.full_name, 
        u.role,
        (SELECT COUNT(*) FROM course_sections s WHERE s.teacher_id = u.id) AS sections_count,
        (SELECT COUNT(*) FROM enrollments e JOIN course_sections s2 ON s2.id = e.section_id WHERE s2.teacher_id = u.id) AS students_count,
        (SELECT COUNT(*) FROM student_profiles sp WHERE sp.advisor_id = u.id) AS advisees_count
      FROM users u
      WHERE u.role IN ('teacher', 'advisor')
      ORDER BY sections_count DESC, advisees_count DESC
    `);

    const staff = workloadRes.rows.map(s => ({
      ...s,
      sections_count: Number(s.sections_count),
      students_count: Number(s.students_count),
      advisees_count: Number(s.advisees_count)
    }));

    const stats = {
      totalStaff: Number(staffCount.rows[0].count),
      totalSections: staff.reduce((sum, s) => sum + s.sections_count, 0),
      totalAdvisees: staff.reduce((sum, s) => sum + s.advisees_count, 0),
      avgLoad: staff.length > 0 ? Math.round(staff.reduce((sum, s) => sum + s.students_count, 0) / staff.length) : 0
    };

    res.render('rectorate-hr', {
      user: req.session.user,
      staff: staff,
      stats: stats
    });
  } catch (err) { res.status(500).send("HR Directorate Error: " + err.message); }
});

// Rectorate: Student Affairs
app.get('/sis/rectorate/student-affairs', requireRole('rectorate'), async (req, res) => {
  try {
    const demoRes = await pool.query(`
      SELECT 
        COUNT(*) AS total_students,
        COUNT(*) FILTER (WHERE sp.is_international = true) AS international_students,
        COUNT(*) FILTER (WHERE sp.is_international = false OR sp.is_international IS NULL) AS local_students
      FROM users u
      JOIN student_profiles sp ON sp.user_id = u.id
      WHERE u.role = 'student'
    `);
    const demographics = demoRes.rows[0];

    const withdrawalsRes = await pool.query(`
      SELECT COUNT(*) AS total 
      FROM course_withdrawals 
      WHERE status = 'approved'
    `);
    const withdrawals = withdrawalsRes.rows[0].total;

    const facultyRes = await pool.query(`
      SELECT 
        sp.class_level AS faculty,
        COUNT(*) AS total_students,
        COUNT(*) FILTER (WHERE sp.is_international = true) AS international_count,
        COUNT(*) FILTER (WHERE sp.is_international = false OR sp.is_international IS NULL) AS local_count
      FROM users u
      JOIN student_profiles sp ON sp.user_id = u.id
      WHERE u.role = 'student'
      GROUP BY sp.class_level
      ORDER BY total_students DESC
    `);

    const stats = {
      total: Number(demographics.total_students),
      international: Number(demographics.international_students),
      local: Number(demographics.local_students),
      withdrawals: Number(withdrawals)
    };

    stats.intlPercent = stats.total > 0 ? Math.round((stats.international / stats.total) * 100) : 0;
    stats.localPercent = stats.total > 0 ? Math.round((stats.local / stats.total) * 100) : 0;

    res.render('rectorate-student-affairs', {
      user: req.session.user,
      stats: stats,
      faculties: facultyRes.rows
    });
  } catch (err) { res.status(500).send("Student Affairs Error: " + err.message); }
});

// Rectorate: Senate
app.get('/sis/rectorate/senate', requireRole('rectorate'), async (req, res) => {
  try {
    const requestsRes = await pool.query(`SELECT * FROM senate_requests ORDER BY created_at DESC`);
    const requests = requestsRes.rows;
    
    const stats = {
      total: requests.length,
      pending: requests.filter(r => r.status === 'Pending').length,
      approved: requests.filter(r => r.status === 'Approved').length,
      rejected: requests.filter(r => r.status === 'Rejected').length
    };

    res.render('rectorate-senate', {
      user: req.session.user,
      requests: requests,
      stats: stats
    });
  } catch (err) { res.status(500).send("Senate Error: " + err.message); }
});

app.post('/sis/rectorate/senate/:id/approve', requireRole('rectorate'), async (req, res) => {
  try {
    await pool.query(`UPDATE senate_requests SET status = 'Approved', reviewed_at = NOW() WHERE id = $1`, [req.params.id]);
    req.flash('success', 'Request approved by the Senate.');
    res.redirect('/sis/rectorate/senate');
  } catch (err) { res.status(500).send("Approve Error: " + err.message); }
});

app.post('/sis/rectorate/senate/:id/reject', requireRole('rectorate'), async (req, res) => {
  try {
    await pool.query(`UPDATE senate_requests SET status = 'Rejected', reviewed_at = NOW() WHERE id = $1`, [req.params.id]);
    req.flash('error', 'Request rejected by the Senate.');
    res.redirect('/sis/rectorate/senate');
  } catch (err) { res.status(500).send("Reject Error: " + err.message); }
});

// Rectorate: Finance
app.get('/sis/rectorate/finance', requireRole('rectorate'), async (req, res) => {
  try {
    const totalsRes = await pool.query(`
      WITH StudentBilling AS (
        SELECT 
          u.id AS student_id,
          COALESCE(fs.amount, 0) AS amount_billed,
          COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.student_id = u.id), 0) AS amount_paid
        FROM users u
        JOIN student_profiles sp ON sp.user_id = u.id
        LEFT JOIN fee_structure fs ON LOWER(fs.program) = LOWER(sp.class_level) AND fs.semester = sp.current_semester
        WHERE u.role = 'student'
      )
      SELECT 
        SUM(amount_billed) AS total_billed,
        SUM(amount_paid) AS total_paid,
        SUM(amount_billed) - SUM(amount_paid) AS total_outstanding
      FROM StudentBilling
    `);

    const totals = totalsRes.rows[0] || { total_billed: 0, total_paid: 0, total_outstanding: 0 };
    
    const billed = Number(totals.total_billed);
    const paid = Number(totals.total_paid);
    const outstanding = Number(totals.total_outstanding);
    const collectionRate = billed > 0 ? Math.round((paid / billed) * 100) : 0;

    const facultiesRes = await pool.query(`
      WITH StudentBilling AS (
        SELECT 
          u.id AS student_id,
          sp.class_level,
          COALESCE(fs.amount, 0) AS amount_billed,
          COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.student_id = u.id), 0) AS amount_paid
        FROM users u
        JOIN student_profiles sp ON sp.user_id = u.id
        LEFT JOIN fee_structure fs ON LOWER(fs.program) = LOWER(sp.class_level) AND fs.semester = sp.current_semester
        WHERE u.role = 'student'
      )
      SELECT 
        class_level AS faculty,
        COUNT(student_id) AS student_count,
        SUM(amount_billed) AS total_billed,
        SUM(amount_paid) AS total_paid,
        SUM(amount_billed) - SUM(amount_paid) AS outstanding
      FROM StudentBilling
      GROUP BY class_level
      ORDER BY class_level
    `);

    const faculties = facultiesRes.rows.map(f => ({
      faculty: f.faculty || 'General',
      student_count: Number(f.student_count),
      total_billed: Number(f.total_billed),
      total_paid: Number(f.total_paid),
      outstanding: Number(f.outstanding),
      collection_rate: Number(f.total_billed) > 0 ? Math.round((Number(f.total_paid) / Number(f.total_billed)) * 100) : 0
    }));

    res.render('rectorate-finance', {
      user: req.session.user,
      stats: { billed, paid, outstanding, collectionRate },
      faculties: faculties
    });
  } catch (err) { res.status(500).send("Finance Directorate Error: " + err.message); }
});

// Rectorate: Graduation
app.get('/sis/rectorate/graduation', requireRole('rectorate'), async (req, res) => {
  try {
    const studentsRes = await pool.query(`
      SELECT 
        u.id, u.full_name, sp.admission_number, sp.current_semester, sp.class_level,
        COALESCE(SUM(CASE WHEN g.letter_grade NOT IN ('F', 'N/A') THEN c.credits ELSE 0 END), 0) AS earned_credits,
        COALESCE(ROUND(SUM(g.gpa_points * c.credits) / NULLIF(SUM(c.credits), 0), 2), 0.00) AS cgpa
      FROM users u
      JOIN student_profiles sp ON sp.user_id = u.id
      LEFT JOIN enrollments e ON e.user_id = u.id
      LEFT JOIN courses c ON c.id = e.course_id
      LEFT JOIN grades g ON g.student_id = u.id AND g.section_id = e.section_id AND g.is_published = true
      WHERE u.role = 'student'
      GROUP BY u.id, u.full_name, sp.admission_number, sp.current_semester, sp.class_level
    `);

    const students = studentsRes.rows.map(st => {
      const earned = Number(st.earned_credits);
      const gpa = Number(st.cgpa);
      let status = 'On Track';
      
      if (st.current_semester >= 8 && earned < 90) status = 'Delayed';
      if (gpa < 2.0) status = 'At Risk';
      
      return { ...st, earned_credits: earned, cgpa: gpa, status };
    });

    const stats = {
      total: students.length,
      onTrack: students.filter(s => s.status === 'On Track').length,
      delayed: students.filter(s => s.status === 'Delayed').length,
      atRisk: students.filter(s => s.status === 'At Risk').length
    };

    res.render('rectorate-graduation', {
      user: req.session.user,
      students: students,
      stats: stats
    });
  } catch (err) { res.status(500).send("Graduation Pipeline Error: " + err.message); }
});

// Rectorate: Tasks
app.post('/sis/rectorate/tasks/create', requireRole('rectorate'), async (req, res) => {
  const { title, description, assigned_to_dept, deadline } = req.body;
  try {
    await pool.query(`
      INSERT INTO rectorate_tasks (title, description, assigned_to_dept, assigned_by, deadline)
      VALUES ($1, $2, $3, $4, $5)
    `, [title, description, assigned_to_dept, req.session.user.id, deadline]);
    
    req.flash('success', 'Directive issued successfully.');
    res.redirect('/sis/rectorate');
  } catch (err) { res.status(500).send("Task Create Error: " + err.message); }
});

app.post('/sis/rectorate/tasks/:id/complete', requireRole('rectorate'), async (req, res) => {
  try {
    await pool.query(`
      UPDATE rectorate_tasks 
      SET status = 'Completed', completed_at = NOW() 
      WHERE id = $1
    `, [req.params.id]);
    
    req.flash('success', 'Task marked as completed.');
    res.redirect('/sis/rectorate');
  } catch (err) { res.status(500).send("Task Complete Error: " + err.message); }
});

// ============================================
// --- FACULTY: MY ADVISEES ---
// ============================================
app.get('/sis/faculty/advisees', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const adviseesRes = await pool.query(`
      SELECT 
        u.id AS user_id,
        u.full_name,
        u.email,
        sp.admission_number,
        sp.class_level,
        sp.current_semester,
        COALESCE(
          ROUND(SUM(g.gpa_points * c.credits) / NULLIF(SUM(c.credits), 0), 2),
          0.00
        ) AS cgpa
      FROM student_profiles sp
      JOIN users u ON u.id = sp.user_id
      LEFT JOIN enrollments e ON e.user_id = u.id
      LEFT JOIN courses c ON c.id = e.course_id
      LEFT JOIN grades g ON g.student_id = u.id AND g.section_id = e.section_id AND g.is_published = true
      WHERE sp.advisor_id = $1
      GROUP BY u.id, u.full_name, u.email, sp.admission_number, sp.class_level, sp.current_semester
      ORDER BY u.full_name ASC
    `, [req.session.user.id]);

    const advisees = adviseesRes.rows;
    const stats = {
      total: advisees.length,
      goodStanding: advisees.filter(a => Number(a.cgpa) >= 2.0).length,
      atRisk: advisees.filter(a => Number(a.cgpa) < 2.0 && Number(a.cgpa) > 0).length
    };

    res.render('faculty-advisees', {
      user: req.session.user,
      advisees,
      stats,
      greeting: getGreeting()
    });
  } catch (err) { res.status(500).send("Advisees Error: " + err.message); }
});


// ============================================



// ============================================
// --- COURSE DISCUSSION FORUMS ---
// ============================================

// 1. View Forum
app.get('/sis/course/:section_id/forum', requireRole('student', 'teacher', 'advisor'), async (req, res) => {
  const sectionId = req.params.section_id;
  try {
    let hasAccess = false;
    if (req.session.user.role === 'teacher' || req.session.user.role === 'advisor') {
      const check = await pool.query(`SELECT id FROM course_sections WHERE id = $1 AND teacher_id = $2`, [sectionId, req.session.user.id]);
      if (check.rows.length > 0) hasAccess = true;
    } else {
      const check = await pool.query(`SELECT id FROM enrollments WHERE section_id = $1 AND user_id = $2`, [sectionId, req.session.user.id]);
      if (check.rows.length > 0) hasAccess = true;
    }

    if (!hasAccess) return res.status(403).render('403');

    const sectionRes = await pool.query(`
      SELECT s.id, c.code, c.title, s.group_name FROM course_sections s JOIN courses c ON c.id = s.course_id WHERE s.id = $1
    `, [sectionId]);

    const threadsRes = await pool.query(`
      SELECT t.*, u.full_name as author_name, u.role as author_role,
             (SELECT COUNT(*) FROM forum_replies r WHERE r.thread_id = t.id) as reply_count
      FROM forum_threads t
      JOIN users u ON u.id = t.user_id
      WHERE t.section_id = $1
      ORDER BY t.created_at DESC
    `, [sectionId]);

    res.render('forum', {
      user: req.session.user,
      section: sectionRes.rows[0],
      threads: threadsRes.rows
    });
  } catch (err) { res.status(500).send("Forum Error: " + err.message); }
});

// 2. Create Thread
app.post('/sis/course/:section_id/forum/new', requireRole('student', 'teacher', 'advisor'), async (req, res) => {
  const sectionId = req.params.section_id;
  const { title } = req.body;
  try {
    await pool.query(`
      INSERT INTO forum_threads (section_id, user_id, title) VALUES ($1, $2, $3)
    `, [sectionId, req.session.user.id, title]);
    res.redirect(`/sis/course/${sectionId}/forum`);
  } catch (err) { res.status(500).send("Error creating thread: " + err.message); }
});

// 3. View Single Thread & Replies
app.get('/sis/course/forum/thread/:thread_id', requireRole('student', 'teacher', 'advisor'), async (req, res) => {
  const threadId = req.params.thread_id;
  try {
    const threadRes = await pool.query(`
      SELECT t.*, u.full_name as author_name, u.role as author_role, s.id as section_id, c.code, c.title
      FROM forum_threads t
      JOIN users u ON u.id = t.user_id
      JOIN course_sections s ON s.id = t.section_id
      JOIN courses c ON c.id = s.course_id
      WHERE t.id = $1
    `, [threadId]);

    if (threadRes.rows.length === 0) return res.redirect('/sis/my');

    const repliesRes = await pool.query(`
      SELECT r.*, u.full_name as author_name, u.role as author_role
      FROM forum_replies r
      JOIN users u ON u.id = r.user_id
      WHERE r.thread_id = $1
      ORDER BY r.created_at ASC
    `, [threadId]);

    res.render('forum-thread', {
      user: req.session.user,
      thread: threadRes.rows[0],
      replies: repliesRes.rows
    });
  } catch (err) { res.status(500).send("Thread Error: " + err.message); }
});

// 4. Post Reply
app.post('/sis/course/forum/thread/:thread_id/reply', requireRole('student', 'teacher', 'advisor'), async (req, res) => {
  const threadId = req.params.thread_id;
  const { message } = req.body;
  try {
    await pool.query(`
      INSERT INTO forum_replies (thread_id, user_id, message) VALUES ($1, $2, $3)
    `, [threadId, req.session.user.id, message]);
    res.redirect(`/sis/course/forum/thread/${threadId}`);
  } catch (err) { res.status(500).send("Error posting reply: " + err.message); }
});



// ============================================
// --- FACULTY & ADMIN: LEAVE REQUESTS ---
// ============================================

app.get('/sis/faculty/leave', requireRole('teacher', 'advisor'), async (req, res) => {
  try {
    const requestsRes = await pool.query(`SELECT * FROM leave_requests WHERE user_id = $1 ORDER BY created_at DESC`, [req.session.user.id]);
    res.render('faculty-leave', { user: req.session.user, requests: requestsRes.rows });
  } catch (err) { res.status(500).send("Leave Error: " + err.message); }
});

app.post('/sis/faculty/leave/request', requireRole('teacher', 'advisor'), async (req, res) => {
  const { leave_type, start_date, end_date, reason } = req.body;
  try {
    await pool.query(`INSERT INTO leave_requests (user_id, leave_type, start_date, end_date, reason) VALUES ($1, $2, $3, $4, $5)`, [req.session.user.id, leave_type, start_date, end_date, reason]);
    req.flash('success', 'Leave request submitted successfully.');
    res.redirect('/sis/faculty/leave');
  } catch (err) { res.status(500).send("Leave Request Error: " + err.message); }
});

app.get('/sis/admin/leave', requireRole('admin'), async (req, res) => {
  try {
    const requestsRes = await pool.query(`
      SELECT l.*, u.full_name, u.role FROM leave_requests l 
      JOIN users u ON u.id = l.user_id 
      ORDER BY l.created_at DESC
    `);
    res.render('admin-leave', { user: req.session.user, requests: requestsRes.rows });
  } catch (err) { res.status(500).send("Admin Leave Error: " + err.message); }
});

app.post('/sis/admin/leave/:id/action', requireRole('admin'), async (req, res) => {
  const { action } = req.body;
  try {
    await pool.query(`UPDATE leave_requests SET status = $1, reviewed_at = NOW() WHERE id = $2`, [action === 'approve' ? 'Approved' : 'Rejected', req.params.id]);
    req.flash('success', `Leave request ${action}d.`);
    res.redirect('/sis/admin/leave');
  } catch (err) { res.status(500).send("Leave Action Error: " + err.message); }
});






// --- PLACEHOLDER (MUST BE LAST) ---
// ============================================
app.get('/sis/my/:page', requireRole('student'), (req, res) => {
  res.send(`
    <div style="font-family: sans-serif; padding: 3rem; text-align: center;">
      <h1>Page Under Construction</h1>
      <p>The <strong>${req.params.page}</strong> page is currently being built.</p>
      <a href="/sis/my" style="display:inline-block; margin-top:1rem; padding: 10px 20px; background: #0a1e32; color: white; text-decoration: none; border-radius: 5px;">Back to Dashboard</a>
    </div>
  `);
});

// --- HEALTH CHECK FOR KEEP-ALIVE ---
app.get('/health', (req, res) => res.status(200).send('OK'));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('<pre style="background:#fee2e2;padding:2rem;color:#991b1b;font-size:1rem;">' + err.stack + '</pre>');
});

app.listen(process.env.PORT || 3000, () => console.log('Server running'));