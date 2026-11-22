/**
 * ============================================================
 * LUXMIND TIMETABLE ENGINE — v1.1
 * ============================================================
 *
 * USAGE:
 *   node timetable_solver.js                → fill only unscheduled sections
 *   node timetable_solver.js --force        → reschedule EVERYTHING (ignores locks)
 *   node timetable_solver.js --dry-run      → simulate without writing to DB
 *   node timetable_solver.js --department 3 → only schedule one department
 *
 * CHANGELOG v1.1:
 *   - Enrollment fallback: section_id → course_id → 30 default
 *   - Departments JOIN is optional (works with or without `departments` table)
 *   - Duplicate-section warning after loading
 * ============================================================
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres.fclhdbppskmjlmbhtoug',
  password: 'LuxMindAdmin2026',
  host: 'aws-1-eu-central-1.pooler.supabase.com',
  port: 6543,
  database: 'postgres',
  ssl: { rejectUnauthorized: false }
});

// ============================================================
// CONFIG
// ============================================================
const CONFIG = {
  DAYS: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  TIME_SLOTS: [
    { start: '08:00', end: '09:30', type: 'morning' },
    { start: '09:30', end: '11:00', type: 'morning' },
    { start: '11:00', end: '12:30', type: 'late-morning' },
    { start: '13:00', end: '14:30', type: 'afternoon' },
    { start: '14:30', end: '16:00', type: 'afternoon' },
    { start: '16:00', end: '17:30', type: 'late-afternoon' },
  ],
  MAX_CLASSES_PER_COHORT_PER_DAY: 3,
  MAX_CLASSES_PER_TEACHER_PER_DAY: 4,
  MIN_ROOM_HEADROOM: 3,
  BACKTRACK_LIMIT: 5000,
};

// ============================================================
// CLI ARGUMENTS
// ============================================================
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const DRY_RUN = args.includes('--dry-run');
const DEPT_FILTER = (() => {
  const idx = args.indexOf('--department');
  return idx >= 0 ? parseInt(args[idx + 1], 10) || null : null;
})();

// ============================================================
// SLOT KEYS
// ============================================================
const roomKey    = (day, time, roomId)   => `${day}|${time}|R${roomId}`;
const teacherKey = (day, time, teacherId) => `${day}|${time}|T${teacherId}`;
const cohortKey  = (day, time, deptId)    => `${day}|${time}|D${deptId}`;

// ============================================================
// MAIN ENTRY
// ============================================================
async function main() {
  log('═══════════════════════════════════════════════════════════════');
  log('  LUXMIND TIMETABLE ENGINE v1.1');
  log(`  Mode: ${DRY_RUN ? 'DRY-RUN' : FORCE ? 'FORCE-RESET' : 'INCREMENTAL'}${DEPT_FILTER ? ' | Dept ' + DEPT_FILTER : ''}`);
  log('═══════════════════════════════════════════════════════════════\n');

  const { sections, rooms, hasDepartments } = await loadData();
  if (sections.length === 0) {
    log('ℹ️  No sections to schedule. Done.\n');
    return;
  }

  // Warn if duplicates still exist
  const dupCheck = {};
  for (const s of sections) {
    const k = `${s.course_id}|${s.group_name}`;
    dupCheck[k] = (dupCheck[k] || 0) + 1;
  }
  const dupKeys = Object.keys(dupCheck).filter(k => dupCheck[k] > 1);
  if (dupKeys.length > 0) {
    log(`⚠️  WARNING: ${dupKeys.length} (course_id, group_name) pairs still have duplicates.`);
    log('    Run the dedupe SQL before scheduling. First 5:');
    dupKeys.slice(0, 5).forEach(k => log(`      ${k} → ${dupCheck[k]} copies`));
    log('');
  }

  const occupancy = await loadOccupancy();
  const sorted = sortByDifficulty(sections);

  log(`📋 ${sorted.length} section(s) to place. Order:\n`);
  sorted.forEach((s, i) => {
    log(`  ${String(i + 1).padStart(2)}. ${s.code.padEnd(14)} | ${String(s.enrolled_count).padStart(3)} students | ${s.teacher_name || 'TBA'}`);
  });
  log('');

  const solution = solve(sorted, rooms, occupancy);
  printReport(solution, sorted);

  if (!DRY_RUN) {
    await persist(solution);
  } else {
    log('\n🟡 DRY-RUN: no database changes made.\n');
  }
}

// ============================================================
// STEP 1 — DATA LOADING
// ============================================================
async function loadData() {
  log('📥 Loading sections and rooms from database...');

  // Check if departments table exists
  const depCheck = await pool.query(
    `SELECT EXISTS(SELECT 1 FROM information_schema.tables
                   WHERE table_schema='public' AND table_name='departments') AS exists`
  );
  const hasDepartments = depCheck.rows[0].exists;
  if (!hasDepartments) {
    log('   ⚠️  departments table missing — department_name will be NULL');
  }

  const filter = FORCE
    ? ''
    : `AND (s.day_of_week IS NULL OR s.start_time IS NULL OR s.end_time IS NULL OR s.room IS NULL OR s.room = '')`;

  const deptFilter = DEPT_FILTER
    ? `AND c.department_id = ${DEPT_FILTER}`
    : '';

  const depJoin = hasDepartments
    ? 'LEFT JOIN departments d ON d.id = c.department_id'
    : '';
  const depField = hasDepartments
    ? 'd.name AS department_name'
    : 'NULL::text AS department_name';

  const sectionsRes = await pool.query(`
    SELECT 
      s.id,
      s.course_id,
      s.teacher_id,
      s.group_name,
      c.code,
      c.title,
      c.credits,
      c.department_id,
      COALESCE(
        (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = s.id),
        (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id),
        30
      ) AS enrolled_count,
      u.full_name AS teacher_name,
      ${depField}
    FROM course_sections s
    JOIN courses c ON c.id = s.course_id
    LEFT JOIN users u ON u.id = s.teacher_id
    ${depJoin}
    WHERE 1=1 ${filter} ${deptFilter}
    ORDER BY c.credits DESC, s.id ASC
  `);

  const roomsRes = await pool.query(`
    SELECT id, name, capacity, room_type
    FROM rooms
    WHERE is_active = TRUE
    ORDER BY capacity ASC
  `);

  if (roomsRes.rows.length === 0) {
    throw new Error('No rooms found. Run the schema migration first.');
  }

  log(`   ✓ ${sectionsRes.rows.length} sections`);
  log(`   ✓ ${roomsRes.rows.length} rooms\n`);

  return {
    sections: sectionsRes.rows,
    rooms: roomsRes.rows,
    hasDepartments,
  };
}

// ============================================================
// STEP 2 — EXISTING OCCUPANCY
// ============================================================
async function loadOccupancy() {
  log('📥 Loading existing occupancy...');

  const res = await pool.query(`
    SELECT s.id, s.course_id, s.teacher_id, s.day_of_week, s.start_time, s.room, c.department_id
    FROM course_sections s
    JOIN courses c ON c.id = s.course_id
    WHERE s.day_of_week IS NOT NULL
      AND s.start_time IS NOT NULL
      AND s.room IS NOT NULL
      ${FORCE ? '' : 'AND s.schedule_locked = TRUE'}
  `);

  const occ = { rooms: new Set(), teachers: new Set(), cohorts: new Set() };

  for (const row of res.rows) {
    const t = row.start_time.toString().slice(0, 5);
    occ.rooms.add(roomKey(row.day_of_week, t, row.room));
    if (row.teacher_id) occ.teachers.add(teacherKey(row.day_of_week, t, row.teacher_id));
    occ.cohorts.add(cohortKey(row.day_of_week, t, row.department_id));
  }

  log(`   ✓ ${occ.rooms.size} room-slots | ${occ.teachers.size} teacher-slots | ${occ.cohorts.size} cohort-slots\n`);
  return occ;
}

// ============================================================
// STEP 3 — DIFFICULTY SORTING
// ============================================================
function sortByDifficulty(sections) {
  return [...sections].sort((a, b) => {
    const sizeDiff = b.enrolled_count - a.enrolled_count;
    if (sizeDiff !== 0) return sizeDiff;
    return b.credits - a.credits;
  });
}

// ============================================================
// STEP 4 — SOLVER
// ============================================================
function solve(sections, rooms, occ) {
  const roomSet = new Set(occ.rooms);
  const teacherSet = new Set(occ.teachers);
  const cohortSet = new Set(occ.cohorts);
  const cohortDayLoad = {};

  const assignments = [];
  const failures = [];

  function tryAssignOne(sec) {
    const candidates = [];
    for (const day of CONFIG.DAYS) {
      for (const slot of CONFIG.TIME_SLOTS) {
        if (cohortSet.has(cohortKey(day, slot.start, sec.department_id))) continue;
        if (sec.teacher_id && teacherSet.has(teacherKey(day, slot.start, sec.teacher_id))) continue;

        const tDailyKey = `${day}|T${sec.teacher_id}`;
        if (sec.teacher_id && (cohortDayLoad[tDailyKey] || 0) >= CONFIG.MAX_CLASSES_PER_TEACHER_PER_DAY) continue;

        const cDailyKey = `${day}|D${sec.department_id}`;
        if ((cohortDayLoad[cDailyKey] || 0) >= CONFIG.MAX_CLASSES_PER_COHORT_PER_DAY) continue;

        for (const room of rooms) {
          if (room.capacity < sec.enrolled_count + CONFIG.MIN_ROOM_HEADROOM) continue;
          if (roomSet.has(roomKey(day, slot.start, room.id))) continue;

          let score = 0;
          if (slot.type === 'late-afternoon') score += 10;
          if (slot.type === 'morning') score -= 5;
          score += Math.abs(room.capacity - sec.enrolled_count);

          candidates.push({ day, slot, room, score });
        }
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.score - b.score);
    const best = candidates[0];
    return commit(sec, best.day, best.slot, best.room);
  }

  function commit(sec, day, slot, room) {
    roomSet.add(roomKey(day, slot.start, room.id));
    if (sec.teacher_id) teacherSet.add(teacherKey(day, slot.start, sec.teacher_id));
    cohortSet.add(cohortKey(day, slot.start, sec.department_id));

    const tDailyKey = `${day}|T${sec.teacher_id}`;
    const cDailyKey = `${day}|D${sec.department_id}`;
    cohortDayLoad[tDailyKey] = (cohortDayLoad[tDailyKey] || 0) + 1;
    cohortDayLoad[cDailyKey] = (cohortDayLoad[cDailyKey] || 0) + 1;

    return {
      section_id: sec.id,
      code: sec.code,
      title: sec.title,
      teacher_name: sec.teacher_name,
      day,
      start: slot.start,
      end: slot.end,
      room_id: room.id,
      room_name: room.name,
      room_capacity: room.capacity,
      enrolled: sec.enrolled_count,
    };
  }

  for (const sec of sections) {
    const placed = tryAssignOne(sec);
    if (placed) assignments.push(placed);
    else failures.push(sec);
  }

  return { assignments, failures };
}

// ============================================================
// STEP 5 — REPORT
// ============================================================
function printReport(solution, sections) {
  const { assignments, failures } = solution;

  log('\n═══════════════════════════════════════════════════════════════');
  log('  PLACEMENT RESULTS');
  log('═══════════════════════════════════════════════════════════════\n');

  const byDay = {};
  for (const day of CONFIG.DAYS) byDay[day] = [];
  for (const a of assignments) byDay[a.day].push(a);

  for (const day of CONFIG.DAYS) {
    if (byDay[day].length === 0) continue;
    log(`📅 ${day.toUpperCase()}`);
    byDay[day].sort((a, b) => a.start.localeCompare(b.start));
    for (const a of byDay[day]) {
      log(`   ${a.start}-${a.end}  ${a.room_name.padEnd(8)}  ${a.code.padEnd(14)}  ${(a.teacher_name || 'TBA').slice(0, 20)}`);
    }
    log('');
  }

  log('═══════════════════════════════════════════════════════════════');
  log(`  ✅ PLACED:   ${assignments.length}/${sections.length}`);
  if (failures.length > 0) {
    log(`  ❌ FAILED:   ${failures.length}`);
    log('');
    for (const f of failures) {
      log(`     ❌ ${f.code.padEnd(14)} | ${f.enrolled_count} students | ${f.teacher_name || 'TBA'}`);
    }
    log('');
  }
  log('═══════════════════════════════════════════════════════════════\n');
}

// ============================================================
// STEP 6 — PERSIST
// ============================================================
async function persist(solution) {
  log('💾 Writing to Supabase...\n');

  let written = 0;
  let errors = 0;

  for (const a of solution.assignments) {
    try {
      await pool.query(`
        UPDATE course_sections
        SET day_of_week = $1,
            start_time  = $2,
            end_time    = $3,
            room        = $4,
            schedule_locked = TRUE
        WHERE id = $5
      `, [a.day, a.start, a.end, a.room_name, a.section_id]);
      written++;
      process.stdout.write('.');
    } catch (err) {
      errors++;
      console.error(`\n   ❌ Failed section ${a.section_id}: ${err.message}`);
    }
  }

  log(`\n\n   ✓ ${written} written | ${errors} errors\n`);
}

function log(msg) {
  console.log(msg);
}

main()
  .then(() => pool.end())
  .catch(err => {
    console.error('\n💥 FATAL:', err);
    pool.end();
    process.exit(1);
  });