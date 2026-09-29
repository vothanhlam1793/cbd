/* Data & Evaluation Workbench Logic for CBD Motion Lab */

let currentEvalCaseId = null;
let currentEvalCaseData = null;
let currentCuratedDataset = [];
let currentSelectedStudioTrigger = null;

document.addEventListener("DOMContentLoaded", () => {
  initDataEvaluationWorkbench();
  initStudioQuickLabeling();
});

function initDataEvaluationWorkbench() {
  const selectCase = document.getElementById("eval-select-case");
  const filterLabel = document.getElementById("eval-filter-label");
  const btnSyncVlm = document.getElementById("btn-sync-vlm-to-eval");
  const btnExportJson = document.getElementById("btn-export-dataset-json");
  const btnExportCsv = document.getElementById("btn-export-dataset-csv");
  const btnCopyDist = document.getElementById("btn-copy-feature-dist");

  if (!selectCase) return;

  // Load Cases into Select
  fetch("/api/cases")
    .then((r) => r.json())
    .then((cases) => {
      selectCase.innerHTML = `<option value="" disabled selected>-- Chọn Case Video --</option>`;
      cases.forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = `${c.title} (${c.id} - ${c.trigger_count || 0} triggers)`;
        selectCase.appendChild(opt);
      });

      if (window.currentCaseId) {
        selectCase.value = window.currentCaseId;
        loadCaseEvaluation(window.currentCaseId);
      } else if (cases.length > 0) {
        selectCase.value = cases[0].id;
        loadCaseEvaluation(cases[0].id);
      }
    })
    .catch((err) => console.error("Error loading cases for eval:", err));

  selectCase.addEventListener("change", () => {
    const caseId = selectCase.value;
    if (caseId) {
      loadCaseEvaluation(caseId);
    }
  });

  if (filterLabel) {
    filterLabel.addEventListener("change", () => {
      if (currentEvalCaseData) {
        renderEvalTriggersTable(currentEvalCaseData.triggers || []);
      }
    });
  }

  // Copy Distribution & Feature Metrics for OpenCode
  if (btnCopyDist) {
    btnCopyDist.addEventListener("click", () => {
      if (!currentEvalCaseData) {
        toast.warning("Chưa có dữ liệu case nào để copy!");
        return;
      }
      const payload = {
        case_id: currentEvalCaseData.case_id,
        case_title: currentEvalCaseData.case_title,
        state_distributions: currentEvalCaseData.state_distributions,
        triggers_count: currentEvalCaseData.total_triggers,
        sample_features: (currentEvalCaseData.triggers || []).slice(0, 5).map(t => ({
          frame_idx: t.frame_idx,
          timestamp_sec: t.timestamp_sec,
          features_snapshot: t.features_snapshot,
          ground_truth_label: t.ground_truth_label
        }))
      };
      navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
        .then(() => toast.success("Đã copy số liệu phân tích vào Clipboard! Bạn có thể dán ngay cho OpenCode."))
        .catch(() => toast.error("Không thể copy vào clipboard."));
    });
  }

  // Auto-sync VLM Audit
  if (btnSyncVlm) {
    btnSyncVlm.addEventListener("click", async () => {
      if (!currentEvalCaseId) {
        toast.warning("Vui lòng chọn một Case trước khi đồng bộ!");
        return;
      }
      btnSyncVlm.disabled = true;
      btnSyncVlm.textContent = "⏳ Đang Đồng Bộ...";
      try {
        const res = await fetch(`/api/evaluation/auto-sync-vlm/${currentEvalCaseId}`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Lỗi đồng bộ");
        toast.success(`Đã tự động đồng bộ ${data.count_synced} nhãn từ Gemini 3.7 vào kho Dataset!`);
        await loadCaseEvaluation(currentEvalCaseId);
        await loadCuratedDataset();
      } catch (err) {
        toast.error("Lỗi đồng bộ VLM: " + err.message);
      } finally {
        btnSyncVlm.disabled = false;
        btnSyncVlm.textContent = "⚡ Đồng bộ VLM";
      }
    });
  }

  // Export JSON
  if (btnExportJson) {
    btnExportJson.addEventListener("click", () => {
      window.location.href = "/api/evaluation/dataset/export?format=json";
      toast.info("Đang tải xuống tệp cbd_curated_dataset.json...");
    });
  }

  // Export CSV
  if (btnExportCsv) {
    btnExportCsv.addEventListener("click", () => {
      window.location.href = "/api/evaluation/dataset/export?format=csv";
      toast.info("Đang tải xuống tệp cbd_curated_dataset.csv...");
    });
  }

  loadCuratedDataset();
}

// Global hook called when navigating to #/data-eval
function loadDataEvaluationWorkbench(caseId) {
  const selectCase = document.getElementById("eval-select-case");
  if (caseId && selectCase) {
    selectCase.value = caseId;
  }
  const activeId = caseId || (selectCase ? selectCase.value : null);
  if (activeId) {
    loadCaseEvaluation(activeId);
  }
  loadCuratedDataset();
}

async function loadCaseEvaluation(caseId) {
  currentEvalCaseId = caseId;
  const tbodyTrig = document.getElementById("eval-triggers-tbody");
  const tbodyDist = document.getElementById("eval-distribution-tbody");

  if (tbodyTrig) {
    tbodyTrig.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-muted); padding:20px;">⏳ Đang tải số liệu đo đạc của Case ${caseId}...</td></tr>`;
  }

  try {
    const res = await fetch(`/api/evaluation/cases/${caseId}/summary`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    currentEvalCaseData = await res.json();

    // Badges
    document.getElementById("eval-badge-total-trig").textContent = `🎯 ${currentEvalCaseData.total_triggers} mốc`;
    document.getElementById("eval-badge-labeled").textContent = `🏷️ ${currentEvalCaseData.labeled_count}/${currentEvalCaseData.total_triggers} nhãn`;

    // Render Distribution
    renderDistributionTable(currentEvalCaseData.state_distributions || {});

    // Render Triggers
    renderEvalTriggersTable(currentEvalCaseData.triggers || []);
  } catch (err) {
    if (tbodyTrig) {
      tbodyTrig.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--accent-red); padding:16px;">Lỗi tải dữ liệu: ${err.message}</td></tr>`;
    }
  }
}

function renderDistributionTable(dists) {
  const tbody = document.getElementById("eval-distribution-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const states = Object.keys(dists);
  if (states.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">Không có dữ liệu telemetry</td></tr>`;
    return;
  }

  states.forEach((st) => {
    const d = dists[st];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="metric-state state-${st.includes("periodic") ? "periodic" : st.includes("high") ? "high" : st}">${st.toUpperCase()}</span></td>
      <td><b>${d.count.toLocaleString()}</b> f</td>
      <td>${d.avg_speed} px/f</td>
      <td>${d.avg_dy} px</td>
      <td>${d.avg_sharpness}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderEvalTriggersTable(triggers) {
  const tbody = document.getElementById("eval-triggers-tbody");
  const filter = document.getElementById("eval-filter-label")?.value || "ALL";
  if (!tbody) return;
  tbody.innerHTML = "";

  const filtered = triggers.filter((t) => {
    if (filter === "ALL") return true;
    if (filter === "UNLABELED") return t.ground_truth_label === "UNLABELED";
    return t.ground_truth_label === filter;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:var(--text-muted); padding:20px;">Không có mốc nào phù hợp với bộ lọc "${filter}".</td></tr>`;
    return;
  }

  filtered.forEach((t, i) => {
    const raw = t.raw_measurements || {};
    const f1s = t.features_snapshot || {};
    const tr = document.createElement("tr");

    const labelBadgeColor =
      t.ground_truth_label === "STABLE_INSPECTION" ? "#238636" :
      t.ground_truth_label === "PATROL_WALKING" ? "#1f6feb" :
      t.ground_truth_label === "HIGH_MOTION" ? "#d29922" :
      t.ground_truth_label === "LENS_OCCLUDED_OR_BLUR" ? "#f85149" : "#6e7681";

    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>
        ${t.evidence_url ? `
          <img src="${t.evidence_url}" class="trigger-img-thumb" style="width:60px; height:38px; object-fit:cover; border-radius:4px; cursor:pointer;" onclick="openEvidenceModal('${t.evidence_url}', '${t.reason || ""}')">
        ` : `<span style="color:var(--text-muted); font-size:0.75rem;">--</span>`}
      </td>
      <td>
        <b>${formatSecondsToMMSS(t.timestamp_sec)}</b><br>
        <span style="font-size:0.68rem; color:var(--text-muted);">${t.timestamp_sec}s (#${t.frame_idx})</span>
      </td>
      <td>
        <span class="trigger-tag tag-stable" style="font-size:0.7rem;">${t.predicted_state || "STABLE"}</span>
      </td>
      <td style="font-family:monospace; font-size:0.72rem; line-height:1.3;">
        v:<b>${(raw.speed_px_f || 0).toFixed(1)}</b> yaw:<b>${(raw.angular_yaw_vel_px_s || 0).toFixed(0)}</b><br>
        nét:<b>${(raw.sharpness_laplacian || 0).toFixed(0)}</b> che:<b>${((raw.occlusion_ratio || 0) * 100).toFixed(0)}%</b>
      </td>
      <td style="font-family:monospace; font-size:0.72rem; line-height:1.3; color:var(--text-secondary);">
        v̄:<b>${f1s.mean_speed ?? "--"}</b> | σdy:<b>${f1s.std_dy ?? "--"}</b><br>
        jerk:<b>${f1s.mean_jerk ?? "--"}</b> | <b>${f1s.mean_cadence_hz ?? "--"}Hz</b>
      </td>
      <td>
        <span class="meta-badge" id="badge-label-${t.frame_idx}" style="background:${labelBadgeColor}; color:#fff; font-weight:700; font-size:0.72rem;">
          ${t.ground_truth_label}
        </span>
      </td>
      <td>
        <div class="action-btn-group">
          <button class="btn btn-action-label btn-icon-sm" data-frame="${t.frame_idx}" data-label="STABLE_INSPECTION" style="background:#238636; color:#fff;" title="Xác nhận dừng quan sát">👍 Chuẩn</button>
          <button class="btn btn-action-label btn-icon-sm" data-frame="${t.frame_idx}" data-label="PATROL_WALKING" title="Đi bộ tuần tra">🚶 Đi bộ</button>
          <button class="btn btn-action-label btn-icon-sm" data-frame="${t.frame_idx}" data-label="HIGH_MOTION" title="Rung giật mạnh">⚡ Rung</button>
          <button class="btn btn-action-label btn-icon-sm" data-frame="${t.frame_idx}" data-label="LENS_OCCLUDED_OR_BLUR" title="Che áo hoặc nhòe mờ">🙈 Che</button>
          <button class="btn btn-action-note btn-icon-sm" data-frame="${t.frame_idx}" title="Ghi chú tùy biến">✏️</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Attach button click listeners
  tbody.querySelectorAll(".btn-action-label").forEach((btn) => {
    btn.addEventListener("click", () => {
      const fIdx = parseInt(btn.getAttribute("data-frame"));
      const label = btn.getAttribute("data-label");
      submitSampleLabel(fIdx, label);
    });
  });

  tbody.querySelectorAll(".btn-action-note").forEach((btn) => {
    btn.addEventListener("click", () => {
      const fIdx = parseInt(btn.getAttribute("data-frame"));
      const targetTrigger = triggers.find(x => x.frame_idx === fIdx);
      const note = prompt("Nhập ghi chú hoặc nhãn tùy chỉnh:", targetTrigger?.notes || "");
      if (note !== null) {
        submitSampleLabel(fIdx, targetTrigger?.ground_truth_label || "STABLE_INSPECTION", note);
      }
    });
  });
}

async function submitSampleLabel(frameIdx, label, notes = null) {
  if (!currentEvalCaseId || !currentEvalCaseData) return;
  const trigger = (currentEvalCaseData.triggers || []).find(t => t.frame_idx === frameIdx);
  if (!trigger) return;

  const payload = {
    case_id: currentEvalCaseId,
    frame_idx: frameIdx,
    timestamp_ms: trigger.timestamp_ms,
    evidence_url: trigger.evidence_url,
    predicted_state: trigger.predicted_state,
    ground_truth_label: label,
    features_snapshot: trigger.features_snapshot,
    verified_by: "human_evaluator",
    notes: notes !== null ? notes : trigger.notes,
  };

  try {
    const res = await fetch("/api/evaluation/label-sample", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Server error");
    const data = await res.json();
    
    // Update local state
    trigger.ground_truth_label = label;
    if (notes !== null) trigger.notes = notes;
    trigger.verified_by = "human_evaluator";

    const badge = document.getElementById(`badge-label-${frameIdx}`);
    if (badge) {
      badge.textContent = label;
      badge.style.background =
        label === "STABLE_INSPECTION" ? "#238636" :
        label === "PATROL_WALKING" ? "#1f6feb" :
        label === "HIGH_MOTION" ? "#d29922" :
        label === "LENS_OCCLUDED_OR_BLUR" ? "#f85149" : "#6e7681";
    }

    toast.success(`Đã lưu nhãn "${label}" cho Frame #${frameIdx} vào kho Dataset!`);
    loadCuratedDataset();
  } catch (err) {
    toast.error("Lỗi khi lưu nhãn: " + err.message);
  }
}

async function loadCuratedDataset() {
  const tbody = document.getElementById("eval-curated-dataset-tbody");
  const badgesContainer = document.getElementById("eval-dataset-stat-badges");
  if (!tbody) return;

  try {
    const res = await fetch("/api/evaluation/dataset");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    currentCuratedDataset = data.samples || [];

    // Badges breakdown
    if (badgesContainer) {
      badgesContainer.innerHTML = "";
      const totalBadge = document.createElement("span");
      totalBadge.className = "meta-badge";
      totalBadge.style.cssText = "font-weight:700; color:var(--accent-cyan);";
      totalBadge.textContent = `Tổng cộng: ${data.total_samples} mẫu`;
      badgesContainer.appendChild(totalBadge);

      const counts = data.label_counts || {};
      Object.keys(counts).forEach(lbl => {
        const b = document.createElement("span");
        b.className = "meta-badge";
        b.textContent = `${lbl}: ${counts[lbl]}`;
        badgesContainer.appendChild(b);
      });
    }

    // Render table
    tbody.innerHTML = "";
    if (currentCuratedDataset.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:var(--text-muted); padding:16px;">Chưa có mẫu nào trong kho. Hãy chấm điểm các mốc ở bảng trên để tích lũy dữ liệu!</td></tr>`;
      return;
    }

    currentCuratedDataset.forEach(s => {
      const tr = document.createElement("tr");
      const f = s.features_snapshot || {};
      tr.innerHTML = `
        <td style="font-family:monospace; font-size:0.75rem;">${s.id}</td>
        <td><b>${s.case_id}</b></td>
        <td>#${s.frame_idx}</td>
        <td>${formatSecondsToMMSS(s.timestamp_sec)} (${s.timestamp_sec}s)</td>
        <td>
          <span class="meta-badge" style="background:#238636; color:#fff; font-weight:700; font-size:0.75rem;">
            ${s.ground_truth_label}
          </span>
        </td>
        <td>${s.verified_by || "--"}</td>
        <td style="font-family:monospace; font-size:0.72rem; color:var(--text-muted);">
          v:${f.mean_speed ?? "--"} | dy:${f.std_dy ?? "--"} | jerk:${f.mean_jerk ?? "--"}
        </td>
        <td style="font-size:0.75rem; color:var(--text-secondary); max-width:180px; overflow:hidden; text-overflow:ellipsis;">
          ${s.notes || "--"}
        </td>
        <td>
          <button class="btn btn-danger btn-del-sample btn-icon-sm" data-id="${s.id}" title="Xóa mẫu này">🗑️</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".btn-del-sample").forEach(btn => {
      btn.addEventListener("click", async () => {
        const sId = btn.getAttribute("data-id");
        if (confirm(`Xác nhận xóa mẫu ${sId}?`)) {
          await fetch(`/api/evaluation/samples/${sId}`, { method: "DELETE" });
          toast.info(`Đã xóa mẫu ${sId}`);
          loadCuratedDataset();
          if (currentEvalCaseId) loadCaseEvaluation(currentEvalCaseId);
        }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:var(--accent-red);">Lỗi nạp dataset: ${err.message}</td></tr>`;
  }
}

// Studio Quick Labeling Integration
function initStudioQuickLabeling() {
  document.querySelectorAll(".btn-studio-label").forEach(btn => {
    btn.addEventListener("click", async () => {
      const label = btn.getAttribute("data-label");
      if (!window.currentCaseId || !currentSelectedStudioTrigger) {
        toast.warning("Vui lòng chọn 1 mốc Trigger trong Replay Studio trước!");
        return;
      }
      const t = currentSelectedStudioTrigger;
      const payload = {
        case_id: window.currentCaseId,
        frame_idx: t.frame_idx,
        timestamp_ms: t.timestamp_ms,
        evidence_url: t.evidence_minio_url,
        predicted_state: t.context_state || "stable",
        ground_truth_label: label,
        verified_by: "human_evaluator",
      };

      try {
        const res = await fetch("/api/evaluation/label-sample", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          toast.success(`Đã gán nhãn "${label}" cho mốc Frame #${t.frame_idx} và lưu vào kho Dataset!`);
          loadCuratedDataset();
        }
      } catch (e) {
        toast.error("Lỗi khi lưu nhãn: " + e.message);
      }
    });
  });
}

// Hook to capture currently selected trigger in Studio
window.setStudioSelectedTriggerForEval = function(triggerObj) {
  currentSelectedStudioTrigger = triggerObj;
};
