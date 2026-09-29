// Click-to-zoom lightbox for project detail gallery images.
// Clicking an image clones its whole container (.project-detail__img, or one
// half of a .project-detail__pair) into the overlay and scales it up — so a
// custom crop/pan/zoom or a dark inset background is reproduced exactly,
// just larger, rather than revealing a different (uncropped) view of the
// raw source file. Click again (frame, backdrop, close button, or Esc) to
// zoom back out.
(function () {
  const gallery = document.querySelector('.project-detail__gallery');
  if (!gallery) return;

  const FRAME_SELECTOR = '.project-detail__img, .project-detail__pair-item';

  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.innerHTML = '<button type="button" class="lightbox__close" aria-label="Close">&times;</button>';
  document.body.appendChild(overlay);

  const closeBtn = overlay.querySelector('.lightbox__close');
  let currentFrame = null;

  function sizeFrame(frame, sourceEl) {
    const rect = sourceEl.getBoundingClientRect();
    const ratio = rect.width / rect.height;
    const maxW = window.innerWidth * 0.9;
    const maxH = window.innerHeight * 0.85;
    let w = maxW;
    let h = w / ratio;
    if (h > maxH) { h = maxH; w = h * ratio; }
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
  }

  function open(sourceEl) {
    if (currentFrame) currentFrame.remove();
    const frame = sourceEl.cloneNode(true);
    frame.classList.add('lightbox__frame');
    overlay.appendChild(frame);
    currentFrame = frame;
    sizeFrame(frame, sourceEl);
    overlay.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    overlay.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  gallery.addEventListener('click', (e) => {
    if (!e.target.closest('img')) return;
    const frameSource = e.target.closest(FRAME_SELECTOR);
    if (!frameSource) return;
    open(frameSource);
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === closeBtn) return;
    close();
  });
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });

  window.addEventListener('resize', () => {
    if (overlay.classList.contains('is-open') && currentFrame) {
      const ratio = currentFrame.offsetWidth / currentFrame.offsetHeight;
      const maxW = window.innerWidth * 0.9;
      const maxH = window.innerHeight * 0.85;
      let w = maxW;
      let h = w / ratio;
      if (h > maxH) { h = maxH; w = h * ratio; }
      currentFrame.style.width = w + 'px';
      currentFrame.style.height = h + 'px';
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('is-open')) close();
  });
})();
