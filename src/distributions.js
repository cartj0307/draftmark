/**
 * Draftmark distributions — Phase 1 runtime library.
 *
 * Negative Binomial touchdown sampling and Gamma yardage sampling/survival.
 * Pure math, no I/O. Consumed by Phase 3 (survival-sum projection identity)
 * and Phase 4 (the correlated weekly draw).
 *
 * Parameterization:
 *   NB(lambda, phi): mean lambda, variance lambda + lambda^2/phi.
 *   As phi -> infinity this approaches Poisson(lambda) — which is what the
 *   2023-2025 fit supports at the population level (phi ~ 200 for most
 *   positions). Sampled as Poisson with Gamma-mixed rate (the standard
 *   NB construction), so one code path covers both regimes.
 *   Gamma(shape k, scale theta): mean k*theta, variance k*theta^2.
 */

"use strict";

// ---------- uniform RNG plumbing (injectable for common random numbers) ----

function defaultRng() {
  return Math.random();
}

// ---------- Gamma sampling (Marsaglia & Tsang) ----------------------------

function sampleGamma(shape, scale, rng = defaultRng) {
  if (shape <= 0 || scale <= 0) return 0;
  if (shape < 1) {
    // boost: Gamma(a) = Gamma(a+1) * U^(1/a)
    const u = rng();
    return sampleGamma(shape + 1, scale, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      x = gaussian(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

function gaussian(rng = defaultRng) {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------- Poisson sampling ------------------------------------------------

function samplePoisson(lambda, rng = defaultRng) {
  if (lambda <= 0) return 0;
  if (lambda < 30) {
    // Knuth
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do {
      k++;
      p *= rng();
    } while (p > L);
    return k - 1;
  }
  // normal approximation with continuity correction for large lambda
  const n = Math.round(lambda + Math.sqrt(lambda) * gaussian(rng));
  return Math.max(0, n);
}

// ---------- Negative Binomial ----------------------------------------------

/**
 * NB(lambda, phi) via Gamma-Poisson mixture:
 *   rate ~ Gamma(shape = phi, scale = lambda / phi); N ~ Poisson(rate).
 * phi >= 1e6 (or non-finite) short-circuits to pure Poisson.
 */
function sampleNegBin(lambda, phi, rng = defaultRng) {
  if (lambda <= 0) return 0;
  if (!Number.isFinite(phi) || phi >= 1e6) return samplePoisson(lambda, rng);
  const rate = sampleGamma(phi, lambda / phi, rng);
  return samplePoisson(rate, rng);
}

// ---------- Gamma survival / CDF (for the survival-sum identity) -----------

/** Regularized lower incomplete gamma P(a, x), by series / continued fraction. */
function gammaP(a, x) {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 0;
  const gln = logGamma(a);
  if (x < a + 1) {
    // series
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 1; n <= 500; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  // continued fraction for Q, return 1-Q
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
}

function logGamma(z) {
  // Lanczos
  const g = 7;
  const p = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  z -= 1;
  let x = p[0];
  for (let i = 1; i < g + 2; i++) x += p[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** P(Y >= y) for Y ~ Gamma(shape, scale). */
function gammaSurvival(y, shape, scale) {
  if (y <= 0) return 1;
  if (shape <= 0 || scale <= 0) return 0;
  return 1 - gammaP(shape, y / scale);
}

/** P(a <= Y <= b) for Y ~ Gamma(shape, scale). */
function gammaInterval(a, b, shape, scale) {
  return Math.max(0, gammaSurvival(a, shape, scale) - gammaSurvival(b + 1e-9, shape, scale));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    sampleGamma,
    samplePoisson,
    sampleNegBin,
    gaussian,
    gammaSurvival,
    gammaInterval,
    gammaP,
    logGamma,
  };
}
