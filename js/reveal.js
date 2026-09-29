// Site-wide scroll-reveal: matched elements fade up into place the first
// time they enter the viewport. Targets a curated set of content blocks —
// section headings, cards, gallery items — not the hero (which already has
// its own entrance) or persistent chrome (nav, bottom bar).
(function () {
  const SELECTORS = [
    // Home
    '.selected-work__heading',
    '.project-row',
    '.view-more',
    '.cta-bloom__copy',
    '.site-footer__top',
    // Work listing
    '.work-header',
    '.work-filters',
    '.work-card',
    // About
    '.about-info',
    '.about-photos__row > div',
    '.about-photos > img',
    // Project detail pages (current and future — shared class names)
    '.project-detail__info',
    '.project-detail__gallery > *'
  ];

  const els = document.querySelectorAll(SELECTORS.join(', '));
  if (!els.length) return;

  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  els.forEach((el) => el.classList.add('reveal'));

  if (prefersReduced || !('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -60px 0px' }
  );

  els.forEach((el) => observer.observe(el));
})();
