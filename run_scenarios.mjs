/**
 * Headless Node.js script that loads the WASM LOLE engine and runs
 * winterization sensitivity scenarios. Outputs results to JSON.
 *
 * Usage: node run_scenarios.mjs > winterization_results.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

// ---- Load WASM synchronously ----
const wasmBytes = readFileSync(join(__dirname, 'lole_wasm_bg.wasm'));

// We need to manually set up the WASM imports. The lole_wasm.js is designed
// for browser ES modules, so we replicate initSync logic directly.
const jsSource = readFileSync(join(__dirname, 'lole_wasm.js'), 'utf-8');

// Import the WASM JS bindings
const { initSync, WasmEngine } = await import(join(__dirname, 'lole_wasm.js'));
initSync({ module: new WebAssembly.Module(wasmBytes) });

// ---- Load data ----
function loadBin(name) {
  return new Uint8Array(readFileSync(join(DATA_DIR, name)));
}

const manifestJson = readFileSync(join(DATA_DIR, 'manifest.json'), 'utf-8');
const configJson = readFileSync(join(DATA_DIR, 'study_config.json'), 'utf-8');

console.error('Loading binary data...');
const engine = new WasmEngine(
  manifestJson,
  configJson,
  loadBin('load_scenarios.bin'),
  loadBin('forced_outage.bin'),
  loadBin('ambient_derate.bin'),
  loadBin('variable_profiles.bin'),
  loadBin('perf_day_idx.bin'),
  loadBin('all_day_ids.bin'),
  loadBin('pomo_weekly.bin'),
);

console.error('Engine initialized. Running scenarios...');

// ---- Defaults / baseline portfolio ----
const defaults = JSON.parse(engine.defaults());
const portfolio = defaults.portfolio;
const peak = defaults.peak_forecast_mw;

// ---- Helpers ----
function solveIRM(policy = {}) {
  const req = {
    study_year: '2027-28',
    run_mode: 'full',
    peak_forecast_mw: peak,
    portfolio,
    target_lole_days_per_year: 0.1,
    accuracy_mode: 'high',
    capacity_step_mw: 500,
    baseload_addition_mw: 0,
    policy: {
      winter_efficiency: policy.winter_efficiency || false,
      weatherization_pct: policy.weatherization_pct || 0,
    },
  };
  const t0 = performance.now();
  const result = JSON.parse(engine.solve_target(JSON.stringify(req)));
  result._elapsed_ms = Math.round(performance.now() - t0);
  return result;
}

function simulate(policy = {}, baseload = 0) {
  const req = {
    study_year: '2027-28',
    run_mode: 'full',
    peak_forecast_mw: peak,
    portfolio,
    include_hourly: false,
    baseload_addition_mw: baseload,
    policy: {
      winter_efficiency: policy.winter_efficiency || false,
      weatherization_pct: policy.weatherization_pct || 0,
    },
  };
  const t0 = performance.now();
  const result = JSON.parse(engine.simulate(JSON.stringify(req)));
  result._elapsed_ms = Math.round(performance.now() - t0);
  return result;
}

function simulateAtPeak(policy = {}, peakMw = peak, baseload = 0, portfolioOverrides = {}) {
  const modifiedPortfolio = { ...portfolio, ...portfolioOverrides };
  const req = {
    study_year: '2027-28',
    run_mode: 'full',
    peak_forecast_mw: peakMw,
    portfolio: modifiedPortfolio,
    include_hourly: false,
    baseload_addition_mw: baseload,
    policy: {
      winter_efficiency: policy.winter_efficiency || false,
      weatherization_pct: policy.weatherization_pct || 0,
    },
  };
  const t0 = performance.now();
  const result = JSON.parse(engine.simulate(JSON.stringify(req)));
  result._elapsed_ms = Math.round(performance.now() - t0);
  return result;
}

// ---- Run scenarios ----
const results = {
  metadata: {
    generated: new Date().toISOString(),
    peak_forecast_mw: peak,
    icap_mw: defaults.icap_mw,
    portfolio,
    target_lole: 0.1,
    clearing_price_mw_day: 329.17,
  },
  scenarios: {},
};

// 1. Baseline
console.error('  [1/20+] Baseline...');
const baseline = solveIRM({});
const baselineSim = simulate({});
results.scenarios.baseline = {
  label: 'Baseline (current 20A)',
  policy: { winter_efficiency: false, weatherization_pct: 0 },
  solve: baseline,
  sim: baselineSim,
};

// 2. Winter efficiency only
console.error('  [2/20+] Winter efficiency only...');
const effOnly = solveIRM({ winter_efficiency: true });
const effOnlySim = simulate({ winter_efficiency: true });
results.scenarios.winter_efficiency_only = {
  label: 'Winter Efficiency Only (E3 Rec #4)',
  policy: { winter_efficiency: true, weatherization_pct: 0 },
  solve: effOnly,
  sim: effOnlySim,
};

// 3. Weatherization sensitivity: 0%, 10%, 20%, ..., 100% (with winter_efficiency on)
results.weatherization_sensitivity = [];
for (let pct = 0; pct <= 100; pct += 10) {
  const label = `WE=on, WZ=${pct}%`;
  console.error(`  [${3 + pct/10}/14] ${label}...`);
  const solve = solveIRM({ winter_efficiency: true, weatherization_pct: pct });
  const sim = simulate({ winter_efficiency: true, weatherization_pct: pct });
  results.weatherization_sensitivity.push({
    weatherization_pct: pct,
    winter_efficiency: true,
    solved_peak_mw: solve.solved_peak_mw,
    irm_pct: solve.solve_outputs?.irm_solved_pct ?? solve.implied_irm_pct,
    lole_at_solved: solve.solve_outputs?.lole_at_solved,
    lolh_at_solved: solve.solve_outputs?.lolh_at_solved,
    eue_at_solved: solve.solve_outputs?.eue_at_solved,
    lole_at_baseline_peak: sim.lole_days_per_year,
    eue_at_baseline_peak: sim.eue_mwh_per_year,
    delta_peak_vs_baseline: solve.solved_peak_mw - baseline.solved_peak_mw,
    delta_irm_vs_baseline: (solve.solve_outputs?.irm_solved_pct ?? solve.implied_irm_pct) - (baseline.solve_outputs?.irm_solved_pct ?? baseline.implied_irm_pct),
    elapsed_ms: solve._elapsed_ms,
  });
}

// 4. FO decorrelation only (no winter efficiency) for comparison
results.fo_only_sensitivity = [];
for (let pct of [0, 25, 50, 75, 100]) {
  const label = `WE=off, WZ=${pct}%`;
  console.error(`  FO-only: ${label}...`);
  const solve = solveIRM({ winter_efficiency: false, weatherization_pct: pct });
  results.fo_only_sensitivity.push({
    weatherization_pct: pct,
    winter_efficiency: false,
    solved_peak_mw: solve.solved_peak_mw,
    irm_pct: solve.solve_outputs?.irm_solved_pct ?? solve.implied_irm_pct,
    delta_peak_vs_baseline: solve.solved_peak_mw - baseline.solved_peak_mw,
  });
}

// 5. Full winterization (both levers maxed)
console.error('  Full winterization...');
const full = solveIRM({ winter_efficiency: true, weatherization_pct: 100 });
const fullSim = simulate({ winter_efficiency: true, weatherization_pct: 100 });
results.scenarios.full_winterization = {
  label: 'Full Winterization (both levers)',
  policy: { winter_efficiency: true, weatherization_pct: 100 },
  solve: full,
  sim: fullSim,
};

// ---- 6. ELCC Class Ratings ----
// Method: Manual 20A §2.6 — ELCC = (Portfolio_EUE - Class_EUE) / (Portfolio_EUE - Perfect_EUE)
// We add 100 MW of each class and measure the EUE reduction relative to a perfect resource.
console.error('\n=== ELCC CLASS RATINGS ===');
console.error('Computing marginal ELCC for each resource class under each scenario.');

const ELCC_DELTA_MW = 100;
const ELCC_CLASSES = [
  { name: 'Nuclear',   field: 'nuclear_mw' },
  { name: 'Coal',      field: 'coal_mw' },
  { name: 'Gas CC',    field: 'gas_cc_mw' },
  { name: 'Gas CT',    field: 'gas_ct_mw' },
  { name: 'Steam',     field: 'steam_mw' },
  { name: 'Oil CT',    field: 'oil_ct_mw' },
  { name: 'WTE Steam', field: 'wte_steam_mw' },
  { name: 'Wind',      field: 'wind_mw' },
  { name: 'Solar',     field: 'solar_mw' },
  { name: 'Storage',   field: 'storage_mw' },
  { name: 'DR',        field: 'dr_mw' },
  { name: 'Hydro',     field: 'hydro_mw' },
];

function computeELCC(label, policy, solvedPeak) {
  let callNum = 0;
  const totalCalls = 2 + ELCC_CLASSES.length;

  // 1. Portfolio EUE at solved peak
  callNum++;
  console.error(`    [${label}] (${callNum}/${totalCalls}) Portfolio EUE at solved peak ${Math.round(solvedPeak)} MW...`);
  const portfolioResult = simulateAtPeak(policy, solvedPeak);
  const portfolioEUE = portfolioResult.eue_mwh_per_year;

  // 2. Perfect resource: reduce demand by 100 MW (equivalent to adding 100 MW always-on supply)
  // baseload_addition_mw ADDS to peak demand, so negative = adding supply
  callNum++;
  console.error(`    [${label}] (${callNum}/${totalCalls}) Perfect resource (-${ELCC_DELTA_MW} MW demand = +${ELCC_DELTA_MW} MW perfect supply)...`);
  const perfectResult = simulateAtPeak(policy, solvedPeak, -ELCC_DELTA_MW);
  const perfectEUE = perfectResult.eue_mwh_per_year;

  const denominator = portfolioEUE - perfectEUE;
  console.error(`    [${label}] Portfolio EUE=${portfolioEUE.toFixed(1)}, Perfect EUE=${perfectEUE.toFixed(1)}, delta=${denominator.toFixed(1)}`);

  // 3. Each resource class: add 100 MW and measure EUE reduction
  const classes = {};
  for (const cls of ELCC_CLASSES) {
    callNum++;
    console.error(`    [${label}] (${callNum}/${totalCalls}) ${cls.name} (+${ELCC_DELTA_MW} MW)...`);
    const override = { [cls.field]: portfolio[cls.field] + ELCC_DELTA_MW };
    const classResult = simulateAtPeak(policy, solvedPeak, 0, override);
    const classEUE = classResult.eue_mwh_per_year;
    const elcc = denominator > 0 ? (portfolioEUE - classEUE) / denominator : 0;
    const elccClamped = Math.max(0, Math.min(1, elcc));
    classes[cls.name] = {
      eue_mwh: Math.round(classEUE * 100) / 100,
      elcc_pct: Math.round(elccClamped * 10000) / 100,
      delta_eue_mwh: Math.round((portfolioEUE - classEUE) * 100) / 100,
    };
    console.error(`      -> ${cls.name}: EUE=${classEUE.toFixed(1)}, ELCC=${(elccClamped*100).toFixed(1)}%`);
  }

  return {
    solved_peak_mw: solvedPeak,
    portfolio_eue_mwh: Math.round(portfolioEUE * 100) / 100,
    perfect_eue_mwh: Math.round(perfectEUE * 100) / 100,
    perfect_delta_eue: Math.round(denominator * 100) / 100,
    classes,
  };
}

const elccScenarios = [
  { key: 'baseline', policy: {}, solvedPeak: baseline.solved_peak_mw },
  { key: 'winter_efficiency', policy: { winter_efficiency: true }, solvedPeak: effOnly.solved_peak_mw },
  { key: 'full_winterization', policy: { winter_efficiency: true, weatherization_pct: 100 }, solvedPeak: full.solved_peak_mw },
];

results.elcc = {};
for (const { key, policy, solvedPeak } of elccScenarios) {
  console.error(`\n  Computing ELCC: ${key}...`);
  results.elcc[key] = computeELCC(key, policy, solvedPeak);
}

// ---- 7. Market Impact ----
// Compute the full FPR chain and supply/demand shifts under each scenario.
console.error('\n=== MARKET IMPACT ===');

// 2027-28 VRR curve parameters (from data/imm/vrr-curves/2027-28.json)
const PJM_REF_ELCC = 0.77; // Gas CT Dual Fuel official 2027-28
const NET_CONE = 181.89;
const FORECAST_PEAK = peak; // 164,186 MW ICAP
const SHAPIRO_CAP = 333.44;
const FRR_PEAK = 12201.9;

// VRR curve points (restricted and unrestricted)
const VRR_RESTRICTED = {
  A: { ucap: 141681.1, price: 333.44 },
  B: { ucap: 143217.7, price: 181.89 },
  C: { ucap: 143272.2, price: 179.55 },
};
const VRR_UNRESTRICTED = {
  A: { ucap: 139690.2, price: 529.80 },
  B: { ucap: 143217.7, price: 181.89 },
  C: { ucap: 147450.8, price: 0.00 },
};

// Interpolate price on unrestricted VRR curve given a UCAP quantity
function vrrPriceUnrestricted(ucapMw) {
  const { A, B, C } = VRR_UNRESTRICTED;
  if (ucapMw <= A.ucap) return A.price;
  if (ucapMw >= C.ucap) return 0;
  if (ucapMw <= B.ucap) {
    const frac = (ucapMw - A.ucap) / (B.ucap - A.ucap);
    return A.price + frac * (B.price - A.price);
  }
  const frac = (ucapMw - B.ucap) / (C.ucap - B.ucap);
  return B.price + frac * (C.price - B.price);
}

// Interpolate price on restricted VRR curve
function vrrPriceRestricted(ucapMw) {
  const { A, B, C } = VRR_RESTRICTED;
  if (ucapMw <= A.ucap) return A.price;
  if (ucapMw >= C.ucap) return C.price;
  if (ucapMw <= B.ucap) {
    const frac = (ucapMw - A.ucap) / (B.ucap - A.ucap);
    return A.price + frac * (B.price - A.price);
  }
  const frac = (ucapMw - B.ucap) / (C.ucap - B.ucap);
  return B.price + frac * (C.price - B.price);
}

const FIELD_MAP = {
  'Nuclear': 'nuclear_mw', 'Coal': 'coal_mw', 'Gas CC': 'gas_cc_mw',
  'Gas CT': 'gas_ct_mw', 'Steam': 'steam_mw', 'Oil CT': 'oil_ct_mw',
  'WTE Steam': 'wte_steam_mw', 'Wind': 'wind_mw', 'Solar': 'solar_mw',
  'Storage': 'storage_mw', 'DR': 'dr_mw', 'Hydro': 'hydro_mw',
};

function computeMarketImpact(elcc, solve) {
  const irm = solve.solve_outputs?.irm_solved_pct ?? solve.implied_irm_pct;
  const fpr = solve.solve_outputs?.fpr_pct / 100;
  const gasCtELCC = elcc.classes['Gas CT'].elcc_pct / 100;

  // Reliability Requirement = Forecast Peak × FPR
  const relReq = FORECAST_PEAK * fpr;

  // Pool UCAP = sum(ICAP_class × ELCC_class) for all classes
  let poolUCAP = 0;
  const ucapByClass = {};
  for (const [cls, data] of Object.entries(elcc.classes)) {
    const icap = portfolio[FIELD_MAP[cls]];
    const ucap = icap * (data.elcc_pct / 100);
    poolUCAP += ucap;
    ucapByClass[cls] = { icap_mw: icap, elcc_pct: data.elcc_pct, ucap_mw: Math.round(ucap) };
  }
  // Add "other" class with conservative 50% factor
  poolUCAP += portfolio.other_mw * 0.5;

  return {
    irm_pct: Math.round(irm * 10000) / 10000,
    fpr: Math.round(fpr * 10000) / 10000,
    gas_ct_blended_elcc: Math.round(gasCtELCC * 10000) / 10000,
    forecast_peak_mw: FORECAST_PEAK,
    reliability_requirement_mw: Math.round(relReq),
    pool_ucap_mw: Math.round(poolUCAP),
    surplus_deficit_mw: Math.round(poolUCAP - relReq),
    ucap_by_class: ucapByClass,
  };
}

function fmtNum(n) { return Math.round(n).toLocaleString('en-US'); }

const scenarioSolveMap = {
  baseline: results.scenarios.baseline.solve,
  winter_efficiency: results.scenarios.winter_efficiency_only.solve,
  full_winterization: results.scenarios.full_winterization.solve,
};

results.market_impact = {};
for (const key of ['baseline', 'winter_efficiency', 'full_winterization']) {
  results.market_impact[key] = computeMarketImpact(results.elcc[key], scenarioSolveMap[key]);
  const mi = results.market_impact[key];
  console.error(`  ${key}: Rel Req=${fmtNum(mi.reliability_requirement_mw)} MW, Pool UCAP=${fmtNum(mi.pool_ucap_mw)} MW, Surplus=${fmtNum(mi.surplus_deficit_mw)} MW`);
}

// Compute deltas between baseline and full winterization
const miBase = results.market_impact.baseline;
const miFull = results.market_impact.full_winterization;
const miEff = results.market_impact.winter_efficiency;

const demandShift = miBase.reliability_requirement_mw - miFull.reliability_requirement_mw;
const supplyShift = miFull.pool_ucap_mw - miBase.pool_ucap_mw;
const totalGap = demandShift + supplyShift;

// VRR prices at baseline vs winterized supply levels
const baselineVrrPrice = vrrPriceUnrestricted(miBase.pool_ucap_mw);
const winterizedVrrPrice = vrrPriceUnrestricted(miFull.pool_ucap_mw);
const baselineRestrictedPrice = vrrPriceRestricted(miBase.pool_ucap_mw);
const winterizedRestrictedPrice = vrrPriceRestricted(miFull.pool_ucap_mw);

// Savings at Shapiro cap: gap_closure × cap × 365
const savingsAtCap = totalGap * SHAPIRO_CAP * 365;

// Unrestricted VRR savings: price_drop × total_pool_ucap × 365
// (Pool UCAP here is the relevant quantity that prices apply to)
const priceDrop = baselineVrrPrice - winterizedVrrPrice;
const savingsUnrestricted = priceDrop * miBase.pool_ucap_mw * 365;

results.market_impact.deltas = {
  demand_shift_mw: demandShift,
  supply_shift_mw: supplyShift,
  total_gap_closure_mw: totalGap,
  savings_at_cap_annual: Math.round(savingsAtCap),
  savings_unrestricted_annual: Math.round(savingsUnrestricted),
  baseline_vrr_price_unrestricted: Math.round(baselineVrrPrice * 100) / 100,
  winterized_vrr_price_unrestricted: Math.round(winterizedVrrPrice * 100) / 100,
  baseline_vrr_price_restricted: Math.round(baselineRestrictedPrice * 100) / 100,
  winterized_vrr_price_restricted: Math.round(winterizedRestrictedPrice * 100) / 100,
};

console.error(`\n  Demand shift (lower Rel Req): ${fmtNum(demandShift)} MW`);
console.error(`  Supply shift (higher Pool UCAP): ${fmtNum(supplyShift)} MW`);
console.error(`  Total gap closure: ${fmtNum(totalGap)} MW`);
console.error(`  Savings at Shapiro cap: $${Math.round(savingsAtCap / 1e6)}M/year`);
console.error(`  Unrestricted VRR: $${Math.round(baselineVrrPrice)}/MW-day -> $${Math.round(winterizedVrrPrice)}/MW-day`);
console.error(`  Savings on unrestricted VRR: $${Math.round(savingsUnrestricted / 1e9)}B/year`);

// 8. Summary
const baseIRM = baseline.solve_outputs?.irm_solved_pct ?? baseline.implied_irm_pct;
const fullIRM = full.solve_outputs?.irm_solved_pct ?? full.implied_irm_pct;
const equivMW = full.solved_peak_mw - baseline.solved_peak_mw;

results.summary = {
  baseline_irm_pct: baseIRM,
  full_winterization_irm_pct: fullIRM,
  irm_reduction_pp: baseIRM - fullIRM,
  baseline_solved_peak_mw: baseline.solved_peak_mw,
  full_solved_peak_mw: full.solved_peak_mw,
  equivalent_baseload_mw: equivMW,
  annual_savings_at_329: Math.abs(equivMW) * 329.17 * 365,
  lole_baseline_at_peak: baselineSim.lole_days_per_year,
  lole_full_at_peak: fullSim.lole_days_per_year,
  lole_improvement: baselineSim.lole_days_per_year - fullSim.lole_days_per_year,
  efficiency_only_delta_mw: effOnly.solved_peak_mw - baseline.solved_peak_mw,
  fo_decorrelation_delta_mw: full.solved_peak_mw - effOnly.solved_peak_mw,
};

console.error('\n=== SUMMARY ===');
console.error(`Baseline IRM: ${baseIRM?.toFixed(2)}%`);
console.error(`Full Winterization IRM: ${fullIRM?.toFixed(2)}%`);
console.error(`IRM reduction: ${(baseIRM - fullIRM)?.toFixed(2)} pp`);
console.error(`Equivalent baseload: ${Math.round(equivMW)} MW`);
console.error(`  - Winter efficiency: ${Math.round(effOnly.solved_peak_mw - baseline.solved_peak_mw)} MW`);
console.error(`  - FO decorrelation: ${Math.round(full.solved_peak_mw - effOnly.solved_peak_mw)} MW`);
console.error(`Annual savings: $${Math.round(Math.abs(equivMW) * 329.17 * 365 / 1e6)}M/year`);

// Write results
const outPath = join(__dirname, 'winterization_results.json');
writeFileSync(outPath, JSON.stringify(results, null, 2));
console.error(`\nResults written to ${outPath}`);
