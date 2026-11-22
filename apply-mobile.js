const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'views');
const MOBILE_CSS_TAG = '<link rel="stylesheet" href="/css/mobile.css">';
const MOBILE_JS_TAG = '<script src="/js/mobile.js" defer></script>';

const stats = { scanned: 0, patched: 0, skipped_no_head: 0, skipped_already_done: 0, errors: 0 };

function patchFile(filePath) {
  stats.scanned++;
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    stats.errors++;
    console.error(`  ❌ Cannot read ${filePath}: ${err.message}`);
    return;
  }

  if (!content.includes('<head')) {
    stats.skipped_no_head++;
    console.log(`  ⏭️  ${path.basename(filePath)} (no <head> — skipped)`);
    return;
  }

  if (content.includes('/css/mobile.css')) {
    stats.skipped_already_done++;
    return;
  }

  if (!content.includes('</head>')) {
    stats.skipped_no_head++;
    return;
  }

  const newContent = content.replace(
    '</head>',
    `  ${MOBILE_CSS_TAG}\n  ${MOBILE_JS_TAG}\n</head>`
  );

  try {
    fs.writeFileSync(filePath, newContent, 'utf8');
    stats.patched++;
    console.log(`  ✅ ${path.basename(filePath)}`);
  } catch (err) {
    stats.errors++;
    console.error(`  ❌ Cannot write ${filePath}: ${err.message}`);
  }
}

console.log('═══════════════════════════════════════════════════════════');
console.log('  APPLYING MOBILE CSS + JS TO ALL EJS PAGES');
console.log('═══════════════════════════════════════════════════════════\n');

const files = fs.readdirSync(ROOT)
  .filter(f => f.endsWith('.ejs'))
  .map(f => path.join(ROOT, f));

console.log(`📁 Found ${files.length} .ejs file(s)\n`);
console.log('Patching:\n');

for (const file of files) {
  patchFile(file);
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  RESULTS');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  Scanned:                ${stats.scanned}`);
console.log(`  ✅ Patched:             ${stats.patched}`);
console.log(`  ⏭️  Already done:        ${stats.skipped_already_done}`);
console.log(`  ⏭️  Skipped (no <head>): ${stats.skipped_no_head}`);
console.log(`  ❌ Errors:              ${stats.errors}`);
console.log('═══════════════════════════════════════════════════════════\n');

if (stats.patched > 0) {
  console.log('✅ Done. Now push:\n');
  console.log('   git add views/');
  console.log('   git commit -m "feat(ui): apply global mobile CSS+JS to all pages"');
  console.log('   git push origin main\n');
}