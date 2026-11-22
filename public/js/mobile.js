/* ============================================================
   LUXMIND — GLOBAL MOBILE JS
   Phase 1: Hamburger + Table Scroll + Double-Submit Prevention
   ============================================================ */
(function () {
  'use strict';

  const isMobile = () => window.matchMedia('(max-width: 900px)').matches;

  function init() {
    if (!isMobile()) return;

    const sb = findSidebar();
    if (sb) {
      injectHamburger();
      injectOverlay();
      attachListeners(sb);
      document.body.classList.add('has-hamburger');
    }

    makeTablesScrollable();
    attachDoubleSubmitPrevention();

    window.addEventListener('resize', () => {
      if (isMobile()) makeTablesScrollable();
    });
  }

  // ============================================================
  // HAMBURGER (only if sidebar exists)
  // ============================================================
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
    sb.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => { if (isMobile()) closeDrawer(); });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDrawer();
    });
    window.addEventListener('resize', () => {
      if (!isMobile()) closeDrawer();
    });
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
  // TABLE SCROLL WRAPPING
  // ============================================================
  function makeTablesScrollable() {
    const tables = document.querySelectorAll('table');
    tables.forEach(table => {
      if (table.parentElement.classList.contains('table-responsive')) return;
      if (table.scrollWidth > table.clientWidth) {
        const wrapper = document.createElement('div');
        wrapper.className = 'table-responsive';
        wrapper.style.overflowX = 'auto';
        wrapper.style.webkitOverflowScrolling = 'touch';
        wrapper.style.maxWidth = '100%';
        table.parentNode.insertBefore(wrapper, table);
        wrapper.appendChild(table);
      }
    });
  }

  // ============================================================
  // DOUBLE-SUBMIT PREVENTION
  // Prevents users from tapping "Submit" twice on slow networks,
  // which would create duplicate records in the database.
  // ============================================================
  function attachDoubleSubmitPrevention() {
    document.addEventListener('submit', (e) => {
      const form = e.target;
      if (form.dataset.submitted === 'true') {
        e.preventDefault();
        return;
      }
      
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
      if (!submitBtn) return;
      
      // Only lock forms that are valid (prevents locking on validation errors)
      // Give browser 50ms to run native validation
      setTimeout(() => {
        if (form.checkValidity && form.checkValidity()) {
          form.dataset.submitted = 'true';
          
          if (submitBtn.tagName === 'BUTTON') {
            const originalHTML = submitBtn.innerHTML;
            submitBtn.dataset.originalHTML = originalHTML;
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
          } else {
            submitBtn.disabled = true;
            submitBtn.value = 'Processing...';
          }
          
          // Safety: re-enable after 10 seconds in case the request hangs
          setTimeout(() => {
            form.dataset.submitted = '';
            if (submitBtn.tagName === 'BUTTON') {
              submitBtn.disabled = false;
              submitBtn.innerHTML = submitBtn.dataset.originalHTML || 'Submit';
            } else {
              submitBtn.disabled = false;
              submitBtn.value = 'Submit';
            }
          }, 10000);
        }
      }, 50);
    }, true);
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();