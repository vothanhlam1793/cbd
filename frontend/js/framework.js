/* Forms are described by installed plugin YAML; no algorithm-specific controls. */
let pluginCatalog;
let pluginCase;
let pluginRunCase = null;
let pluginRecommendedParams = null;
const pluginGroups = ['sensor-core', 'behavior-trigger'];

function renderBehaviorTimeline(rows) {
  let deck = document.getElementById('behavior-state-timeline');
  if (!deck) {
    deck = document.createElement('div');
    deck.id = 'behavior-state-timeline';
    deck.className = 'card';
    document.getElementById('chart-cadence').closest('.chart-card').after(deck);
  }
  deck.replaceChildren();
  const title = document.createElement('h4');
  title.style.cssText = 'font-size:0.84rem; margin-bottom:6px; color:var(--text-secondary);';
  title.innerHTML = '⏱️ Phân Đoạn Trạng Thái <span class="info-hint" title="Bấm vào từng khoảng thời gian để tua nhanh video tới đoạn đó">ⓘ</span>';
  deck.append(title);
  const segments = [];
  rows.forEach(row => {
    const last = segments[segments.length - 1];
    if (last && last.state === row.predicted_state) last.end = row.timestamp_ms;
    else segments.push({state: row.predicted_state, start: row.timestamp_ms, end: row.timestamp_ms});
  });
  const strip = document.createElement('div');
  strip.style.cssText = 'display:flex;gap:6px;overflow:auto;max-height:80px;padding-bottom:4px';
  segments.forEach(segment => {
    const button = document.createElement('button');
    button.className = 'btn btn-icon-sm';
    button.style.flexShrink = '0';
    button.textContent = `${segment.state} · ${(segment.start / 1000).toFixed(1)}–${(segment.end / 1000).toFixed(1)}s`;
    button.onclick = () => { document.getElementById('main-video').currentTime = segment.start / 1000; };
    strip.append(button);
  });
  deck.append(strip);
}

async function initPluginWorkbench() {
  const oldCard = document.querySelector('#sub-case-tuning .param-card').closest('.card');
  oldCard.replaceChildren();
  oldCard.id = 'plugin-workbench';
  oldCard.textContent = 'Đang tải thuật toán…';
  const run = document.getElementById('btn-submit-rerun');
  run.disabled = true;
  try {
    const response = await fetch('/api/framework/plugins');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    pluginCatalog = await response.json();
    oldCard.replaceChildren();
    pluginGroups.forEach((group, index) => {
      const section = document.createElement('section');
      section.style.cssText = 'padding:12px 0;border-bottom:1px solid #30363d';
      const title = document.createElement('h3');
      title.style.cssText = 'font-size:0.9rem; margin-bottom:6px; color:var(--accent-cyan);';
      title.textContent = `${index === 0 ? '📡 Khối 1 · Sensor Core' : '🧠 Khối 2 · Behavior Trigger'} (${pluginCatalog[group].length})`;
      const select = document.createElement('select');
      select.id = `plugin-${group}`;
      select.className = 'btn';
      select.style.width = '100%';
      pluginCatalog[group].forEach(manifest => {
        const option = document.createElement('option');
        option.value = manifest.id;
        option.textContent = `${manifest.name} · v${manifest.version}`;
        select.append(option);
      });
      const form = document.createElement('div');
      form.id = `params-${group}`;
      form.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:8px;';
      select.onchange = () => renderPluginParams(group);
      section.append(title, select, form);
      oldCard.append(section);
      renderPluginParams(group);
    });
    if (pluginCatalog.errors.length) {
      const error = document.createElement('p');
      error.textContent = 'Plugin lỗi: ' + pluginCatalog.errors.map(x => `${x.plugin}: ${x.error}`).join('; ');
      oldCard.append(error);
    }
    const reset = document.createElement('button');
    reset.className = 'btn btn-icon-sm';
    reset.style.marginTop = '10px';
    reset.textContent = '↩ Mặc định YAML';
    reset.onclick = () => pluginGroups.forEach(g => renderPluginParams(g));
    oldCard.append(reset);
    syncPluginCase(pluginCase || window.currentCaseData);
    run.textContent = '▶ Chạy Pipeline';
    run.onclick = runPluginPipeline;
    document.getElementById('btn-view-tuned-studio').onclick = () => openCaseStudio(currentCaseId, true, true);
  } catch (error) {
    oldCard.textContent = `Lỗi tải framework: ${error.message}`;
  }
}

function renderPluginParams(group, values = {}) {
  const id = document.getElementById(`plugin-${group}`).value;
  const manifest = pluginCatalog[group].find(p => p.id === id);
  const form = document.getElementById(`params-${group}`);
  form.replaceChildren();
  if (!manifest) return;
  Object.entries(manifest.parameters).forEach(([key, spec]) => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex; flex-direction:column; gap:4px; font-size:0.78rem; background:#161b22; padding:6px 8px; border-radius:6px; border:1px solid #30363d;';
    const text = document.createElement('span');
    text.style.cssText = 'color:var(--text-secondary); font-weight:600; display:flex; justify-content:space-between; align-items:center;';
    text.innerHTML = `<span>${spec.label}${spec.unit ? ` (${spec.unit})` : ''}</span>`;
    if (spec.description) {
      const hint = document.createElement('span');
      hint.className = 'info-hint';
      hint.textContent = 'ⓘ';
      hint.title = spec.description;
      text.appendChild(hint);
    }
    const input = document.createElement(spec.type === 'enum' ? 'select' : 'input');
    input.dataset.parameter = key;
    input.dataset.type = spec.type;
    input.className = 'btn';
    input.style.width = '100%';
    input.style.padding = '4px 6px';
    const value = values[key] ?? spec.default;
    if (spec.type === 'enum') {
      spec.options.forEach(value => input.add(new Option(value, value)));
    } else if (spec.type === 'boolean') {
      input.type = 'checkbox';
      input.checked = value;
    } else {
      input.type = 'number';
      input.min = spec.min;
      input.max = spec.max;
      input.step = spec.step ?? 'any';
    }
    input.value = value;
    input.title = spec.description || spec.label;
    row.append(text, input);
    form.append(row);
  });
}

function syncPluginCase(data) {
  pluginCase = data;
  if (!data || !pluginCatalog) return;
  document.getElementById('tuning-case-title').textContent = `Pipeline · ${data.title}`;
  document.getElementById('tuning-meta-id').textContent = data.id;
  document.getElementById('tuning-meta-status').textContent = data.status;
  document.getElementById('tuning-meta-triggers').textContent = `${(data.triggers || []).length} triggers`;
  document.getElementById('tuning-meta-fps').textContent = `${(data.fps || 0).toFixed(2)} FPS`;
  document.getElementById('tuning-meta-duration').textContent = formatDuration(data.duration_sec);
  pluginGroups.forEach(group => {
    const saved = (data.config_params || {})[group];
    const select = document.getElementById(`plugin-${group}`);
    select.value = saved?.id || pluginCatalog[group][0]?.id || '';
    renderPluginParams(group, {...(saved?.params || data.config_params || {}), ...(pluginRecommendedParams || {})});
  });
  pluginRecommendedParams = null;
  document.getElementById('btn-submit-rerun').disabled = data.status === 'processing' || data.status === 'recording' || !!pluginRunCase;
}

async function runPluginPipeline() {
  if (!currentCaseId || pluginRunCase) return;
  const id = currentCaseId;
  const config = {};
  for (const group of pluginGroups) {
    const params = {};
    for (const input of document.querySelectorAll(`#params-${group} [data-parameter]`)) {
      if (!input.reportValidity()) return;
      params[input.dataset.parameter] = input.dataset.type === 'boolean' ? input.checked :
        input.dataset.type === 'enum' ? input.value : Number(input.value);
    }
    config[group] = {id: document.getElementById(`plugin-${group}`).value, params};
  }
  const button = document.getElementById('btn-submit-rerun');
  button.disabled = true;
  pluginRunCase = id;
  prevCaseSummary = {summary: {...(currentCaseData.summary_stats || {})}, triggers: (currentCaseData.triggers || []).length};
  document.getElementById('tuning-progress-box').style.display = 'block';
  document.getElementById('tuning-diff-box').style.display = 'none';
  document.getElementById('tuning-status-tag').textContent = 'ĐANG CHẠY';
  try {
    const response = await fetch(`/api/cases/${id}/run-pipeline`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({config_params: config})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || `HTTP ${response.status}`);
    // Poll until terminal status, independent of WebSocket and the currently selected case.
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const check = await fetch(`/api/cases/${id}`);
      if (!check.ok) throw new Error(`HTTP ${check.status}`);
      const data = await check.json();
      if (data.status === 'failed') throw new Error(data.summary_stats?.error || 'Phân tích thất bại');
      if (data.status === 'ready') {
        if (currentCaseId === id) {
          await openCaseStudio(id, false, true);
          handleTuningFinished({summary: data.summary_stats, triggers_count: data.triggers.length});
          document.getElementById('tuning-status-tag').textContent = `HOÀN TẤT · Sensor ${data.summary_stats.sensor_ms_per_frame ?? '—'} ms/f · Behavior ${data.summary_stats.behavior_ms_per_frame ?? '—'} ms/f`;
        }
        break;
      }
    }
  } catch (error) {
    toast.error(error.message);
    document.getElementById('tuning-status-tag').textContent = `LỖI: ${error.message}`;
  } finally {
    pluginRunCase = null;
    button.disabled = false;
  }
}
