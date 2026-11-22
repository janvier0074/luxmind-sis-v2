/* ============================================================
   LUXMIND — GLOBAL MOBILE JS
   Focus: 
   1. Inject hamburger only if a sidebar exists.
   2. Prevent horizontal overflow on every page.
   ============================================================ */
(function () {
  'use strict';

  const isMobile = () => window.matchMedia('(max-width: 900px)').matches;

  function init() {
    if (!isMobile()) return;

    // Only inject hamburger if there is actually a sidebar to open
    const sb = findSidebar();
    if (sb) {
      injectHamburger();
      injectOverlay();
      attachListeners(sb);
      document.body.classList.add('has-hamburger');
    }

    // Universal safety: make any wide tables scroll instead of breaking the page
    makeTablesScrollable();
    
    // Re-check on resize
    window.addEventListener('resize', () => {
      if (isMobile()) makeTablesScrollable();
    });
  }

  function findSidebar() {
    return document.querySelector('.sidebar, .course-nav, aside.sidebar, .layout > aside');
  }

  function injectHamburger() {
    if (document.querySelector('.mobile-hamburger')) return;
    const btn = document.createElement('button');
    btn.className = 'mobile-hamburger';
    btn.setAttribute('aria-label', 'Open menu');
    btn.innerHTML = '<i class="fa-solid fa-bars"></i>';
    btn.onclick = openDrawer;
    document.body.appendChild(btn);
  }

  function injectOverlay() {
    if (document.querySelector('.mobile-overlay')) return;
    const ov = document.createElement('div');
    ov.className = 'mobile-overlay';
    ov.onclick = closeDrawer;
    document.body.appendChild(ov);
  }

  function openDrawer() {
    const sb = findSidebar();
    const ov = document.querySelector('.mobile-overlay');
    if (sb) sb.classList.add('mobile-open');
    if (ov) ov.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeDrawer() {
    const sb = findSidebar();
    const ov = document.querySelector('.mobile-overlay');
    if (sb) sb.classList.remove('mobile-open');
    if (ov) ov.classList.remove('active');
    document.body.style.overflow = '';
  }

  function attachListeners(sb) {
    // Close drawer when a nav link is clicked
    sb.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => { if (isMobile()) closeDrawer(); });
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDrawer();
    });

    // Close on resize to desktop
    window.addEventListener('resize', () => {
      if (!isMobile()) closeDrawer();
    });

    // Swipe left to close drawer
    let touchStartX = 0;
    document.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (dx < -60) closeDrawer();
    }, { passive: true });
  }

  // ============================================================
  // TABLE OVERFLOW FIX
  // Scans the page for <table> elements that are wider than the
  // screen and forces them to scroll inside their own wrapper.
  // ============================================================
  function makeTablesScrollable() {
    const tables = document.querySelectorAll('table');
    tables.forEach(table => {
      // Skip if already wrapped
      if (table.parentElement.classList.contains('table-responsive')) return;

      // Check if the table actually overflows its container
      if (table.scrollWidth > table.clientWidth) {
        // Create a scrollable wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'table-responsive';
        wrapper.style.overflowX = 'auto';
        wrapper.style.webkitOverflowScrolling = 'touch';
        wrapper.style.maxWidth = '100%';
        
        // Wrap the table
        table.parentNode.insertBefore(wrapper, table);
        wrapper.appendChild(table);
      }
    });
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();