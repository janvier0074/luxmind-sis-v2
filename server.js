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

app.set('trust proxy', 1);

const pool = new Pool({
  user: 'postgres.fclhdbppskmjlmbhtoug',
  password: 'LuxMindAdmin2026',
  host: 'aws-1-eu-central-1.pooler.supabase.com',
  port: 6543,
  database: 'postgres',
  ssl: { rejectUnauthorized: false }
});
const resend = new Resend(process.env.RESEND_API_KEY || 're_missing_key');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));

app.use(session({ 
  secret: 'luxmind-secret', 
  resave: false, 
  saveUninitialized: false,
  cookie: { secure: true, sameSite: 'none', httpOnly: true }
}));

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

  res.locals.unreadNotifications = 0;
  if (req.session.user) {
    try {
      const notifRes = await pool.query(`SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = false`, [req.session.user.id]);
      res.locals.unreadNotifications = parseInt(notifRes.rows[0].count) || 0;
    } catch (e) { res.locals.unreadNotifications = 0; }
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
// --- PUBLIC APPLICATION FORM (/apply) ---
// ============================================
app.get('/apply', async (req, res) => {
  let programs = [];
  try {
    const r = await pool.query(`SELECT DISTINCT program FROM fee_structure WHERE program IS NOT NULL ORDER BY program`);
    programs = r.rows.map(x => x.program);
  } catch (e) { /* table may not exist in edge cases */ }

  if (!programs || programs.length === 0) {
    programs = ['Computer Engineering', 'Business Administration', 'Nursing', 'Civil Engineering', 'Law', 'Education'];
  }

  res.render('apply', { error: null, values: {}, programs });
});

app.post('/apply', async (req, res) => {
  const {
    full_name, email, phone, date_of_birth, gender, nationality, country_of_residence,
    high_school_name, high_school_gpa, english_test_type, english_test_score,
    intended_program, intended_semester, passport_number
  } = req.body;

  const values = req.body;
  const errors = [];

  if (!full_name || full_name.trim().length < 3) errors.push('Full name must be at least 3 characters.');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('A valid email address is required.');
  if (!intended_program) errors.push('Please select an intended program.');
  if (!high_school_gpa || isNaN(Number(high_school_gpa)) || Number(high_school_gpa) < 0 || Number(high_school_gpa) > 4) {
    errors.push('High school GPA must be a number between 0 and 4.');
  }

  if (errors.length > 0) {
    let programs = [];
    try {
      const r = await pool.query(`SELECT DISTINCT program FROM fee_structure WHERE program IS NOT NULL ORDER BY program`);
      programs = r.rows.map(x => x.program);
    } catch (e) {}
    if (!programs || programs.length === 0) {
      programs = ['Computer Engineering', 'Business Administration', 'Nursing', 'Civil Engineering', 'Law', 'Education'];
    }
    return res.render('apply', { error: errors.join(' '), values, programs });
  }

  try {
    const result = await pool.query(`
      INSERT INTO applications
        (full_name, email, phone, date_of_birth, gender, nationality, country_of_residence,
         high_school_name, high_school_gpa, english_test_type, english_test_score,
         intended_program, intended_semester, passport_number, source, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'online','new')
      RETURNING id
    `, [
      full_name.trim(),
      email.trim().toLowerCase(),
      phone ? phone.trim() : null,
      date_of_birth || null,
      gender || null,
      nationality ? nationality.trim() : null,
      country_of_residence ? country_of_residence.trim() : null,
      high_school_name ? high_school_name.trim() : null,
      Number(high_school_gpa),
      english_test_type || null,
      english_test_score ? Number(english_test_score) : null,
      intended_program,
      Number(intended_semester) || 1,
      passport_number ? passport_number.trim().toUpperCase() : null
    ]);

    res.redirect(`/apply/success/${result.rows[0].id}`);
  } catch (err) {
    let programs = [];
    try {
      const r = await pool.query(`SELECT DISTINCT program FROM fee_structure WHERE program IS NOT NULL ORDER BY program`);
      programs = r.rows.map(x => x.program);
    } catch (e) {}
    if (!programs || programs.length === 0) {
      programs = ['Computer Engineering', 'Business Administration', 'Nursing', 'Civil Engineering', 'Law', 'Education'];
    }
    res.render('apply', { error: 'Submission error: ' + err.message, values, programs });
  }
});

app.get('/apply/success/:id', async (req, res) => {
  const appId = parseInt(req.params.id);
  if (!appId) return res.redirect('/apply');

  try {
    const result = await pool.query(
      `SELECT id, full_name, email, intended_program, created_at FROM applications WHERE id = $1`,
      [appId]
    );
    if (result.rows.length === 0) return res.redirect('/apply');
    res.render('apply-success', { application: result.rows[0] });
  } catch (err) {
    res.redirect('/apply');
  }
});

// ============================================
// --- AUTHENTICATION ---
// ============================================
app.get('/login', (req, res) => {
  if (req.session.user) return res.send("<h1>LOGIN SUCCESSFUL! The database is connected.</h1><a href='/sis/my'>Go to Dashboard</a>");
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
      
      // Check if this user is a Dean of any faculty
      let deanFaculty = null;
      try {
        const deanCheck = await pool.query(
          `SELECT id, name, code FROM faculties WHERE dean_id = $1 LIMIT 1`,
          [req.session.user.id]
        );
        if (deanCheck.rows.length > 0) {
          deanFaculty = deanCheck.rows[0];
          req.session.user.dean_faculty = deanFaculty;
        }
      } catch (e) { /* table may not exist yet, ignore */ }

      // ✅ FIXED LOGIN REDIRECTS
      if (req.session.user.role === 'intl_officer') return res.redirect('/sis/intl');
      if (req.session.user.role === 'finance_staff') return res.redirect('/sis/finance');
      if (req.session.user.role === 'it_staff') return res.redirect('/sis/it');
      if (req.session.user.role === 'admin') return res.redirect('/sis/admin');
if (req.session.user.role === 'dean') {
  return res.redirect('/sis/dean');
}
if (deanFaculty) return res.redirect('/sis/dean');
if (req.session.user.role === 'department_head') {
  return res.redirect('/sis/department-head');
}
      if (req.session.user.role === 'advisor') return res.redirect('/sis/advisor');
      if (req.session.user.role === 'rectorate') return res.redirect('/sis/rectorate');
      if (deanFaculty) return res.redirect('/sis/dean');
      if (req.session.user.role === 'teacher') return res.redirect('/sis/faculty');
      
      return res.redirect('/sis/my');
    }

    req.flash('error', 'Invalid credentials');
    res.redirect('/login');
  } catch (err) {
    res.status(500).send("<pre style='color:red; font-size:20px; background:#fff; padding:20px;'>ERROR: " + err.message + "\n\nSTACK: " + err.stack + "</pre>");
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
      return res.status(403).send(`
        <div style="font-family: system-ui; padding: 3rem; text-align: center; max-width: 600px; margin: 0 auto;">
          <div style="font-size: 4rem; margin-bottom: 1rem;">🔒</div>
          <h1 style="color: #b33e2e; font-size: 2rem; margin-bottom: 1rem;">Access Denied</h1>
          <p style="color: #64748b; font-size: 1rem; line-height: 1.6; margin-bottom: 2rem;">
            You do not have permission to access this page.<br>
            Your role: <strong>${req.session.user.role}</strong><br>
            Required role(s): <strong>${allowedRoles.join(', ')}</strong>
          </p>
          <a href="/sis/my" style="display: inline-block; padding: 0.75rem 1.5rem; background: #0a1e32; color: white; text-decoration: none; border-radius: 8px; font-weight: 700;">
            ← Return to My Portal
          </a>
        </div>
      `);
    }
    
    next();
  };
};



// ============================================
// --- INTERNATIONAL OFFICE: TEAM GUARD ---
// ============================================
const requireIntlTeam = (allowedTeams) => {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');

    const { intl_role, intl_team } = req.session.user;

    // System Admin + Overall Director (All Teams) bypass all team checks
    if (req.session.user.role === 'admin' || intl_team === 'All Teams') {
      return next();
    }

    // Team members must belong to one of the allowed teams
    if (allowedTeams.includes(intl_team)) {
      return next();
    }

    // Block — never trust the frontend
    return res.status(403).send(`
      <html><body style="font-family:system-ui;padding:4rem;text-align:center;background:#f4f6fa;">
        <div style="max-width:520px;margin:0 auto;background:#fff;padding:2.5rem;border-radius:16px;box-shadow:0 8px 28px rgba(24,39,75,.055);">
          <div style="width:60px;height:60px;background:#fdf2f4;border-radius:50%;display:grid;place-items:center;margin:0 auto 1rem;font-size:1.6rem;">🔒</div>
          <h1 style="color:#b33e2e;margin:0 0 1rem;">Access Denied</h1>
          <p style="color:#718096;line-height:1.6;">This tool belongs to the <strong>${allowedTeams.join(' or ')}</strong>.</p>
          <p style="color:#718096;">Your team: <strong>${intl_team || 'Unassigned'}</strong></p>
          <a href="/sis/intl" style="display:inline-block;margin-top:1rem;padding:12px 24px;background:#111d35;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">← Back to Intl Office</a>
        </div>
      </body></html>
    `);
  };
};


// ============================================
// --- NOTIFICATIONS API ---
// ============================================
app.get('/api/notifications', requireLogin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, title, body, link, is_read, created_at
      FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 10
    `, [req.session.user.id]);
    
    const unreadCount = result.rows.filter(n => !n.is_read).length;
    
    res.json({
      notifications: result.rows,
      unreadCount: unreadCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/:id/read', requireLogin, async (req, res) => {
  try {
    await pool.query(`
      UPDATE notifications 
      SET is_read = true 
      WHERE id = $1 AND user_id = $2
    `, [req.params.id, req.session.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notifications/read-all', requireLogin, async (req, res) => {
  try {
    await pool.query(`
      UPDATE notifications SET is_read = true WHERE user_id = $1
    `, [req.session.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
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

        // ==============================
    // REAL DASHBOARD CALCULATIONS
    // ==============================
    
    // 1. Calculate real CGPA from published grades
    const cgpaRes = await pool.query(`
      SELECT 
        COALESCE(ROUND(SUM(g.gpa_points * c.credits) / NULLIF(SUM(c.credits), 0), 2), 0.00) as cgpa
      FROM grades g
      JOIN course_sections s ON s.id = g.section_id
      JOIN courses c ON c.id = s.course_id
      WHERE g.student_id = $1 AND g.is_published = true
    `, [req.session.user.id]);
    const realGpa = Number(cgpaRes.rows[0].cgpa).toFixed(2);

    // 2. Calculate real debt (tuition - payments) with scholarship applied
    const feeRes = await pool.query(`
      SELECT COALESCE(fs.amount, 0) as amount
      FROM fee_structure fs
      WHERE LOWER(fs.program) = LOWER($1) AND fs.semester = $2
      LIMIT 1
    `, [profile.class_level, profile.current_semester]);
    const baseTuition = Number(feeRes.rows[0]?.amount) || 0;
    
    // Apply scholarship (same logic as finance page)
    const studentScholarshipRes = await pool.query(`
      SELECT is_international, high_school_gpa FROM student_profiles WHERE user_id = $1
    `, [req.session.user.id]);
    const sp = studentScholarshipRes.rows[0] || {};
    let scholarshipPct = 0;
    if (sp.is_international) scholarshipPct = 50;
    if (sp.high_school_gpa >= 3.0 && sp.high_school_gpa < 3.5) scholarshipPct = 75;
    if (sp.high_school_gpa >= 3.5 && sp.high_school_gpa < 3.8) scholarshipPct = 90;
    if (sp.high_school_gpa >= 3.8) scholarshipPct = 100;
    
    const netTuition = baseTuition - (baseTuition * scholarshipPct / 100);
    
    const paidRes = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE student_id = $1`, [req.session.user.id]);
    const totalPaidDash = Number(paidRes.rows[0].total);
    const realBalance = Math.max(0, netTuition - totalPaidDash);

    // 3. Get the NEXT upcoming installment payment
    const nextInstRes = await pool.query(`
      SELECT amount, due_date, status FROM installment_schedules 
      WHERE student_id = $1 AND status IN ('unpaid', 'overdue')
      ORDER BY due_date ASC LIMIT 1
    `, [req.session.user.id]);
    const nextInstallment = nextInstRes.rows[0] || null;
    
    // 4. Count overdue installments
    const overdueCountRes = await pool.query(`
      SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
      FROM installment_schedules 
      WHERE student_id = $1 AND status = 'overdue'
    `, [req.session.user.id]);
    const overdueCount = parseInt(overdueCountRes.rows[0].count) || 0;
    const overdueTotal = Number(overdueCountRes.rows[0].total) || 0;

    // 5. Build stats object with REAL values
    const stats = { 
      gpa: realGpa, 
      credits: credits, 
      balance: realBalance, 
      semester: profile.current_semester,
      nextInstallment: nextInstallment,
      overdueCount: overdueCount,
      overdueTotal: overdueTotal
    };

       // ✅ Fix: only count announcements NEWER than last view
    const newAnnCount = await pool.query(`
      SELECT COUNT(*) FROM course_announcements a
      JOIN course_sections s ON s.id = a.section_id
      JOIN enrollments e ON e.section_id = s.id
      WHERE e.user_id = $1 
      AND a.created_at > COALESCE(
        (SELECT last_announcements_view_at FROM users WHERE id = $1),
        NOW() - INTERVAL '7 days'
      )
    `, [req.session.user.id]);
    
    const globalAnnCount = await pool.query(`
      SELECT COUNT(*) FROM global_announcements 
      WHERE created_at > COALESCE(
        (SELECT last_announcements_view_at FROM users WHERE id = $1),
        NOW() - INTERVAL '7 days'
      )
    `, [req.session.user.id]);

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

// ============================================
// --- STUDENT: TIMETABLE ---
// ============================================
app.get('/sis/my/timetable', requireRole('student'), async (req, res) => {
  try {
    const scheduleRes = await pool.query(`
      SELECT 
        c.code, c.title, c.credits, 
        COALESCE(s.group_name, 'TBA') AS group_name,
        s.day_of_week,
        s.start_time,
        s.end_time,
        COALESCE(s.room, 'TBA') AS room,
        u.full_name AS teacher_name,
        s.id AS section_id
      FROM enrollments e
      JOIN courses c ON c.id = e.course_id
      LEFT JOIN course_sections s ON s.id = e.section_id
      LEFT JOIN users u ON u.id = s.teacher_id
      WHERE e.user_id = $1
      ORDER BY c.code ASC
    `, [req.session.user.id]);

    const profileRes = await pool.query(`
      SELECT sp.class_level, sp.current_semester, sp.admission_number 
      FROM student_profiles sp WHERE sp.user_id = $1
    `, [req.session.user.id]);

    const allClasses = scheduleRes.rows;
    const profile = profileRes.rows[0] || {};

    const classes = allClasses.filter(c => c.day_of_week && c.start_time);
    const missingSchedule = allClasses.filter(c => !c.day_of_week || !c.start_time);

    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const timeSlots = ['08:00','09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00'];

    const colorPalette = ['#1e88e5','#43a047','#e53935','#8e24aa','#fb8c00','#00acc1','#3949ab','#d81b60'];
    const colorMap = {};
    let colorIndex = 0;
    classes.forEach(cls => {
      if (!colorMap[cls.code]) {
        colorMap[cls.code] = colorPalette[colorIndex % colorPalette.length];
        colorIndex++;
      }
    });

    const grid = {};
    days.forEach(day => {
      grid[day] = {};
      timeSlots.forEach(time => grid[day][time] = null);
    });

    classes.forEach(cls => {
      const start = cls.start_time.slice(0, 5);
      const end = cls.end_time ? cls.end_time.slice(0, 5) : '';
      if (grid[cls.day_of_week] && grid[cls.day_of_week][start] !== undefined) {
        grid[cls.day_of_week][start] = {
          ...cls,
          start_time: start,
          end_time: end,
          color: colorMap[cls.code]
        };
      }
    });

    const totalCredits = classes.reduce((sum, c) => sum + Number(c.credits), 0);

    res.render('timetable', {
      user: req.session.user,
      profile,
      totalCredits,
      grid,
      days,
      timeSlots,
      courses: classes,
      missingSchedule
    });
  } catch (err) {
    res.status(500).send("Timetable Error: " + err.message);
  }
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

app.get('/sis/my/registration', requireRole('student'), async (req, res) => {
  try {
    const feeRes = await pool.query(`
      SELECT COALESCE(fs.amount, 0) AS amount_billed,
             COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.student_id = $1), 0) AS amount_paid
      FROM student_profiles sp
      LEFT JOIN fee_structure fs ON LOWER(fs.program) = LOWER(sp.class_level) AND fs.semester = sp.current_semester
      WHERE sp.user_id = $1
    `, [req.session.user.id]);

    if (feeRes.rows.length > 0) {
      const debt = Number(feeRes.rows[0].amount_billed) - Number(feeRes.rows[0].amount_paid);
      
      const instRes2 = await pool.query(`SELECT id FROM installment_requests WHERE student_id = $1 AND status = 'approved'`, [req.session.user.id]);
      const hasApprovedInstallment2 = instRes2.rows.length > 0;

      if (debt > 0 && !hasApprovedInstallment2) {
        req.flash('error', `Financial Hold: You owe $${debt.toFixed(2)}. You must clear your balance or have an approved installment plan to register.`);
        return res.redirect('/sis/my/finance');
      }
    }

    const enrollCheck = await pool.query(`SELECT id FROM enrollments WHERE user_id = $1 LIMIT 1`, [req.session.user.id]);
    const hasRegistered = enrollCheck.rows.length > 0;

      // ============================================
    // ✅ NEW: Guided Registration — Get student's semester and settings
    // ============================================
    const semesterRes = await pool.query(`
      SELECT current_semester FROM student_profiles WHERE user_id = $1
    `, [req.session.user.id]);
    const studentSemester = semesterRes.rows[0]?.current_semester || 1;

    const settingsRes = await pool.query(`SELECT * FROM registration_settings LIMIT 1`);
    const settings = settingsRes.rows[0] || { min_credits: 12, max_credits: 21, registration_open: true };

    // Check if registration is globally closed
    if (!settings.registration_open) {
      req.flash('error', 'Registration is currently closed. Please check back during the registration window.');
      return res.redirect('/sis/my');
    }

    // Get list of courses student has FAILED (for retake eligibility)
    const failedRes = await pool.query(`
      SELECT DISTINCT c.id FROM grades g
      JOIN course_sections s ON s.id = g.section_id
      JOIN courses c ON c.id = s.course_id
      WHERE g.student_id = $1 AND g.letter_grade = 'F' AND g.is_published = true
    `, [req.session.user.id]);
    const failedCourseIds = failedRes.rows.map(r => r.id);

    // ✅ CHANGED: Show ALL courses (no semester filter). Quota 0 no longer blocks.
     // ============================================
// ✅ Filter courses to the student's OWN department only
// ============================================
const coursesRes = await pool.query(`
  SELECT c.*, COALESCE(NULLIF(c.quota, 0), 40) as quota,
         s.id as section_id, s.day_of_week, s.start_time, s.end_time,
         ((SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) + 
          (SELECT COUNT(*) FROM course_registrations cr WHERE cr.course_id = c.id AND cr.status = 'pending_advisor')) as enrolled_count,
         CASE WHEN c.semester_number > $1 THEN true ELSE false END AS is_future
  FROM courses c 
  LEFT JOIN course_sections s ON s.course_id = c.id
  JOIN student_profiles sp ON sp.user_id = $2
  JOIN departments d ON d.id = c.department_id
  WHERE 
    -- Match student's class_level against department name, ignoring case + "Department of" prefix
    LOWER(d.name) = LOWER('Department of ' || sp.class_level)
    OR LOWER(d.name) = LOWER(sp.class_level)
    OR LOWER(REPLACE(d.name, 'Department of ', '')) = LOWER(sp.class_level)
  ORDER BY c.semester_number ASC, c.code ASC
`, [studentSemester, req.session.user.id]);

    const passedRes = await pool.query(`
      SELECT c.id FROM grades g 
      JOIN course_sections s ON s.id = g.section_id 
      JOIN courses c ON c.id = s.course_id 
      WHERE g.student_id = $1 AND g.letter_grade NOT IN ('F', 'N/A') AND g.is_published = true
    `, [req.session.user.id]);
    const passedCourseIds = passedRes.rows.map(r => r.id);

    const enrolledRes = await pool.query(`
      SELECT c.id, s.day_of_week, s.start_time, s.end_time 
      FROM enrollments e JOIN courses c ON c.id = e.course_id LEFT JOIN course_sections s ON s.id = e.section_id WHERE e.user_id = $1
      UNION
      SELECT c.id, s.day_of_week, s.start_time, s.end_time 
      FROM course_registrations cr JOIN courses c ON c.id = cr.course_id LEFT JOIN course_sections s ON s.course_id = c.id WHERE cr.student_id = $1 AND cr.status IN ('draft', 'pending_advisor')
    `, [req.session.user.id]);

    const cartRes = await pool.query(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'draft'`, [req.session.user.id]);
    const pendingRes = await pool.query(`SELECT cr.id as cart_id, cr.course_id, c.title, c.code, c.credits FROM course_registrations cr JOIN courses c ON c.id = cr.course_id WHERE cr.student_id = $1 AND cr.status = 'pending_advisor'`, [req.session.user.id]);

    // ✅ CHANGED: isEligible is ALWAYS true. `reason` is informational only.
    // Server-side guards still exist on POST /add for prereq, conflict, credits.
    const processedCourses = coursesRes.rows.map(course => {
      let reason = '';

      if (course.is_future) {
        reason = 'Future Semester';
      }

      if (course.enrolled_count >= course.quota) {
        reason = 'Section Full';
      }

      if (course.prerequisite_id && !passedCourseIds.includes(course.prerequisite_id)) {
        reason = 'Missing Prerequisite';
      }

      if (course.day_of_week && course.start_time) {
        const conflict = enrolledRes.rows.find(e => 
          e.id !== course.id && 
          e.day_of_week === course.day_of_week && 
          e.start_time === course.start_time
        );
        if (conflict) {
          reason = 'Schedule Conflict';
        }
      }

      return { ...course, isEligible: true, reason };
    });

      const totalCartCredits = cartRes.rows.reduce((sum, c) => sum + Number(c.credits), 0);
    const totalPendingCredits = pendingRes.rows.reduce((sum, c) => sum + Number(c.credits), 0);
    
    res.render('registration', { 
      user: req.session.user, 
      courses: processedCourses, 
      cart: cartRes.rows, 
      pending: pendingRes.rows, 
      hasRegistered,
      studentSemester,
      minCredits: settings.min_credits,
      maxCredits: settings.max_credits,
      registrationOpen: settings.registration_open,
      totalCartCredits,
      totalPendingCredits
    });
  } catch (err) {
    res.status(500).send("Registration Error: " + err.message);
  }
});

app.post('/sis/my/registration/add', requireRole('student'), async (req, res) => {
  const courseId = Number(req.body.course_id);

  try {
    const feeRes = await pool.query(`
      SELECT COALESCE(fs.amount, 0) AS amount_billed,
             COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.student_id = $1), 0) AS amount_paid
      FROM student_profiles sp
      LEFT JOIN fee_structure fs ON LOWER(fs.program) = LOWER(sp.class_level) AND fs.semester = sp.current_semester
      WHERE sp.user_id = $1
    `, [req.session.user.id]);

    if (feeRes.rows.length > 0) {
      const debt = Number(feeRes.rows[0].amount_billed) - Number(feeRes.rows[0].amount_paid);
      const instRes2 = await pool.query(`SELECT id FROM installment_requests WHERE student_id = $1 AND status = 'approved'`, [req.session.user.id]);
      const hasApprovedInstallment2 = instRes2.rows.length > 0;

      if (debt > 0 && !hasApprovedInstallment2) {
        req.flash('error', `Financial Hold: You owe $${debt.toFixed(2)}. You must clear your balance or have an approved installment plan to register.`);
        return res.redirect('/sis/my/registration');
      }
    }

    const courseRes = await pool.query(`
      SELECT c.*, COALESCE(NULLIF(c.quota, 0), 40) as quota, s.day_of_week, s.start_time, s.end_time,
             (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) + 
             (SELECT COUNT(*) FROM course_registrations cr WHERE cr.course_id = c.id AND cr.status = 'pending_advisor') as enrolled_count
      FROM courses c LEFT JOIN course_sections s ON s.course_id = c.id WHERE c.id = $1 LIMIT 1
    `, [courseId]);
    
    if (courseRes.rows.length === 0) return res.redirect('/sis/my/registration');
    const course = courseRes.rows[0];

    if (course.enrolled_count >= course.quota) {
      const onWaitlist = await pool.query(`SELECT id FROM course_registrations WHERE student_id = $1 AND course_id = $2 AND status = 'waitlisted'`, [req.session.user.id, courseId]);
      
      if (onWaitlist.rows.length > 0) {
        req.flash('error', 'You are already on the waitlist for this course.');
        return res.redirect('/sis/my/registration');
      }

      await pool.query(`INSERT INTO course_registrations (student_id, course_id, status) VALUES ($1, $2, 'waitlisted')`, [req.session.user.id, courseId]);
      
      const waitPos = await pool.query(`SELECT COUNT(*) FROM course_registrations WHERE course_id = $1 AND status = 'waitlisted'`, [courseId]);
      
      req.flash('success', `Section is full. You have been added to the waitlist. Your position: #${waitPos.rows[0].count}`);
      return res.redirect('/sis/my/registration');
    }

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





    // ✅ NEW: Enforce max credit limit
    const settingsRes = await pool.query(`SELECT * FROM registration_settings LIMIT 1`);
    const settings = settingsRes.rows[0] || { min_credits: 12, max_credits: 21 };
    
    const currentCartRes = await pool.query(`
      SELECT COALESCE(SUM(c.credits), 0) as total_credits
      FROM course_registrations cr
      JOIN courses c ON c.id = cr.course_id
      WHERE cr.student_id = $1 AND cr.status IN ('draft', 'pending_advisor')
    `, [req.session.user.id]);
    const currentCredits = Number(currentCartRes.rows[0].total_credits);
    const newCourseCredits = Number(course.credits);
    
    if (currentCredits + newCourseCredits > settings.max_credits) {
      req.flash('error', `Cannot add "${course.code}": Credit limit exceeded. You have ${currentCredits}/${settings.max_credits} credits. Adding ${newCourseCredits} more would go over the maximum.`);
      return res.redirect('/sis/my/registration');
    }

















    const existing = await pool.query(`SELECT id FROM course_registrations WHERE student_id = $1 AND course_id = $2`, [req.session.user.id, courseId]);
    if (existing.rows.length === 0) {
      await pool.query(`INSERT INTO course_registrations (student_id, course_id, status) VALUES ($1, $2, 'draft')`, [req.session.user.id, courseId]);
      req.flash('success', 'Course added to cart.');
    }
    
    res.redirect('/sis/my/registration');
  } catch (err) { 
    res.status(500).send("Error adding: " + err.message); 
  }
});

app.post('/sis/my/registration/remove', requireRole('student'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM course_registrations WHERE id = $1 AND student_id = $2 AND status = 'draft'`, [Number(req.body.cart_id), req.session.user.id]);
    res.redirect('/sis/my/registration');
  } catch (err) { res.status(500).send("Error removing: " + err.message); }
});

app.post('/sis/my/registration/submit', requireRole('student'), async (req, res) => {
  try {
    // ✅ NEW: Enforce min credit limit before submission
    const settingsRes = await pool.query(`SELECT * FROM registration_settings LIMIT 1`);
    const settings = settingsRes.rows[0] || { min_credits: 12, max_credits: 21 };
    
    const cartRes = await pool.query(`
      SELECT COALESCE(SUM(c.credits), 0) as total_credits
      FROM course_registrations cr
      JOIN courses c ON c.id = cr.course_id
      WHERE cr.student_id = $1 AND cr.status = 'draft'
    `, [req.session.user.id]);
    const cartCredits = Number(cartRes.rows[0].total_credits);
    
    if (cartCredits < settings.min_credits) {
      req.flash('error', `Cannot submit: You have ${cartCredits} credits but need at least ${settings.min_credits} to submit your registration.`);
      return res.redirect('/sis/my/registration');
    }
    
    await pool.query(`UPDATE course_registrations SET status = 'pending_advisor' WHERE student_id = $1 AND status = 'draft'`, [req.session.user.id]);
    req.flash('success', 'Registration submitted to your advisor for review.');
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
    // 1. STUDENT PROFILE
    const profileRes = await pool.query(`SELECT u.full_name, u.username, sp.class_level, sp.current_semester, sp.is_international, sp.high_school_gpa FROM users u JOIN student_profiles sp ON sp.user_id = u.id WHERE u.id = $1`, [req.session.user.id]);
    const student = profileRes.rows[0];

    // 2. SCHOLARSHIP ENGINE
    let scholarshipPercentage = 0;
    let scholarshipName = 'None';
    if (student.is_international) { scholarshipPercentage = 50; scholarshipName = 'International Scholarship'; }
    if (student.high_school_gpa >= 3.0 && student.high_school_gpa < 3.5) { scholarshipPercentage = 75; scholarshipName = 'Honor Scholarship'; }
    if (student.high_school_gpa >= 3.5 && student.high_school_gpa < 3.8) { scholarshipPercentage = 90; scholarshipName = 'High Honor Scholarship'; }
    if (student.high_school_gpa >= 3.8) { scholarshipPercentage = 100; scholarshipName = 'Full Merit Scholarship'; }

    // 3. CURRENT SEMESTER FEE
    const feeRes = await pool.query(`SELECT amount FROM fee_structure WHERE LOWER(program) = LOWER($1) AND semester = $2 LIMIT 1`, [student.class_level, student.current_semester]);
    const baseTuition = feeRes.rows.length > 0 ? Number(feeRes.rows[0].amount) : 0;
    const scholarshipAmount = (baseTuition * scholarshipPercentage) / 100;
    const netTuition = baseTuition - scholarshipAmount;

    // 4. NEXT SEMESTER FEE (Approaching Debt)
    const nextSem = Number(student.current_semester) + 1;
    const nextFeeRes = await pool.query(`SELECT amount FROM fee_structure WHERE LOWER(program) = LOWER($1) AND semester = $2 LIMIT 1`, [student.class_level, nextSem]);
    const nextBaseTuition = nextFeeRes.rows.length > 0 ? Number(nextFeeRes.rows[0].amount) : 0;
    const nextNetTuition = nextBaseTuition - ((nextBaseTuition * scholarshipPercentage) / 100);

    // 5. PAYMENTS
    const paidRes = await pool.query(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE student_id = $1`, [req.session.user.id]);
    const totalPaid = Number(paidRes.rows[0].total);

    // 6. BUILD TRANSACTIONS LEDGER
    const paymentsRes = await pool.query(`SELECT id, amount, created_at FROM payments WHERE student_id = $1`, [req.session.user.id]);
    
    let transactions = paymentsRes.rows.map(p => ({
      date: new Date(p.created_at).toLocaleDateString('en-GB').replace(/\//g, '.'),
      type: 'Payment',
      description: 'PAYMENT',
      charges: null,
      payments: Number(p.amount),
      installment: '-',
      term: '-',
      created_at: new Date(p.created_at).toLocaleString('en-GB')
    }));

    if (netTuition > 0) {
      transactions.push({
        date: new Date().toLocaleDateString('en-GB').replace(/\//g, '.'),
        type: 'Invoice',
        description: 'EDUCATION FEE, REGISTRATION FEE',
        charges: netTuition,
        payments: null,
        installment: '1. Installment',
        term: `2026-27 Fall (Term Based)`,
        created_at: new Date().toLocaleString('en-GB')
      });
    }
    
    transactions.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // 7. INSTALLMENT REQUESTS
    const instRes = await pool.query(`SELECT * FROM installment_requests WHERE student_id = $1 ORDER BY created_at DESC`, [req.session.user.id]);
    const installments = instRes.rows;
    const hasApprovedInstallment = installments.some(i => i.status === 'approved');

        // 8. DEBT MATH (aggregated from semester_invoices)
    const allInvoicesRes = await pool.query(`
            SELECT semester_number, net_amount, paid_amount, status, 
             base_amount, scholarship_amount, academic_year 
      FROM semester_invoices 
      WHERE student_id = $1 
      ORDER BY semester_number ASC
    `, [req.session.user.id]);
    const invoices = allInvoicesRes.rows;
    
    let currentDebt = 0;
    let approachingDebt = 0;
    let pastDueDebt = 0;
    
    invoices.forEach(inv => {
            const remaining = Math.round((Number(inv.net_amount) - Number(inv.paid_amount)) * 100) / 100;
      if (remaining < 0.01) return;
      if (Number(inv.semester_number) === Number(student.current_semester)) {
        currentDebt += remaining;
      } else if (Number(inv.semester_number) > Number(student.current_semester)) {
        approachingDebt += remaining;
      } else {
        pastDueDebt += remaining;
      }
    });
    
    const totalDebt = pastDueDebt + currentDebt + approachingDebt;

    // 9. AUTO-FLAG OVERDUE PAYMENTS
    await pool.query(`
      UPDATE installment_schedules 
      SET status = 'overdue' 
      WHERE student_id = $1 AND status = 'unpaid' AND due_date < CURRENT_DATE
    `, [req.session.user.id]);

    // 10. CALCULATE OVERDUE AMOUNT
    const overdueRes = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) as total_overdue
      FROM installment_schedules 
      WHERE student_id = $1 AND status = 'overdue'
    `, [req.session.user.id]);
    const overdueAmount = Number(overdueRes.rows[0].total_overdue);

    // 11. SEMESTER CALENDAR DATES
    const semRes = await pool.query(`SELECT semester_start_date, semester_end_date FROM student_profiles WHERE user_id = $1`, [req.session.user.id]);
    const semesterEndDate = semRes.rows[0]?.semester_end_date || null;
    const semesterStartDate = semRes.rows[0]?.semester_start_date || null;

    // 12. FETCH SCHEDULE
    const scheduleRes = await pool.query(`
      SELECT * FROM installment_schedules 
      WHERE student_id = $1 
      ORDER BY due_date ASC
    `, [req.session.user.id]);

    const hasOverdue = scheduleRes.rows.some(s => s.status === 'overdue');

    // 13. RENDER
    res.render('student-finance', { 
      user: req.session.user, 
      student, 
      baseTuition, 
      scholarshipName, 
      scholarshipPercentage, 
      scholarshipAmount, 
      netTuition, 
      totalPaid, 
            currentDebt: currentDebt > 0 ? currentDebt : 0,
      pastDueDebt: pastDueDebt > 0 ? pastDueDebt : 0,
      approachingDebt,
      totalDebt,
           installments,
      hasApprovedInstallment,
      invoices,
      transactions,
      schedule: scheduleRes.rows,
      hasOverdue,
      overdueAmount,
      semesterEndDate: semesterEndDate ? new Date(semesterEndDate).toISOString().split('T')[0] : null,
      semesterStartDate: semesterStartDate ? new Date(semesterStartDate).toISOString().split('T')[0] : null
    });
  } catch (err) { 
    res.status(500).send("Finance Error: " + err.message); 
  }
});

app.post('/sis/my/finance/installment/request', requireRole('student'), async (req, res) => {
  const { total_amount, installments_count } = req.body;
  try {
    await pool.query(`
      INSERT INTO installment_requests (student_id, total_amount, installments_count, status)
      VALUES ($1, $2, $3, 'pending')
    `, [req.session.user.id, Number(total_amount), Number(installments_count)]);

    req.flash('success', 'Installment request submitted! Awaiting Admin approval.');
    res.redirect('/sis/my/finance');
  } catch (err) {
    res.status(500).send("Installment Error: " + err.message);
  }
});

app.post('/sis/my/finance/pay', requireRole('student'), async (req, res) => {
  const { installment_id, amount } = req.body;
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    let payAmount = 0;
    let flashMsg = '';
    
    // If paying a specific installment
    if (installment_id) {
      const schedRes = await client.query(
        `SELECT * FROM installment_schedules WHERE id = $1 AND student_id = $2 AND status != 'paid'`,
        [installment_id, req.session.user.id]
      );
      if (schedRes.rows.length === 0) {
        await client.query('ROLLBACK');
        req.flash('error', 'Installment not found or already paid.');
        return res.redirect('/sis/my/finance');
      }
      payAmount = Number(schedRes.rows[0].amount);
      flashMsg = `Installment paid: $${payAmount.toFixed(2)}`;
      
      // Mark installment as paid
      await client.query(`UPDATE installment_schedules SET status = 'paid' WHERE id = $1`, [installment_id]);
    } else {
      payAmount = Number(amount);
      flashMsg = `Payment of $${payAmount.toFixed(2)} processed successfully.`;
    }
    
    // Record the payment
    await client.query(`INSERT INTO payments (student_id, amount) VALUES ($1, $2)`, [req.session.user.id, payAmount]);
    
    // ============================================
    // ✅ NEW: Apply payment to invoices (FIFO — oldest semester first)
    // ============================================
    const invoicesRes = await client.query(`
      SELECT id, semester_number, net_amount, paid_amount
      FROM semester_invoices
      WHERE student_id = $1 
        AND status != 'paid'
        AND net_amount > paid_amount
      ORDER BY semester_number ASC
    `, [req.session.user.id]);
    
    let remaining = payAmount;
    for (const inv of invoicesRes.rows) {
      if (remaining <= 0) break;
      
      const owed = Number(inv.net_amount) - Number(inv.paid_amount);
      const applyNow = Math.min(remaining, owed);
            const newPaid = Math.round((Number(inv.paid_amount) + applyNow) * 100) / 100;
      const newStatus = newPaid >= Number(inv.net_amount) ? 'paid' : 'partial';
      
      await client.query(`
        UPDATE semester_invoices 
        SET paid_amount = $1, status = $2 
        WHERE id = $3
      `, [newPaid, newStatus, inv.id]);
      
      remaining -= applyNow;
    }
    
    await client.query('COMMIT');
    
    req.flash('success', flashMsg);
    res.redirect('/sis/my/finance');
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).send("Payment Error: " + err.message);
  } finally {
    client.release();
  }
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
    const courses = await pool.query(`SELECT course_id FROM course_registrations WHERE student_id = $1 AND status = 'pending_advisor'`, [studentId]);
    
    for (const c of courses.rows) {
      const sec = await pool.query(`SELECT id FROM course_sections WHERE course_id = $1 LIMIT 1`, [c.course_id]);
      const sectionId = sec.rows.length > 0 ? sec.rows[0].id : null;
      await pool.query(`INSERT INTO enrollments (user_id, course_id, section_id) VALUES ($1, $2, $3)`, [studentId, c.course_id, sectionId]);
    }
    
    await pool.query(`UPDATE course_registrations SET status = 'approved' WHERE student_id = $1 AND status = 'pending_advisor'`, [studentId]);

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

    await pool.query(`
      INSERT INTO audit_logs (user_id, action, details) 
      VALUES ($1, 'REG_APPROVED', 'Approved course registration for student ID ${studentId}')
    `, [req.session.user.id]);

    res.redirect('/sis/advisor/approvals');
  } catch (err) { res.status(500).send("Error approving: " + err.message); }
});



// ============================================================
// DEAN - STAFF ASSIGNMENTS (READ-ONLY OVERSIGHT)
// ============================================================
app.get('/sis/dean/staff-assignments', requireRole('dean'), async (req, res) => {
  try {
    // Get the faculty assigned to the logged-in Dean.
    const facultyResult = await pool.query(`
      SELECT id, name, code
      FROM faculties
      WHERE dean_id = $1
      LIMIT 1
    `, [req.session.user.id]);

    if (!facultyResult.rows.length) {
      req.flash('error', 'No faculty is assigned to your Dean account.');
      return res.redirect('/sis/dean');
    }

    const faculty = facultyResult.rows[0];

    // Retrieve all semester advisor records in this faculty.
    const result = await pool.query(`
      SELECT
        d.id AS department_id,
        d.name AS department_name,
        d.code AS department_code,
        a.id AS assignment_id,
        a.semester_number,
        a.advisor_name,
        a.is_placeholder,
        a.updated_at
      FROM departments d
      LEFT JOIN department_semester_advisors a
        ON a.department_id = d.id
      WHERE d.faculty_id = $1
      ORDER BY d.name ASC, a.semester_number ASC
    `, [faculty.id]);

    const assignments = result.rows;

    // Calculate oversight statistics.
    const stats = {
      departments: new Set(
        assignments.map(a => a.department_id)
      ).size,

      assignments: assignments.filter(
        a => a.assignment_id !== null
      ).length,

      assigned: assignments.filter(
        a => a.assignment_id !== null && !a.is_placeholder
      ).length,

      placeholders: assignments.filter(
        a => a.assignment_id !== null && a.is_placeholder
      ).length
    };

    res.render('dean-staff-assignments', {
      user: req.session.user,
      faculty,
      assignments,
      stats
    });

  } catch (err) {
    console.error('Dean Staff Assignments Error:', err);
    res.status(500).send('Staff Assignments Error: ' + err.message);
  }
});



// ============================================
// --- DEAN PORTAL ---
// ============================================
app.get('/sis/dean', requireRole('dean'), async (req, res) => {
  try {
    // 1. Find the faculty assigned to the logged-in Dean.
    const deanCheck = await pool.query(`
      SELECT id, name, code, description
      FROM faculties
      WHERE dean_id = $1
      LIMIT 1
    `, [req.session.user.id]);

    if (deanCheck.rows.length === 0) {
      req.flash('error', 'You are not assigned as a Dean of any faculty.');
      return res.redirect('/sis/faculty');
    }

    const faculty = deanCheck.rows[0];

    // 2. Faculty statistics.
    const statsRes = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM departments
         WHERE faculty_id = $1) AS department_count,

        (SELECT COUNT(*) FROM users
         WHERE faculty_id = $1 AND role = 'student') AS student_count,

        (SELECT COUNT(*) FROM users
         WHERE faculty_id = $1
         AND role IN ('teacher', 'advisor', 'department_head')) AS staff_count,

        (SELECT COUNT(*) FROM users
         WHERE faculty_id = $1 AND role = 'teacher') AS teacher_count,

        (SELECT COUNT(*) FROM users
         WHERE faculty_id = $1 AND role = 'advisor') AS advisor_count,

        (SELECT COUNT(*) FROM users
         WHERE faculty_id = $1 AND role = 'department_head') AS department_head_count,

        (SELECT COUNT(*) FROM courses
         WHERE faculty_id = $1) AS course_count
    `, [faculty.id]);

    // 3. Departments and their Department Heads.
    const departmentsRes = await pool.query(`
      SELECT
        d.id,
        d.name,
        d.code,
        u.full_name AS head_name,
        u.username AS head_username
      FROM departments d
      LEFT JOIN users u ON u.id = d.head_id
      WHERE d.faculty_id = $1
      ORDER BY d.name
    `, [faculty.id]);

    // 4. Students belonging to this faculty.
    const studentsRes = await pool.query(`
      SELECT
        id,
        full_name,
        username,
        department_id
      FROM users
      WHERE faculty_id = $1 AND role = 'student'
      ORDER BY full_name
      LIMIT 100
    `, [faculty.id]);

    // 5. Faculty staff.
    const staffRes = await pool.query(`
      SELECT
        u.id,
        u.full_name,
        u.username,
        u.role,
        d.name AS department_name
      FROM users u
      LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.faculty_id = $1
        AND u.role IN ('teacher', 'advisor', 'department_head')
      ORDER BY u.full_name
    `, [faculty.id]);

    // 6. Faculty courses.
    const coursesRes = await pool.query(`
      SELECT code, title
      FROM courses
      WHERE faculty_id = $1
      ORDER BY title
    `, [faculty.id]);

    // 7. Recent academic activity.
    const activityRes = await pool.query(`
      SELECT
        CONCAT('Grade recorded: ', g.letter_grade) AS title,
        CONCAT(u.full_name, ' - ', c.code, ' ', c.title) AS description,
        g.created_at
      FROM grades g
      JOIN course_sections s ON s.id = g.section_id
      JOIN courses c ON c.id = s.course_id
      JOIN users u ON u.id = g.student_id
      WHERE c.faculty_id = $1
        AND g.letter_grade IS NOT NULL
      ORDER BY g.created_at DESC
      LIMIT 10
    `, [faculty.id]);

    // 8. Announcements placeholder.
    const announcements = [];

    // 9. Render the Dean dashboard.
    res.render('dean-dashboard', {
      user: req.session.user,
      faculty,
      stats: statsRes.rows[0],
      departments: departmentsRes.rows,
      students: studentsRes.rows,
      staff: staffRes.rows,
      courses: coursesRes.rows,
      activity: activityRes.rows,
      announcements
    });

  } catch (err) {
    console.error('Dean Dashboard Error:', err);
    res.status(500).send('Dean Dashboard Error: ' + err.message);
  }
});



// ============================================
// --- DEAN FACULTY PROFILE ---
// ============================================

app.get('/sis/dean/faculty-profile', requireRole('dean'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        id, name, code, description, logo_url,
        contact_email, contact_phone, office_location,
        website, established_year, mission, vision,
        objectives, office_hours
      FROM faculties
      WHERE dean_id = $1
      LIMIT 1
    `, [req.session.user.id]);

    if (result.rows.length === 0) {
      req.flash('error', 'No faculty is assigned to your Dean account.');
      return res.redirect('/sis/dean');
    }

    res.render('dean-faculty-profile', {
      user: req.session.user,
      faculty: result.rows[0],
      success: req.flash('success'),
      error: req.flash('error')
    });

  } catch (err) {
    console.error('Dean Faculty Profile Error:', err);
    res.status(500).send('Faculty Profile Error: ' + err.message);
  }
});

app.post('/sis/dean/faculty-profile', requireRole('dean'), async (req, res) => {
  try {
    const {
      description,
      logo_url,
      contact_email,
      contact_phone,
      office_location,
      website,
      office_hours,
      established_year,
      mission,
      vision,
      objectives
    } = req.body;

    const year = established_year === '' || established_year == null
      ? null
      : Number(established_year);

    if (year !== null &&
        (!Number.isInteger(year) || year < 1 || year > new Date().getFullYear())) {
      req.flash('error', 'Please enter a valid established year.');
      return res.redirect('/sis/dean/faculty-profile');
    }

    const result = await pool.query(`
      UPDATE faculties
      SET
        description = $1,
        logo_url = $2,
        contact_email = $3,
        contact_phone = $4,
        office_location = $5,
        website = $6,
        office_hours = $7,
        established_year = $8,
        mission = $9,
        vision = $10,
        objectives = $11
      WHERE dean_id = $12
      RETURNING id
    `, [
      description || null,
      logo_url || null,
      contact_email || null,
      contact_phone || null,
      office_location || null,
      website || null,
      office_hours || null,
      year,
      mission || null,
      vision || null,
      objectives || null,
      req.session.user.id
    ]);

    if (result.rows.length === 0) {
      req.flash('error', 'No assigned faculty was found. Nothing was saved.');
      return res.redirect('/sis/dean/faculty-profile');
    }

    req.flash('success', 'Faculty profile updated successfully.');
    return res.redirect('/sis/dean/faculty-profile');

  } catch (err) {
    console.error('Dean Faculty Profile Save Error:', err);
    req.flash('error', 'Unable to save faculty profile: ' + err.message);
    return res.redirect('/sis/dean/faculty-profile');
  }
});




// ============================================
// --- DEAN DEPARTMENT HEADS PAGE ---
// ============================================

app.get('/sis/dean/department-heads', requireRole('dean'), async (req, res) => {
  try {
    const facultyResult = await pool.query(`
      SELECT id, name, code
      FROM faculties
      WHERE dean_id = $1
      LIMIT 1
    `, [req.session.user.id]);

    if (!facultyResult.rows.length) {
      req.flash('error', 'No faculty is assigned to your Dean account.');
      return res.redirect('/sis/dean');
    }

    const faculty = facultyResult.rows[0];

    const departmentsResult = await pool.query(`
      SELECT
        d.id,
        d.name,
        d.code,
        d.head_id,
        u.full_name AS head_name,
        u.username AS head_username
      FROM departments d
      LEFT JOIN users u ON u.id = d.head_id
      WHERE d.faculty_id = $1
      ORDER BY d.name
    `, [faculty.id]);

    const candidatesResult = await pool.query(`
      SELECT id, full_name, username, role, department_id
      FROM users
      WHERE faculty_id = $1
        AND role IN ('teacher', 'advisor', 'department_head')
      ORDER BY full_name
    `, [faculty.id]);

    res.render('dean-department-heads', {
      user: req.session.user,
      faculty,
      departments: departmentsResult.rows,
      candidates: candidatesResult.rows,
      success: req.flash('success'),
      error: req.flash('error')
    });

  } catch (err) {
    console.error('Dean Department Heads Error:', err);
    res.status(500).send('Department Heads Error: ' + err.message);
  }
});
// ============================================
// --- DEAN DEPARTMENT MANAGEMENT ---
// ============================================

// Display Department Management
app.get('/sis/dean/departments', requireRole('dean'), async (req, res) => {
  try {
    // Identify the faculty assigned to this Dean.
    const facultyRes = await pool.query(
      `SELECT id, name, code
       FROM faculties
       WHERE dean_id = $1
       LIMIT 1`,
      [req.session.user.id]
    );

    if (facultyRes.rows.length === 0) {
      return res.status(403).send('No faculty is assigned to your Dean account.');
    }

    const faculty = facultyRes.rows[0];

    // Load departments and their statistics.
    const departmentsRes = await pool.query(`
      SELECT
        d.id,
        d.name,
        d.code,
        d.head_id,
        u.full_name AS head_name,
        u.username AS head_username,

        (SELECT COUNT(*)
         FROM users s
         WHERE s.department_id = d.id
         AND s.role = 'student') AS student_count,

        (SELECT COUNT(*)
         FROM users st
         WHERE st.department_id = d.id
         AND st.role IN ('teacher', 'advisor', 'department_head')) AS staff_count

      FROM departments d
      LEFT JOIN users u ON u.id = d.head_id
      WHERE d.faculty_id = $1
      ORDER BY d.name
    `, [faculty.id]);

    // Only staff belonging to this faculty can become Department Heads.
    const candidatesRes = await pool.query(`
      SELECT id, full_name, username, role
      FROM users
      WHERE faculty_id = $1
      AND role IN ('teacher', 'advisor', 'department_head')
      ORDER BY full_name
    `, [faculty.id]);

    const departments = departmentsRes.rows;

    const stats = {
      total: departments.length,
      assigned: departments.filter(d => d.head_id !== null).length,
      unassigned: departments.filter(d => d.head_id === null).length,
      students: departments.reduce((sum, d) => sum + Number(d.student_count), 0),
      staff: departments.reduce((sum, d) => sum + Number(d.staff_count), 0)
    };

    res.render('dean-departments', {
      user: req.session.user,
      faculty,
      departments,
      candidates: candidatesRes.rows,
      stats
    });

  } catch (err) {
    console.error('Dean Departments Error:', err);
    res.status(500).send('Unable to load Department Management.');
  }
});


// Create a Department
app.post('/sis/dean/departments/new', requireRole('dean'), async (req, res) => {
  try {
    const { name, code } = req.body;

    if (!name || !name.trim()) {
      req.flash('error', 'Department name is required.');
      return res.redirect('/sis/dean/departments');
    }

    const facultyRes = await pool.query(
      `SELECT id FROM faculties WHERE dean_id = $1 LIMIT 1`,
      [req.session.user.id]
    );

    if (facultyRes.rows.length === 0) {
      return res.status(403).send('No faculty is assigned to your account.');
    }

    await pool.query(`
      INSERT INTO departments (faculty_id, name, code)
      VALUES ($1, $2, $3)
    `, [
      facultyRes.rows[0].id,
      name.trim(),
      code && code.trim() ? code.trim() : null
    ]);

    req.flash('success', 'Department created successfully.');
    res.redirect('/sis/dean/departments');

  } catch (err) {
    console.error('Create Department Error:', err);
    req.flash('error', 'Unable to create department: ' + err.message);
    res.redirect('/sis/dean/departments');
  }
});


// Edit Department Details
app.post('/sis/dean/departments/:deptId/edit', requireRole('dean'), async (req, res) => {
  try {
    const { name, code } = req.body;
    const departmentId = Number(req.params.deptId);

    if (!Number.isInteger(departmentId) || departmentId <= 0) {
      return res.status(400).send('Invalid department.');
    }

    if (!name || !name.trim()) {
      req.flash('error', 'Department name is required.');
      return res.redirect('/sis/dean/departments');
    }

    const result = await pool.query(`
      UPDATE departments d
      SET name = $1, code = $2
      FROM faculties f
      WHERE d.id = $3
      AND d.faculty_id = f.id
      AND f.dean_id = $4
      RETURNING d.id
    `, [
      name.trim(),
      code && code.trim() ? code.trim() : null,
      departmentId,
      req.session.user.id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).send('Department not found in your faculty.');
    }

    req.flash('success', 'Department details updated successfully.');
    res.redirect('/sis/dean/departments');

  } catch (err) {
    console.error('Edit Department Error:', err);
    req.flash('error', 'Unable to update department: ' + err.message);
    res.redirect('/sis/dean/departments');
  }
});

// ============================================
// DEAN: CREATE OR REPLACE DEPARTMENT HEAD ACCOUNT
// ============================================

app.post(
  '/sis/dean/department-heads/create',
  requireRole('dean'),
  async (req, res) => {
    const client = await pool.connect();
    let transactionStarted = false;

    try {
      const fullName = String(req.body.full_name || '').trim();
      const username = String(req.body.username || '').trim();
      const email = String(req.body.email || '').trim().toLowerCase();
      const departmentId = Number(req.body.department_id);
      const defaultPassword = 'password123';

      if (
        !fullName ||
        !username ||
        !Number.isInteger(departmentId) ||
        departmentId <= 0
      ) {
        throw new Error('Enter the full name, username, and department.');
      }

      if (username.length < 3) {
        throw new Error('Username must contain at least 3 characters.');
      }

      const accountEmail = email || `${username}@luxmind.edu`;

      await client.query('BEGIN');
      transactionStarted = true;

      const departmentResult = await client.query(`
        SELECT d.id, d.name, d.faculty_id, d.head_id
        FROM departments d
        JOIN faculties f ON f.id = d.faculty_id
        WHERE d.id = $1
          AND f.dean_id = $2
        FOR UPDATE OF d
      `, [departmentId, req.session.user.id]);

      if (!departmentResult.rows.length) {
        throw new Error('Department not found in your faculty.');
      }

      const department = departmentResult.rows[0];

      const duplicateResult = await client.query(`
        SELECT id
        FROM users
        WHERE LOWER(username) = LOWER($1)
           OR LOWER(email) = LOWER($2)
        LIMIT 1
      `, [username, accountEmail]);

      if (duplicateResult.rows.length) {
        throw new Error('That username or email is already registered.');
      }

      // Restore the previous head's original role if replacing someone.
      if (department.head_id) {
        await client.query(`
          UPDATE users
          SET role = COALESCE(department_head_previous_role, 'teacher'),
              department_head_previous_role = NULL
          WHERE id = $1
            AND role = 'department_head'
        `, [department.head_id]);
      }

      // Create the new Department Head account.
      const userResult = await client.query(`
        INSERT INTO users (
          full_name,
          username,
          email,
          password,
          role,
          faculty_id,
          department_id,
          department_head_previous_role
        )
        VALUES ($1, $2, $3, $4, 'department_head', $5, $6, NULL)
        RETURNING id
      `, [
        fullName,
        username,
        accountEmail,
        defaultPassword,
        department.faculty_id,
        department.id
      ]);

      // Assign the new account, replacing the previous head if necessary.
      await client.query(`
        UPDATE departments
        SET head_id = $1
        WHERE id = $2
      `, [userResult.rows[0].id, department.id]);

      await client.query('COMMIT');
      transactionStarted = false;

      req.flash(
        'success',
        `Department Head account created and assigned to ${department.name}. Username: ${username}. Temporary password: ${defaultPassword}`
      );

      return res.redirect('/sis/dean/department-heads');

    } catch (err) {
      if (transactionStarted) {
        await client.query('ROLLBACK');
      }

      console.error('Create Department Head Error:', err);
      req.flash('error', 'Unable to create Department Head: ' + err.message);
      return res.redirect('/sis/dean/department-heads');

    } finally {
      client.release();
    }
  }
);


// ============================================
// DEAN: EDIT DEPARTMENT HEAD ACCOUNT DETAILS
// ============================================

app.post(
  '/sis/dean/department-heads/:headId/edit',
  requireRole('dean'),
  async (req, res) => {
    try {
      const headId = Number(req.params.headId);
      const fullName = String(req.body.full_name || '').trim();
      const username = String(req.body.username || '').trim();
      const email = String(req.body.email || '').trim().toLowerCase();

      if (!Number.isInteger(headId) || headId <= 0) {
        throw new Error('Invalid Department Head account.');
      }

      if (!fullName || !username || username.length < 3 || !email) {
        throw new Error('Enter a full name, username of at least 3 characters, and email address.');
      }

      // Only edit an account currently heading a department in this Dean's faculty.
      const headResult = await pool.query(`
        SELECT u.id
        FROM users u
        JOIN departments d ON d.head_id = u.id
        JOIN faculties f ON f.id = d.faculty_id
        WHERE u.id = $1
          AND u.role = 'department_head'
          AND f.dean_id = $2
        LIMIT 1
      `, [headId, req.session.user.id]);

      if (!headResult.rows.length) {
        throw new Error('Department Head account not found in your faculty.');
      }

      const duplicateResult = await pool.query(`
        SELECT id
        FROM users
        WHERE (LOWER(username) = LOWER($1)
            OR LOWER(email) = LOWER($2))
          AND id <> $3
        LIMIT 1
      `, [username, email, headId]);

      if (duplicateResult.rows.length) {
        throw new Error('Another account already uses that username or email.');
      }

      await pool.query(`
        UPDATE users
        SET full_name = $1,
            username = $2,
            email = $3
        WHERE id = $4
      `, [fullName, username, email, headId]);

      req.flash('success', 'Department Head account details updated successfully.');
      return res.redirect('/sis/dean/department-heads');

    } catch (err) {
      console.error('Edit Department Head Error:', err);
      req.flash('error', 'Unable to edit Department Head: ' + err.message);
      return res.redirect('/sis/dean/department-heads');
    }
  }
);

// Assign, Replace, or Remove a Department Head
app.post(
  '/sis/dean/departments/:deptId/assign-head',
  requireRole('dean'),
  async (req, res) => {

    const client = await pool.connect();

    try {
      const departmentId = Number(req.params.deptId);
      const newHeadId = req.body.head_id
        ? Number(req.body.head_id)
        : null;

      if (!Number.isInteger(departmentId) || departmentId <= 0) {
        throw new Error('Invalid department.');
      }

      await client.query('BEGIN');

      // Lock the department and verify that it belongs to this Dean's faculty.
      const departmentRes = await client.query(`
        SELECT d.id, d.head_id
        FROM departments d
        JOIN faculties f ON f.id = d.faculty_id
        WHERE d.id = $1
        AND f.dean_id = $2
        FOR UPDATE OF d
      `, [departmentId, req.session.user.id]);

      if (departmentRes.rows.length === 0) {
        throw new Error('Department not found in your faculty.');
      }

      const oldHeadId = departmentRes.rows[0].head_id;

      // Remove the current Department Head.
      if (newHeadId === null) {
        if (oldHeadId) {
          await client.query(`
            UPDATE users
            SET role = COALESCE(department_head_previous_role, 'teacher'),
                department_head_previous_role = NULL
            WHERE id = $1 AND role = 'department_head'
          `, [oldHeadId]);
        }

        await client.query(`
          UPDATE departments
          SET head_id = NULL
          WHERE id = $1
        `, [departmentId]);

        await client.query('COMMIT');

        req.flash('success', 'Department Head removed successfully.');
        return res.redirect('/sis/dean/departments');
      }

      if (!Number.isInteger(newHeadId) || newHeadId <= 0) {
        throw new Error('Invalid Department Head account.');
      }

      if (oldHeadId === newHeadId) {
        await client.query('COMMIT');
        req.flash('success', 'This person is already the Department Head.');
        return res.redirect('/sis/dean/departments');
      }

      // Verify that the selected staff member belongs to this faculty.
      const newUserRes = await client.query(`
        SELECT id, role, department_head_previous_role
        FROM users
        WHERE id = $1
        AND faculty_id = (
          SELECT faculty_id
          FROM departments
          WHERE id = $2
        )
        FOR UPDATE
      `, [newHeadId, departmentId]);

      if (newUserRes.rows.length === 0) {
        throw new Error('Selected user does not belong to your faculty.');
      }

      const newUser = newUserRes.rows[0];

      if (!['teacher', 'advisor', 'department_head'].includes(newUser.role)) {
        throw new Error('Only teachers or advisors can be appointed.');
      }

      // Prevent one person from heading multiple departments.
      const existingAssignment = await client.query(`
        SELECT id, name
        FROM departments
        WHERE head_id = $1
        AND id <> $2
        LIMIT 1
      `, [newHeadId, departmentId]);

      if (existingAssignment.rows.length > 0) {
        throw new Error(
          `This user already heads ${existingAssignment.rows[0].name}.`
        );
      }

      // Restore the previous Department Head's original role.
      if (oldHeadId) {
        await client.query(`
          UPDATE users
          SET role = COALESCE(department_head_previous_role, 'teacher'),
              department_head_previous_role = NULL
          WHERE id = $1 AND role = 'department_head'
        `, [oldHeadId]);
      }

      // Save the new head's previous role and promote their account.
      await client.query(`
        UPDATE users
        SET department_head_previous_role =
              CASE
                WHEN role = 'department_head'
                THEN department_head_previous_role
                ELSE role
              END,
            role = 'department_head'
        WHERE id = $1
      `, [newHeadId]);

      // Record the appointment.
      await client.query(`
        UPDATE departments
        SET head_id = $1
        WHERE id = $2
      `, [newHeadId, departmentId]);

      await client.query('COMMIT');

      req.flash('success', 'Department Head appointed successfully.');
      res.redirect('/sis/dean/departments');

    } catch (err) {
      await client.query('ROLLBACK');

      console.error('Dean Department Head Assignment Error:', err);
      req.flash('error', err.message);
      res.redirect('/sis/dean/departments');

    } finally {
      client.release();
    }
  }
);


// ============================================================
// DEAN - FACULTY STAFF WORKSPACE
// ============================================================
app.get('/sis/dean/faculty-staff', requireRole('dean'), async (req, res) => {
  try {
    const facultyResult = await pool.query(`
      SELECT id, name, code
      FROM faculties
      WHERE dean_id = $1
      LIMIT 1
    `, [req.session.user.id]);

    if (!facultyResult.rows.length) {
      req.flash('error', 'No faculty is assigned to your Dean account.');
      return res.redirect('/sis/dean');
    }

    const faculty = facultyResult.rows[0];

    const staffResult = await pool.query(`
      SELECT
        u.id,
        u.full_name,
        u.username,
        u.email,
        u.role,
        u.department_id,
        d.name AS department_name,
        CASE
          WHEN d.head_id = u.id THEN TRUE
          ELSE FALSE
        END AS is_department_head
      FROM users u
      LEFT JOIN departments d
        ON d.id = u.department_id
       AND d.faculty_id = u.faculty_id
      WHERE u.faculty_id = $1
        AND u.role IN ('teacher', 'advisor', 'department_head')
      ORDER BY
        CASE u.role
          WHEN 'department_head' THEN 1
          WHEN 'teacher' THEN 2
          WHEN 'advisor' THEN 3
          ELSE 4
        END,
        u.full_name ASC NULLS LAST
    `, [faculty.id]);

    const departmentsResult = await pool.query(`
      SELECT id, name, code, head_id
      FROM departments
      WHERE faculty_id = $1
      ORDER BY name
    `, [faculty.id]);

    const staff = staffResult.rows;
    const departments = departmentsResult.rows;

    const stats = {
      total: staff.length,
      teachers: staff.filter(s => s.role === 'teacher').length,
      advisors: staff.filter(s => s.role === 'advisor').length,
      departmentHeads: staff.filter(
        s => s.role === 'department_head'
      ).length
    };

    res.render('dean-faculty-staff', {
      user: req.session.user,
      faculty,
      staff,
      departments,
      stats,
      success: req.flash('success'),
      error: req.flash('error')
    });

  } catch (err) {
    console.error('Dean Faculty Staff Error:', err);
    res.status(500).send('Faculty Staff Error: ' + err.message);
  }
});


// ============================================
// --- DEPARTMENT HEAD PORTAL ---
// ============================================
app.get('/sis/department-head', requireRole('department_head'), async (req, res) => {
  try {
    // Find the department assigned to the logged-in user.
    const departmentRes = await pool.query(`
      SELECT
        d.id,
        d.name,
        d.code,
        f.name AS faculty_name
      FROM departments d
      JOIN faculties f ON f.id = d.faculty_id
      WHERE d.head_id = $1
      LIMIT 1
    `, [req.session.user.id]);

    if (departmentRes.rows.length === 0) {
      return res.status(403).send(
        'Access denied: You are not assigned as a Department Head.'
      );
    }

    const department = departmentRes.rows[0];

    // Department statistics.
    const statsRes = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users
         WHERE department_id = $1 AND role = 'student') AS student_count,

        (SELECT COUNT(*) FROM users
         WHERE department_id = $1
         AND role IN ('teacher', 'advisor')) AS staff_count,

        (SELECT COUNT(*) FROM users
         WHERE department_id = $1 AND role = 'teacher') AS teacher_count,

        (SELECT COUNT(*) FROM users
         WHERE department_id = $1 AND role = 'advisor') AS advisor_count
    `, [department.id]);

    // Department students.
    const studentsRes = await pool.query(`
      SELECT id, full_name, username
      FROM users
      WHERE department_id = $1 AND role = 'student'
      ORDER BY full_name
      LIMIT 10
    `, [department.id]);

    // Department teaching and advising staff.
    const staffRes = await pool.query(`
      SELECT id, full_name, username, role
      FROM users
      WHERE department_id = $1
      AND role IN ('teacher', 'advisor')
      ORDER BY full_name
    `, [department.id]);

    // Recent academic activity within this department.
    const activityRes = await pool.query(`
      SELECT
        g.letter_grade,
        c.code,
        c.title,
        u.full_name AS student_name,
        g.created_at
      FROM grades g
      JOIN course_sections s ON s.id = g.section_id
      JOIN courses c ON c.id = s.course_id
      JOIN users u ON u.id = g.student_id
      WHERE u.department_id = $1
      AND g.letter_grade IS NOT NULL
      ORDER BY g.created_at DESC
      LIMIT 10
    `, [department.id]);

    res.render('department-head-dashboard', {
      user: req.session.user,
      department: department,
      stats: statsRes.rows[0],
      students: studentsRes.rows,
      staff: staffRes.rows,
      activity: activityRes.rows
    });

  } catch (err) {
    console.error('Department Head Dashboard Error:', err);
    res.status(500).send('Department Head Dashboard Error: ' + err.message);
  }
});


// ============================================
// --- FACULTY ROUTES ---
// ============================================


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
    const studentsCount = await pool.query(`SELECT COUNT(*) FROM users WHERE role = 'student'`);
    const teachersCount = await pool.query(`SELECT COUNT(*) FROM users WHERE role = 'teacher'`);
    const coursesCount = await pool.query(`SELECT COUNT(*) FROM courses`);
    const pendingRegs = await pool.query(`SELECT COUNT(*) FROM course_registrations WHERE status = 'pending_advisor'`);
    const pendingDocs = await pool.query(`SELECT COUNT(*) FROM document_requests WHERE status = 'pending'`);

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

    const finRes = await pool.query(`
      WITH StudentBilling AS (
        SELECT u.id,
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

    let targetedMessages = [];
    try {
      const targetedRes = await pool.query(`
        SELECT * FROM targeted_announcements WHERE sender_id = $1 ORDER BY created_at DESC LIMIT 5
      `, [req.session.user.id]);
      targetedMessages = targetedRes.rows;
    } catch(e) { targetedMessages = []; }

    res.render('admin-dashboard', { 
      user: req.session.user, 
      greeting: getGreeting(), 
      stats: { 
        students: studentsCount.rows[0].count, 
        teachers: teachersCount.rows[0].count, 
        courses: coursesCount.rows[0].count, 
        pendingRegs: pendingRegs.rows[0].count,
        pendingDocs: pendingDocs.rows[0].count
      },
      chartData: {
        facultyLabels,
        facultyData,
        totalPaid,
        totalOutstanding
      },
      targetedMessages
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
    const advisorsRes = await pool.query(`SELECT id, full_name FROM users WHERE role = 'advisor' ORDER BY full_name`);
    const facultiesRes = await pool.query(`SELECT id, name, code FROM faculties WHERE is_active = true ORDER BY name`);
    const departmentsRes = await pool.query(`SELECT id, name, code, faculty_id FROM departments ORDER BY name`);
    res.render('admin-student-new', { 
      user: req.session.user, 
      advisors: advisorsRes.rows,
      faculties: facultiesRes.rows,
      departments: departmentsRes.rows
    });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.post('/sis/admin/students/new', requireRole('admin'), async (req, res) => {
  const { full_name, username, email, class_level, advisor_id, admission_number, is_international, high_school_gpa, faculty_id, department_id } = req.body;
  const defaultPassword = 'Student2026!';
  const generatedId = admission_number || 'LUX-' + Math.floor(100000 + Math.random() * 900000);
  try {
    const userRes = await pool.query(
      `INSERT INTO users (full_name, username, email, password, role, faculty_id, department_id) 
       VALUES ($1, $2, $3, $4, 'student', $5, $6) RETURNING id`, 
      [full_name, username, email || username + '@luxmind.edu', defaultPassword, 
       faculty_id ? Number(faculty_id) : null, 
       department_id ? Number(department_id) : null]
    );
    const userId = userRes.rows[0].id;
    await pool.query(
      `INSERT INTO student_profiles (user_id, admission_number, class_level, current_semester, advisor_id, is_international, high_school_gpa) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)`, 
      [userId, generatedId, class_level || 'Computer Engineering', 1, 
       advisor_id ? Number(advisor_id) : null, 
       is_international === 'true', 
       high_school_gpa ? Number(high_school_gpa) : null]
    );
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

app.get('/sis/admin/teachers/new', requireRole('admin'), async (req, res) => {
  try {
    const facultiesRes = await pool.query(`SELECT id, name, code FROM faculties WHERE is_active = true ORDER BY name`);
    const departmentsRes = await pool.query(`SELECT id, name, code, faculty_id FROM departments ORDER BY name`);
    res.render('admin-teacher-new', { 
      user: req.session.user,
      faculties: facultiesRes.rows,
      departments: departmentsRes.rows
    });
  } catch (err) { res.status(500).send("Error: " + err.message); }
});

app.post('/sis/admin/teachers/new', requireRole('admin'), async (req, res) => {
  const { full_name, username, email, faculty_id, department_id } = req.body;
  const defaultPassword = 'Teacher2026!';
  try {
    await pool.query(
      `INSERT INTO users (full_name, username, email, password, role, faculty_id, department_id) 
       VALUES ($1, $2, $3, $4, 'teacher', $5, $6)`, 
      [full_name, username, email || username + '@luxmind.edu', defaultPassword,
       faculty_id ? Number(faculty_id) : null,
       department_id ? Number(department_id) : null]
    );
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
    const coursesRes = await pool.query(`
      SELECT c.*, f.name AS faculty_name, d.name AS department_name,
             p.code AS prereq_code 
      FROM courses c
      LEFT JOIN faculties f ON f.id = c.faculty_id
      LEFT JOIN departments d ON d.id = c.department_id
      LEFT JOIN courses p ON p.id = c.prerequisite_id
      ORDER BY c.semester_number ASC, c.code ASC
    `);
    const facultiesRes = await pool.query(`SELECT id, name, code FROM faculties WHERE is_active = true ORDER BY name`);
    const departmentsRes = await pool.query(`SELECT id, name, code, faculty_id FROM departments ORDER BY name`);
    res.render('admin-courses', { 
      user: req.session.user, 
      courses: coursesRes.rows,
      faculties: facultiesRes.rows,
      departments: departmentsRes.rows
    });
  } catch (err) { res.status(500).send("Course Catalog Error: " + err.message); }
});

app.post('/sis/admin/courses/new', requireRole('admin'), async (req, res) => {
  const { code, title, credits, semester_number, prerequisite_id, quota, faculty_id, department_id } = req.body;
  try {
    await pool.query(`
      INSERT INTO courses (code, title, credits, semester_number, prerequisite_id, quota, faculty_id, department_id) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      code, 
      title, 
      Number(credits), 
      Number(semester_number), 
      prerequisite_id ? Number(prerequisite_id) : null, 
      quota ? Number(quota) : 40,
      faculty_id ? Number(faculty_id) : null,
      department_id ? Number(department_id) : null
    ]);
    req.flash('success', `Course ${code} created successfully.`);
    res.redirect('/sis/admin/courses');
  } catch (err) {
    req.flash('error', 'Error creating course: ' + err.message);
    res.redirect('/sis/admin/courses');
  }
});

// ============================================
// --- CENTRAL ADMIN: FACULTY & ACADEMIC UNITS ---
// ============================================
app.get('/sis/admin/faculties', requireRole('admin'), async (req, res) => {
  try {
    const facultiesRes = await pool.query(`
      SELECT f.*, u.full_name AS dean_name,
        (SELECT COUNT(*) FROM departments d WHERE d.faculty_id = f.id) AS dept_count,
        (SELECT COUNT(*) FROM courses c WHERE c.faculty_id = f.id) AS course_count,
        (SELECT COUNT(*) FROM users usr WHERE usr.faculty_id = f.id AND usr.role IN ('teacher','advisor')) AS staff_count,
        (SELECT COUNT(*) FROM users usr WHERE usr.faculty_id = f.id AND usr.role = 'student') AS student_count
      FROM faculties f
      LEFT JOIN users u ON u.id = f.dean_id
      ORDER BY f.name
    `);
    const deansRes = await pool.query(`SELECT id, full_name FROM users WHERE role IN ('teacher', 'advisor') ORDER BY full_name`);
    
    res.render('admin-faculties', {
      user: req.session.user,
      faculties: facultiesRes.rows,
      deans: deansRes.rows
    });
  } catch (err) { res.status(500).send("Faculty Error: " + err.message); }
});

app.post('/sis/admin/faculties/new', requireRole('admin'), async (req, res) => {
  const { name, code, dean_id, description } = req.body;
  try {
    await pool.query(`INSERT INTO faculties (name, code, dean_id, description) VALUES ($1, $2, $3, $4)`, 
      [name, code.toUpperCase(), dean_id ? Number(dean_id) : null, description || null]);
    req.flash('success', `Faculty "${name}" created successfully.`);
    res.redirect('/sis/admin/faculties');
  } catch (err) { 
    req.flash('error', 'Error: ' + err.message);
    res.redirect('/sis/admin/faculties'); 
  }
});

app.get('/sis/admin/faculties/:id', requireRole('admin'), async (req, res) => {
  try {
    const facultyRes = await pool.query(`
      SELECT f.*, u.full_name AS dean_name FROM faculties f
      LEFT JOIN users u ON u.id = f.dean_id WHERE f.id = $1
    `, [req.params.id]);
    if (facultyRes.rows.length === 0) return res.redirect('/sis/admin/faculties');
    
    const departmentsRes = await pool.query(`
      SELECT d.*, u.full_name AS head_name,
        (SELECT COUNT(*) FROM users usr WHERE usr.department_id = d.id AND usr.role = 'student') AS student_count
      FROM departments d
      LEFT JOIN users u ON u.id = d.head_id
      WHERE d.faculty_id = $1 ORDER BY d.name
    `, [req.params.id]);
    
    const teachersRes = await pool.query(`
  SELECT id, full_name
  FROM users
  WHERE role IN ('teacher', 'advisor', 'department_head')
  ORDER BY full_name
`);
    
    res.render('admin-faculty-detail', {
      user: req.session.user,
      faculty: facultyRes.rows[0],
      departments: departmentsRes.rows,
      teachers: teachersRes.rows
    });
  } catch (err) { res.status(500).send("Faculty Detail Error: " + err.message); }
});

app.post('/sis/admin/faculties/:id/assign-dean', requireRole('admin'), async (req, res) => {
  const { dean_id } = req.body;
  try {
    await pool.query(`UPDATE faculties SET dean_id = $1 WHERE id = $2`, 
      [dean_id ? Number(dean_id) : null, req.params.id]);
    req.flash('success', 'Dean assigned successfully.');
    res.redirect(`/sis/admin/faculties/${req.params.id}`);
  } catch (err) { 
    req.flash('error', 'Error: ' + err.message);
    res.redirect(`/sis/admin/faculties/${req.params.id}`);
  }
});

app.post('/sis/admin/faculties/:id/departments/new', requireRole('admin'), async (req, res) => {
  const { name, code, head_id } = req.body;
  try {
    await pool.query(`INSERT INTO departments (faculty_id, name, code, head_id) VALUES ($1, $2, $3, $4)`,
      [req.params.id, name, code || null, head_id ? Number(head_id) : null]);
    req.flash('success', `Department "${name}" created successfully.`);
    res.redirect(`/sis/admin/faculties/${req.params.id}`);
  } catch (err) { 
    req.flash('error', 'Error: ' + err.message);
    res.redirect(`/sis/admin/faculties/${req.params.id}`);
  }
});


app.post(
  '/sis/admin/faculties/:facultyId/departments/:deptId/assign-head',
  requireRole('admin'),
  async (req, res) => {
    const client = await pool.connect();

    try {
      const facultyId = Number(req.params.facultyId);
      const departmentId = Number(req.params.deptId);
      const newHeadId = req.body.head_id
        ? Number(req.body.head_id)
        : null;

      await client.query('BEGIN');

      // Confirm that this department belongs to the selected faculty.
      const departmentRes = await client.query(
        `SELECT id, head_id
         FROM departments
         WHERE id = $1 AND faculty_id = $2
         FOR UPDATE`,
        [departmentId, facultyId]
      );

      if (departmentRes.rows.length === 0) {
        throw new Error('Department not found in this faculty.');
      }

      const oldHeadId = departmentRes.rows[0].head_id;

      // If the administrator removes the Department Head.
      if (!newHeadId) {
        if (oldHeadId) {
          await client.query(
            `UPDATE users
             SET role = COALESCE(department_head_previous_role, 'teacher'),
                 department_head_previous_role = NULL
             WHERE id = $1 AND role = 'department_head'`,
            [oldHeadId]
          );
        }

        await client.query(
          `UPDATE departments
           SET head_id = NULL
           WHERE id = $1`,
          [departmentId]
        );

        await client.query('COMMIT');

        req.flash('success', 'Department Head removed successfully.');
        return res.redirect(`/sis/admin/faculties/${facultyId}`);
      }

      if (!Number.isInteger(newHeadId)) {
        throw new Error('Invalid Department Head account.');
      }

      // Do nothing if the selected person is already the head.
      if (oldHeadId === newHeadId) {
        await client.query('COMMIT');
        req.flash('success', 'This person is already the Department Head.');
        return res.redirect(`/sis/admin/faculties/${facultyId}`);
      }

      // Lock and validate the new Department Head account.
      const newUserRes = await client.query(
        `SELECT id, role, department_head_previous_role
         FROM users
         WHERE id = $1
         FOR UPDATE`,
        [newHeadId]
      );

      if (newUserRes.rows.length === 0) {
        throw new Error('Selected user does not exist.');
      }

      const newUser = newUserRes.rows[0];

      if (!['teacher', 'advisor', 'department_head'].includes(newUser.role)) {
        throw new Error('Only teachers or advisors can be appointed.');
      }

      // A person cannot head two departments simultaneously.
      const existingAssignment = await client.query(
        `SELECT id, name
         FROM departments
         WHERE head_id = $1 AND id <> $2
         LIMIT 1`,
        [newHeadId, departmentId]
      );

      if (existingAssignment.rows.length > 0) {
        throw new Error(
          `This user already heads ${existingAssignment.rows[0].name}.`
        );
      }

      // Restore the previous head's original role.
      if (oldHeadId) {
        await client.query(
          `UPDATE users
           SET role = COALESCE(department_head_previous_role, 'teacher'),
               department_head_previous_role = NULL
           WHERE id = $1 AND role = 'department_head'`,
          [oldHeadId]
        );
      }

      // Save the new head's previous role and promote their account.
      await client.query(
        `UPDATE users
         SET department_head_previous_role =
               CASE
                 WHEN role = 'department_head'
                 THEN department_head_previous_role
                 ELSE role
               END,
             role = 'department_head'
         WHERE id = $1`,
        [newHeadId]
      );

      // Record the official appointment.
      await client.query(
        `UPDATE departments
         SET head_id = $1
         WHERE id = $2`,
        [newHeadId, departmentId]
      );

      await client.query('COMMIT');

      req.flash('success', 'Department Head appointed successfully.');
      res.redirect(`/sis/admin/faculties/${facultyId}`);

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Department Head Assignment Error:', err);
      req.flash('error', err.message);
      res.redirect(`/sis/admin/faculties/${req.params.facultyId}`);

    } finally {
      client.release();
    }
  }
);


app.post('/sis/admin/faculties/:id/toggle', requireRole('admin'), async (req, res) => {
  try {
    await pool.query(`UPDATE faculties SET is_active = NOT is_active WHERE id = $1`, [req.params.id]);
    req.flash('success', 'Faculty status updated.');
    res.redirect('/sis/admin/faculties');
  } catch (err) { res.status(500).send("Toggle Error: " + err.message); }
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

// ============================================
// --- CENTRAL ADMIN: STUDENT REGISTRATIONS ---
// ============================================
app.get('/sis/admin/registrations', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        cr.id AS reg_id,
        cr.requested_at,
        cr.status,
        u.full_name AS student_name,
        u.username,
        c.code AS course_code,
        c.title AS course_title
      FROM course_registrations cr
      JOIN users u ON u.id = cr.student_id
      JOIN courses c ON c.id = cr.course_id
      WHERE cr.status = 'pending_advisor'
      ORDER BY cr.requested_at DESC
    `);

    res.render('admin-registrations', {
      user: req.session.user,
      registrations: result.rows,
      flash: req.flash ? req.flash() : {}
    });
  } catch (err) {
    res.status(500).send("Registrations Error: " + err.message);
  }
});

// ============================================
// --- CENTRAL ADMIN: COURSE WITHDRAWALS ---
// ============================================
app.get('/sis/admin/withdrawals', requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        w.id AS withdrawal_id,
        w.reason,
        w.requested_at,
        u.full_name AS student_name,
        u.username,
        c.code AS course_code,
        c.title AS course_title
      FROM course_withdrawals w
      JOIN users u ON u.id = w.student_id
      JOIN courses c ON c.id = w.course_id
      WHERE w.status = 'pending'
      ORDER BY w.requested_at DESC
    `);

    res.render('admin-withdrawals', {
      user: req.session.user,
      withdrawals: result.rows
    });
  } catch (err) {
    res.status(500).send("Withdrawals Error: " + err.message);
  }
});

app.post('/sis/admin/registrations/:id/action', requireRole('admin'), async (req, res) => {
  try {
    const regId = req.params.id;
    const action = req.body.action;
    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    await pool.query(`
      UPDATE course_registrations
      SET status = $1
      WHERE id = $2
    `, [newStatus, regId]);

    if (req.flash) req.flash('success', `Registration ${newStatus} successfully.`);
    res.redirect('/sis/admin/registrations');
  } catch (err) {
    res.status(500).send("Action Error: " + err.message);
  }
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

    await pool.query(`
      INSERT INTO audit_logs (user_id, action, details) 
      VALUES ($1, 'DOC_${status.toUpperCase()}', 'Updated document request ID ${requestId} to ${status}')
    `, [req.session.user.id]);

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

    await pool.query(`
      UPDATE grades 
      SET is_published = true, published_at = NOW()
      WHERE section_id = $1 AND letter_grade IS NOT NULL
    `, [sectionId]);

    req.flash('success', 'Grades published successfully. Students can now see their results.');
    res.redirect('/sis/faculty/publish-results');
  } catch (err) { res.status(500).send("Publish Error: " + err.message); }
});

// ============================================
// --- START SERVER ---
// ============================================
const PORT = process.env.PORT || 3000;
// ======================================================
// DEAN - STAFF ASSIGNMENTS OVERSIGHT
// Read-only view of semester advisor assignments
// ======================================================
app.get(
  '/sis/dean/staff-assignments',
  requireRole('dean'),
  async (req, res) => {
    try {
      const facultyResult = await pool.query(
        `SELECT id, name, code
         FROM faculties
         WHERE dean_id = $1
         LIMIT 1`,
        [req.session.user.id]
      );

      if (facultyResult.rows.length === 0) {
        req.flash('error', 'No faculty is assigned to your Dean account.');
        return res.redirect('/sis/faculty');
      }

      const faculty = facultyResult.rows[0];

      const assignmentsResult = await pool.query(
        `SELECT
            d.id AS department_id,
            d.name AS department_name,
            d.code AS department_code,
            a.id AS assignment_id,
            a.semester_number,
            a.advisor_name,
            a.is_placeholder,
            a.updated_at
         FROM departments d
         LEFT JOIN department_semester_advisors a
            ON a.department_id = d.id
         WHERE d.faculty_id = $1
         ORDER BY d.name ASC, a.semester_number ASC`,
        [faculty.id]
      );

      const assignments = assignmentsResult.rows;

      const departmentResult = await pool.query(
        `SELECT COUNT(*)::int AS total
         FROM departments
         WHERE faculty_id = $1`,
        [faculty.id]
      );

      const stats = {
        departments: departmentResult.rows[0].total,
        assignments: assignments.filter(a => a.assignment_id !== null).length,
        assigned: assignments.filter(
          a => a.assignment_id !== null && !a.is_placeholder
        ).length,
        placeholders: assignments.filter(
          a => a.assignment_id !== null && a.is_placeholder
        ).length
      };

      res.render('dean-staff-assignments', {
        user: req.session.user,
        faculty,
        assignments,
        stats
      });

    } catch (err) {
      console.error('Dean Staff Assignments Error:', err);
      req.flash(
        'error',
        'Unable to load staff assignments: ' + err.message
      );
      res.redirect('/sis/dean');
    }
  }
);
app.listen(PORT, () => {
  console.log(`✅ LuxMind SIS running on port ${PORT}`);
});