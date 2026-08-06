"use strict";

const {
  sampleGamma, samplePoisson, sampleNegBin, gammaSurvival, gammaInterval,
} = require("../src/distributions.js");

let pass = 0, fail = 0;
function assertClose(name, got, want, tol) {
  if (Math.abs(got - want) <= tol) pass++;
  else { fail++; console.error(`  FAIL ${name}: got ${got.toFixed(4)}, want ${want.toFixed(4)} (tol ${tol})`); }
}

// deterministic LCG so the test is reproducible
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s + 0.5) / 4294967296;
  };
}

const N = 200000;

// Poisson moments
{
  const rng = makeRng(1);
  let sum = 0, sq = 0;
  for (let i = 0; i < N; i++) { const x = samplePoisson(0.9, rng); sum += x; sq += x * x; }
  const m = sum / N, v = sq / N - m * m;
  assertClose("Poisson(0.9) mean", m, 0.9, 0.02);
  assertClose("Poisson(0.9) var", v, 0.9, 0.03);
}

// NB moments: var = lambda + lambda^2/phi
{
  const rng = makeRng(2);
  const lambda = 1.0, phi = 4;
  let sum = 0, sq = 0;
  for (let i = 0; i < N; i++) { const x = sampleNegBin(lambda, phi, rng); sum += x; sq += x * x; }
  const m = sum / N, v = sq / N - m * m;
  assertClose("NB(1,4) mean", m, 1.0, 0.02);
  assertClose("NB(1,4) var", v, 1.25, 0.05);
}

// NB with huge phi collapses to Poisson
{
  const rng = makeRng(3);
  let sq = 0, sum = 0;
  for (let i = 0; i < N; i++) { const x = sampleNegBin(0.5, 200, rng); sum += x; sq += x * x; }
  const m = sum / N, v = sq / N - m * m;
  assertClose("NB(0.5,200) ~ Poisson var", v, 0.5 + 0.25 / 200, 0.02);
}

// Gamma moments
{
  const rng = makeRng(4);
  const shape = 2.2, scale = 30;
  let sum = 0, sq = 0;
  for (let i = 0; i < N; i++) { const x = sampleGamma(shape, scale, rng); sum += x; sq += x * x; }
  assertClose("Gamma(2.2,30) mean", sum / N, 66, 0.6);
  assertClose("Gamma(2.2,30) var", sq / N - (sum / N) ** 2, shape * scale * scale, 30);
}

// Gamma survival: exponential special case, shape=1 -> S(y) = exp(-y/scale)
{
  assertClose("Gamma survival exp case", gammaSurvival(50, 1, 25), Math.exp(-2), 1e-6);
  assertClose("Gamma survival at 0", gammaSurvival(0, 3, 10), 1, 1e-12);
  // survival matches empirical
  const rng = makeRng(5);
  let hits = 0;
  for (let i = 0; i < N; i++) if (sampleGamma(2.2, 30, rng) >= 100) hits++;
  assertClose("Gamma survival vs MC at 100", gammaSurvival(100, 2.2, 30), hits / N, 0.005);
  // interval = S(a) - S(b)
  const int = gammaInterval(100, 199, 2.2, 30);
  assertClose("Gamma interval consistency", int,
    gammaSurvival(100, 2.2, 30) - gammaSurvival(199, 2.2, 30), 1e-6);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
