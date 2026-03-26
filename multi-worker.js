/**
 * Multi-worker coordinator for parallel WASM LOLE simulation.
 *
 * Spawns N workers (default: min(hardwareConcurrency, 6)), each with its own
 * copy of the WASM engine. For simulate requests, partitions the 403 scenarios
 * across workers and aggregates partial results.
 *
 * Usage:
 *   const coordinator = new MultiWorkerCoordinator();
 *   await coordinator.init({ dataBaseUrl: '../data/bundle' });
 *   const result = await coordinator.simulate(payload);
 *   const solveResult = await coordinator.solveTarget(payload);
 */

export class MultiWorkerCoordinator {
  constructor(numWorkers = null) {
    this.numWorkers = numWorkers || Math.min(navigator.hardwareConcurrency || 4, 6);
    this.workers = [];
    this.ready = false;
    this.totalScenarios = 403;
    this._nextId = 1;
    this._pendingCallbacks = {};
    this._onProgress = null;
  }

  set onProgress(fn) {
    this._onProgress = fn;
  }

  async init(options = {}) {
    const dataBaseUrl = options.dataBaseUrl || 'data';
    const progressCb = options.onProgress || this._onProgress;

    // Spawn workers
    const initPromises = [];
    for (let i = 0; i < this.numWorkers; i++) {
      const worker = new Worker('worker.js');
      this.workers.push(worker);

      // Set up message handler
      worker.onmessage = (e) => this._handleMessage(i, e);
      worker.onerror = (e) => console.error(`Worker ${i} error:`, e);

      // Init each worker (they each load WASM + data independently)
      const p = this._callWorker(i, 'init', { dataBaseUrl });
      initPromises.push(p);

      if (progressCb) {
        progressCb({ phase: 'init', worker: i, total: this.numWorkers });
      }
    }

    await Promise.all(initPromises);

    // Get total scenarios from defaults
    try {
      const defaults = await this._callWorker(0, 'defaults');
      // defaults doesn't directly contain scenario count, but we know it's 403
    } catch (e) {
      // Use default 403
    }

    this.ready = true;
    if (progressCb) {
      progressCb({ phase: 'ready', workers: this.numWorkers });
    }
  }

  /**
   * Get defaults from the first worker.
   */
  async defaults() {
    if (!this.ready) throw new Error('Coordinator not initialized');
    return this._callWorker(0, 'defaults');
  }

  /**
   * Health check from the first worker.
   */
  async health() {
    if (!this.ready) throw new Error('Coordinator not initialized');
    return this._callWorker(0, 'health');
  }

  /**
   * Run a full simulation with parallel scenario evaluation.
   *
   * For the fast path (no hourly data), partitions scenarios across workers
   * and aggregates. For detailed mode (include_hourly), falls back to
   * single-worker execution.
   */
  async simulate(payload) {
    if (!this.ready) throw new Error('Coordinator not initialized');

    // Detailed mode requires single-worker (hourly arrays need special aggregation)
    if (payload.include_hourly) {
      return this._callWorker(0, 'simulate', payload);
    }

    // Parallel path: partition scenarios across workers
    const t0 = performance.now();
    const partitions = this._partitionScenarios(this.totalScenarios, this.numWorkers);

    const slicePromises = partitions.map((scenarioIds, workerIdx) => {
      return this._callWorker(workerIdx, 'evaluate-slice', {
        scenario_ids: scenarioIds,
        config: {
          candidate_peak: payload.peak_forecast_mw,
          portfolio: payload.portfolio,
          baseload_addition_mw: payload.baseload_addition_mw || 0,
          policy: {
            winter_efficiency: payload.winter_efficiency || false,
            weatherization_pct: payload.weatherization_pct || 0,
          },
        },
      });
    });

    const sliceResults = await Promise.all(slicePromises);

    // Aggregate partial results
    let totalLole = 0;
    let totalLolh = 0;
    let totalEue = 0;
    let totalDraws = 0;

    for (const slice of sliceResults) {
      if (slice.error) throw new Error(slice.error);
      totalLole += slice.lole_sum;
      totalLolh += slice.lolh_sum || 0;
      totalEue += slice.eue_sum;
      totalDraws += slice.n_scenario_draws;
    }

    const lole = totalLole / totalDraws;
    const lolh = totalLolh / totalDraws;
    const eue = totalEue / totalDraws;
    const elapsedMs = performance.now() - t0;

    // Compute IRM from payload
    const portfolio = payload.portfolio;
    const icap = (portfolio.nuclear_mw || 0) + (portfolio.coal_mw || 0) +
      (portfolio.gas_cc_mw || 0) + (portfolio.gas_ct_mw || 0) +
      (portfolio.wind_mw || 0) + (portfolio.solar_mw || 0) +
      (portfolio.storage_mw || 0) + (portfolio.dr_mw || 0) +
      (portfolio.steam_mw || 0) + (portfolio.hydro_mw || 0) +
      (portfolio.other_mw || 0) + (portfolio.oil_ct_mw || 0) +
      (portfolio.wte_steam_mw || 0);

    const cbot = 0.015;
    const irmFormulaPct = (icap / payload.peak_forecast_mw - 1 - cbot) * 100;

    return {
      api_version: '2027.2-wasm-multi',
      study_year: '2027-28',
      lole_days_per_year: Math.round(lole * 1e6) / 1e6,
      lolh_hours_per_year: Math.round(lolh * 1e6) / 1e6,
      eue_mwh_per_year: Math.round(eue * 1000) / 1000,
      irm_formula_pct: Math.round(irmFormulaPct * 1e4) / 1e4,
      icap_mw: Math.round(icap * 1000) / 1000,
      target_lole_gap: Math.round((lole - 0.1) * 1e6) / 1e6,
      seasonal_split: { winter_pct: null, summer_pct: null },
      stress_events: [],
      _elapsed_ms: Math.round(elapsedMs),
      _workers_used: this.numWorkers,
    };
  }

  /**
   * Solve for required capacity.
   * This delegates to a single worker since the IRM solver
   * needs iterative bracketing that can't be easily parallelized.
   */
  async solveTarget(payload) {
    if (!this.ready) throw new Error('Coordinator not initialized');
    return this._callWorker(0, 'solve-target', payload);
  }

  /**
   * Replay a single worst-case draw — delegates to Worker 0.
   */
  async replayWorstDraw(payload) {
    if (!this.ready) throw new Error('Coordinator not initialized');
    return this._callWorker(0, 'replay-worst-draw', payload);
  }

  /**
   * Terminate all workers.
   */
  terminate() {
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    this.ready = false;
  }

  // ---- Private ----

  _partitionScenarios(total, numWorkers) {
    const partitions = [];
    const chunkSize = Math.ceil(total / numWorkers);
    for (let i = 0; i < numWorkers; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, total);
      if (start >= total) break;
      const ids = [];
      for (let j = start; j < end; j++) ids.push(j);
      partitions.push(ids);
    }
    return partitions;
  }

  _callWorker(workerIdx, type, payload) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._pendingCallbacks[id] = { resolve, reject, workerIdx };
      this.workers[workerIdx].postMessage({ type, id, payload });
    });
  }

  _handleMessage(workerIdx, e) {
    const { type, id, data, error } = e.data;

    if (type === 'progress') {
      if (this._onProgress) {
        this._onProgress({ phase: 'loading', worker: workerIdx, ...e.data });
      }
      return;
    }

    if (type === 'ready') {
      if (this._pendingCallbacks[id]) {
        this._pendingCallbacks[id].resolve(data);
        delete this._pendingCallbacks[id];
      }
      return;
    }

    if (type === 'error') {
      if (this._pendingCallbacks[id]) {
        this._pendingCallbacks[id].reject(new Error(error));
        delete this._pendingCallbacks[id];
      }
      return;
    }

    // Any result type
    if (this._pendingCallbacks[id]) {
      if (data?.error) {
        this._pendingCallbacks[id].reject(new Error(data.error));
      } else {
        this._pendingCallbacks[id].resolve(data);
      }
      delete this._pendingCallbacks[id];
    }
  }
}
