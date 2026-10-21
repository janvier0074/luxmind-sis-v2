require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const mockCourses = [
  { code: 'CS 101', title: 'Intro to Programming', credits: 3, sem: 1 },
  { code: 'MATH 101', title: 'Calculus I', credits: 4, sem: 1 },
  { code: 'ENG 101', title: 'English Composition', credits: 3, sem: 1 },
  { code: 'CS 102', title: 'Object Oriented Programming', credits: 3, sem: 2 },
  { code: 'MATH 102', title: 'Calculus II', credits: 4, sem: 2 },
  { code: 'CS 201', title: 'Data Structures', credits: 4, sem: 3 },
  { code: 'CS 202', title: 'Algorithms', credits: 4, sem: 4 },
  { code: 'CS 301', title: 'Operating Systems', credits: 3, sem: 5 }
];

async function seed() {
  try {
    console.log("Fixing database constraints...");
    
    // 1. Drop NOT NULL constraints on old LMS columns we don't use in SIS
    const legacyColumns = ['folder_path', 'slug', 'description', 'thumbnail', 'teacher_id'];
    for (const col of legacyColumns) {
      try {
        await pool.query(`ALTER TABLE courses ALTER COLUMN ${col} DROP NOT NULL;`);
      } catch (e) { /* Ignore if column doesn't exist */ }
    }

    // 2. Make sure our SIS columns exist
    await pool.query('ALTER TABLE courses ADD COLUMN IF NOT EXISTS code VARCHAR(50);');
    await pool.query('ALTER TABLE courses ADD COLUMN IF NOT EXISTS semester_number INTEGER DEFAULT 1;');
    await pool.query('ALTER TABLE courses ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 3;');

    // 3. Clear old courses
    await pool.query('DELETE FROM courses;');

    // 4. Insert the new courses
    for (const c of mockCourses) {
      const slug = c.code.toLowerCase().replace(/\s+/g, '-'); 
      
      await pool.query(
        `INSERT INTO courses (code, title, credits, semester_number, slug) 
         VALUES ($1, $2, $3, $4, $5)`,
        [c.code, c.title, c.credits, c.sem, slug]
      );
    }
    console.log('✅ Successfully seeded 8 courses into Supabase!');
  } catch (e) {
    console.error('❌ Error:', e.message);
  }
  process.exit(0);
}

seed();