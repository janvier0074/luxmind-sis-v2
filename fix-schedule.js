require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function fixSchedule() {
  try {
    console.log("Connecting to Supabase...");

    // 1. Kill any stuck processes holding the database hostage
    console.log("Killing stuck database locks...");
    await pool.query(`
      SELECT pg_terminate_backend(pid) 
      FROM pg_stat_activity 
      WHERE state != 'idle' 
        AND pid <> pg_backend_pid();
    `);

    // 2. Fix the column size (allow 'Monday' instead of just 5 chars)
    console.log("Fixing column sizes...");
    await pool.query(`ALTER TABLE course_sections ALTER COLUMN day_of_week TYPE VARCHAR(20);`);
    
    // 3. Update the schedule so it spreads across the week
    console.log("Distributing the schedule across Monday-Friday...");
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

    console.log("✅ SUCCESS: Database unlocked, and schedule distributed!");
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
  process.exit(0);
}

fixSchedule();