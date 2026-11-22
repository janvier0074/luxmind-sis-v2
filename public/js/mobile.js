(function () {
  'use strict';
  const isMobile = () => window.matchMedia('(max-width: 900px)').matches;

  function init() {
    if (!isMobile()) return;
    injectHamburger(); injectOverlay(); attachListeners();
    document.body.classList.add('has-hamburger');
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

  function findSidebar() {
    return document.querySelector('.sidebar, .course-nav, aside.sidebar, .layout > aside');
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

  function attachListeners() {
    const sb = findSidebar();
    if (sb) {
      sb.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => { if (isMobile()) closeDrawer(); });
      });
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
    window.addEventListener('resize', () => { if (!isMobile()) closeDrawer(); });
    let touchStartX = 0;
    document.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
    document.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (dx < -60) closeDrawer();
    }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();