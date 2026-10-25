const fs = require('fs');
const path = require('path');
const viewsDir = path.join(__dirname, 'views');

const mobileCSS = `
    .mobile-menu-btn { display: none; position: fixed; top: 1rem; left: 1rem; z-index: 1001; background: #0a1e32; color: #ffc857; border: none; width: 45px; height: 45px; border-radius: 10px; font-size: 1.2rem; cursor: pointer; align-items: center; justify-content: center; }
    .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(10,30,50,0.5); z-index: 999; }
    .btn-back { display: none; align-items: center; gap: 0.5rem; color: #1e4d7b; font-weight: 800; text-decoration: none; margin-bottom: 1rem; font-size: 0.9rem; }
    @media (max-width: 768px) {
      .mobile-menu-btn { display: flex; }
      .sidebar { transform: translateX(-100%); transition: transform 0.3s ease; }
      .sidebar.active { transform: translateX(0); }
      .sidebar-overlay.active { display: block; }
      main { margin-left: 0 !important; width: 100% !important; padding: 1.5rem !important; padding-top: 5rem !important; }
      .btn-back { display: inline-flex; }
      .layout, .finance-layout, .attendance-grid, .tile-grid, .course-grid, .stats-grid, .semester-grid, .weekly-grid { grid-template-columns: 1fr !important; gap: 1rem !important; }
      table { display: block; overflow-x: auto; white-space: nowrap; }
    }
`;

const mobileHTML = `<button class="mobile-menu-btn" onclick="toggleMobileMenu()"><i class="fas fa-bars"></i></button>
<div class="sidebar-overlay" id="sidebarOverlay" onclick="toggleMobileMenu()"></div>`;

const backBtn = `<a href="javascript:history.back()" class="btn-back"><i class="fas fa-arrow-left"></i> Back</a>`;

const mobileJS = `<script>
    function toggleMobileMenu() {
      var sb = document.getElementById('sidebar');
      var ov = document.getElementById('sidebarOverlay');
      if (sb) sb.classList.toggle('active');
      if (ov) ov.classList.toggle('active');
    }
  </script>`;

let patched = 0, skipped = 0;

function processDirectory(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) { processDirectory(fullPath); continue; }
    if (!file.endsWith('.ejs') || file === 'login.ejs' || file === 'document-template.ejs') continue;

    let content = fs.readFileSync(fullPath, 'utf8');

    if (content.includes('mobile-menu-btn')) {
      console.log(`SKIP (already patched): ${file}`);
      skipped++;
      continue;
    }

    if (content.includes('</style>')) content = content.replace('</style>', mobileCSS + '\n</style>');
    content = content.replace(/<body[^>]*>/i, (m) => m + '\n' + mobileHTML);
    content = content.replace(/<aside([^>]*)class=["']sidebar["']([^>]*)>/ig, (m) => {
      if (m.includes('id=')) return m;
      return m.replace('>', ' id="sidebar">');
    });
    content = content.replace(/<main[^>]*>/i, (m) => m + '\n' + backBtn);
    content = content.replace('</body>', mobileJS + '\n</body>');

    fs.writeFileSync(fullPath, content);
    console.log(`✅ PATCHED: ${file}`);
    patched++;
  }
}

console.log('--- Starting patch ---');
processDirectory(viewsDir);
console.log(`--- Done: ${patched} patched, ${skipped} skipped ---`);