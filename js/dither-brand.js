/*
 * dither-brand — the look every dithered section of the portfolio shares.
 *
 * The hero (butterfly) and the footer (lily) each add only what belongs to their
 * own scene — which animation, its timing, where it sits, how it's shaped — on top
 * of these values:
 *
 *   DitherFilter.mount(Object.assign({}, DITHER_BRAND, { canvas, src, sprite, … }));
 *
 * Change a value here and every section follows, so they can't drift apart.
 * playground.html shows whether a section's settings still match.
 */
(function (global) {
  'use strict';

  global.DITHER_BRAND = Object.freeze({
    fadeIn: 500,
    block: 2,
    gamma: 1.2,
    grain: 13,
    // the dither's own two colours; typography keeps the page's colours
    ink: '#8f3d84',
    paper: '#121212',
    edgeRef: 34,

    // a faint, still field of dither behind the subject (needs a transparent source)
    background: Object.freeze({
      gradient: 'linear', from: 0, to: 0.01, angle: 90,
      noise: 0.05, scale: 86, octaves: 5, speed: 0,
      pattern: 'bayer', shimmer: 0, blend: 'behind', seed: 1
    }),

    // the cursor smears the scene softly as it passes
    cursor: Object.freeze({
      enabled: true, drag: 0.64, radius: 0.15, strength: 0.75,
      dissipation: 0.77, max: 120, blur: 1, fray: 0
    })
  });
})(window);
