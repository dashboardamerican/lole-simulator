/**
 * Web Worker for the WASM LOLE Monte Carlo simulator.
 *
 * Lifecycle:
 *   1. Main thread creates Worker, sends { type: 'init' }
 *   2. Worker fetches WASM module + all .bin data files
 *   3. Worker instantiates WasmEngine with binary data
 *   4. Worker posts { type: 'ready' }
 *   5. Main thread sends 'simulate' / 'solve-target' / 'defaults' messages
 *   6. Worker runs WASM engine, posts results back
 *
 * Data is cached in IndexedDB after first fetch for fast subsequent loads.
 */

// Data files to fetch (relative to the data bundle directory)
const DATA_FILES = [
  'load_scenarios.bin',
  'forced_outage.bin',
  'ambient_derate.bin',
  'variable_profiles.bin',
  'perf_day_idx.bin',
  'all_day_ids.bin',
  'pomo_weekly.bin',
];

const IDB_NAME = 'lole-wasm-cache';
const IDB_VERSION = 1;
const IDB_STORE = 'binaries';

let engine = null;

// ---------- IndexedDB helpers ----------

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const req = tx.objectStore(IDB_STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------- Data loading ----------

async function fetchWithCache(db, url, name) {
  // Try IndexedDB first
  try {
    const cached = await idbGet(db, name);
    if (cached && cached.byteLength > 0) {
      return cached;
    }
  } catch (e) {
    // Cache miss, fetch from network
  }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${name}: ${resp.status}`);
  const buffer = await resp.arrayBuffer();

  // Store in IndexedDB for next time
  try {
    await idbPut(db, name, buffer);
  } catch (e) {
    console.warn(`Failed to cache ${name} in IndexedDB:`, e);
  }

  return buffer;
}

async function loadAllData(dataBaseUrl) {
  let db;
  try {
    db = await openIDB();
  } catch (e) {
    console.warn('IndexedDB not available, fetching all data from network:', e);
    db = null;
  }

  // Fetch manifest and study config (always from network — small files)
  const [manifestResp, configResp] = await Promise.all([
    fetch(`${dataBaseUrl}/manifest.json`),
    fetch(`${dataBaseUrl}/study_config.json`),
  ]);

  if (!manifestResp.ok) throw new Error(`Failed to fetch manifest.json: ${manifestResp.status}`);
  if (!configResp.ok) throw new Error(`Failed to fetch study_config.json: ${configResp.status}`);

  const manifestJson = await manifestResp.text();
  const configJson = await configResp.text();

  // Check manifest version for cache invalidation
  const manifest = JSON.parse(manifestJson);
  const cacheKey = JSON.stringify(manifest.meta?.load_columns?.length || 0);

  if (db) {
    try {
      const cachedVersion = await idbGet(db, '__version__');
      if (cachedVersion !== cacheKey) {
        // Version mismatch — clear cache
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        await new Promise((resolve) => { tx.oncomplete = resolve; });
        await idbPut(db, '__version__', cacheKey);
      }
    } catch (e) {
      console.warn('Version check failed:', e);
    }
  }

  // Fetch binary data files (with progress reporting)
  const totalFiles = DATA_FILES.length;
  const results = {};

  for (let i = 0; i < totalFiles; i++) {
    const name = DATA_FILES[i];
    const url = `${dataBaseUrl}/${name}`;

    postMessage({
      type: 'progress',
      loaded: i,
      total: totalFiles,
      file: name,
    });

    if (db) {
      results[name] = await fetchWithCache(db, url, name);
    } else {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to fetch ${name}: ${resp.status}`);
      results[name] = await resp.arrayBuffer();
    }
  }

  postMessage({
    type: 'progress',
    loaded: totalFiles,
    total: totalFiles,
    file: 'done',
  });

  return { manifestJson, configJson, buffers: results };
}

// ---------- Engine initialization ----------

async function initEngine(dataBaseUrl) {
  // Import WASM module (with cache-bust to avoid stale builds)
  const cacheBust = Date.now();
  const { default: init, WasmEngine } = await import(`./lole_wasm.js?v=${cacheBust}`);
  await init(`lole_wasm_bg.wasm?v=${cacheBust}`);

  // Load data
  const { manifestJson, configJson, buffers } = await loadAllData(dataBaseUrl);

  // Create engine
  engine = new WasmEngine(
    manifestJson,
    configJson,
    new Uint8Array(buffers['load_scenarios.bin']),
    new Uint8Array(buffers['forced_outage.bin']),
    new Uint8Array(buffers['ambient_derate.bin']),
    new Uint8Array(buffers['variable_profiles.bin']),
    new Uint8Array(buffers['perf_day_idx.bin']),
    new Uint8Array(buffers['all_day_ids.bin']),
    new Uint8Array(buffers['pomo_weekly.bin']),
  );

  return engine;
}

// ---------- Message handler ----------

self.onmessage = async function (e) {
  const { type, id, payload } = e.data;

  try {
    switch (type) {
      case 'init': {
        const dataBaseUrl = payload?.dataBaseUrl || 'data';
        await initEngine(dataBaseUrl);
        postMessage({ type: 'ready', id });
        break;
      }

      case 'defaults': {
        if (!engine) {
          postMessage({ type: 'error', id, error: 'Engine not initialized' });
          return;
        }
        const result = engine.defaults();
        postMessage({ type: 'defaults-result', id, data: JSON.parse(result) });
        break;
      }

      case 'health': {
        if (!engine) {
          postMessage({ type: 'error', id, error: 'Engine not initialized' });
          return;
        }
        const result = engine.health();
        postMessage({ type: 'health-result', id, data: JSON.parse(result) });
        break;
      }

      case 'simulate': {
        if (!engine) {
          postMessage({ type: 'error', id, error: 'Engine not initialized' });
          return;
        }
        const requestJson = JSON.stringify(payload);
        console.log('[worker-debug] simulate request include_hourly:', payload.include_hourly);
        const t0 = performance.now();
        const result = engine.simulate(requestJson);
        const elapsed = performance.now() - t0;
        const data = JSON.parse(result);
        data._elapsed_ms = Math.round(elapsed);
        console.log('[worker-debug] simulate result keys:', Object.keys(data));
        if (data.hourly_products) {
          console.log('[worker-debug] hourly_products keys:', Object.keys(data.hourly_products));
          const dsw = data.hourly_products.dispatch_stack_windows;
          console.log('[worker-debug] dispatch_stack_windows:', dsw ? `array[${dsw.length}]` : dsw);
          if (dsw && dsw.length > 0) {
            console.log('[worker-debug] first window keys:', Object.keys(dsw[0]));
          }
        }
        postMessage({ type: 'simulate-result', id, data });
        break;
      }

      case 'solve-target': {
        if (!engine) {
          postMessage({ type: 'error', id, error: 'Engine not initialized' });
          return;
        }
        const requestJson = JSON.stringify(payload);
        const t0 = performance.now();
        const result = engine.solve_target(requestJson);
        const elapsed = performance.now() - t0;
        const data = JSON.parse(result);
        data._elapsed_ms = Math.round(elapsed);
        postMessage({ type: 'solve-result', id, data });
        break;
      }

      case 'evaluate-slice': {
        if (!engine) {
          postMessage({ type: 'error', id, error: 'Engine not initialized' });
          return;
        }
        const scenarioIdsJson = JSON.stringify(payload.scenario_ids);
        const configJson = JSON.stringify(payload.config);
        const result = engine.evaluate_slice(scenarioIdsJson, configJson);
        postMessage({ type: 'slice-result', id, data: JSON.parse(result) });
        break;
      }

      case 'replay-worst-draw': {
        if (!engine) {
          postMessage({ type: 'error', id, error: 'Engine not initialized' });
          return;
        }
        const requestJson = JSON.stringify(payload);
        const t0 = performance.now();
        const result = engine.replay_worst_draw(requestJson);
        const elapsed = performance.now() - t0;
        const data = JSON.parse(result);
        data._elapsed_ms = Math.round(elapsed);
        postMessage({ type: 'replay-result', id, data });
        break;
      }

      default:
        postMessage({ type: 'error', id, error: `Unknown message type: ${type}` });
    }
  } catch (err) {
    postMessage({
      type: 'error',
      id,
      error: err.message || String(err),
    });
  }
};
