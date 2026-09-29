// ---------------------------------------------------------
// TOAST NOTIFICATION UTILITIES
// ---------------------------------------------------------
const toast = {
  show(message, type = "info", duration = 4000) {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    
    const icons = {
      success: "🟢",
      info: "🔵",
      warning: "🟡",
      error: "🔴"
    };

    el.innerHTML = `
      <span style="font-size:1.1rem">${icons[type] || "ℹ️"}</span>
      <div style="flex:1">${message}</div>
    `;

    container.appendChild(el);

    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 300);
    }, duration);
  },
  success(msg) { this.show(msg, "success"); },
  info(msg) { this.show(msg, "info"); },
  warning(msg) { this.show(msg, "warning"); },
  error(msg) { this.show(msg, "error", 6000); }
};

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return "00:00 (0.0s)";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} (${sec.toFixed(1)}s)`;
}

function formatDateTime(isoStr) {
  if (!isoStr) return "--";
  try {
    let str = String(isoStr).trim();
    // If backend returns ISO string without timezone indicator, treat as UTC
    if (!str.endsWith("Z") && !str.includes("+") && !str.slice(10).includes("-")) {
      str += "Z";
    }
    const d = new Date(str);
    if (isNaN(d.getTime())) return isoStr;

    // Format explicitly in Vietnam timezone (Asia/Ho_Chi_Minh, GMT+7)
    const formatter = new Intl.DateTimeFormat("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const parts = formatter.formatToParts(d);
    const m = {};
    parts.forEach(p => { m[p.type] = p.value; });
    return `${m.hour}:${m.minute}:${m.second} ${m.day}/${m.month}/${m.year}`;
  } catch (e) {
    return isoStr;
  }
}

let currentCaseId = null;
let currentCaseData = null;
let telemetryData = [];
let motionPlot = null;
let cadencePlot = null;
let animationFrameId = null;
let debugWs = null;
let wsPingInterval = null;
let pipActive = false;

// Real-time Live Rolling Charts & Buffer State
let liveMotionPlot = null;
let liveCadencePlot = null;
const LIVE_BUFFER_MAX = 200; // ~30 seconds rolling buffer
let liveBuffer = {
  times: [],       // [0, 0.1, 0.2, ...]
  speeds: [],      // speed px/f
  sharpnesses: [], // sharpness
  cadences: [],    // dominant freq Hz
};
let liveStartTime = null;
let liveEventsList = [];
let currentVLMEvalRun = null;

document.addEventListener("DOMContentLoaded", () => {
  initSidebar();
  initSubTabs();
  initModals();
  initStudioLayout();
  initLiveCharts();
  initVideoPlayerSync();
  initPluginWorkbench();
  initVLMEvalWorkbench();
  initRouter();
  initWebSocketDebugger();
  loadCases();
  loadDevices();
});

// ---------------------------------------------------------
// 1. URI HASH ROUTER (DEEP LINKING)
// ---------------------------------------------------------
function initRouter() {
  window.addEventListener("hashchange", handleRoute);
  // Initial route dispatch
  if (!window.location.hash) {
    window.location.hash = "#/cases";
  } else {
    handleRoute();
  }
}

function handleRoute() {
  const hash = window.location.hash || "#/cases";
  document.getElementById("lbl-current-uri").textContent = hash;
  logDebug(`[Router] Navigated to URI: ${hash}`);

  // Route format: #/page or #/cases/:id or #/cases/:id/tuning or #/live/:dev_id
  const parts = hash.replace(/^#\//, "").split("/");
  const root = parts[0] || "cases";
  const param = parts[1] || null;
  const subAction = parts[2] || null;

  // 1. Match Root Page
  const pageMap = {
    cases: "page-cases",
    "data-eval": "page-data-eval",
    devices: "page-devices",
    live: "page-live",
    "vlm-eval": "page-vlm-eval",
    settings: "page-settings",
  };

  const targetPageId = pageMap[root] || "page-cases";
  document.querySelectorAll(".view-container").forEach((p) => p.classList.remove("active"));
  const targetPage = document.getElementById(targetPageId);
  if (targetPage) targetPage.classList.add("active");

  // Update Sidebar active state
  document.querySelectorAll(".sidebar-menu .menu-item").forEach((m) => {
    if (m.getAttribute("data-page") === targetPageId) {
      m.classList.add("active");
    } else {
      m.classList.remove("active");
    }
  });

  // 2. Handle Sub-routes & Detail Views
  if (root === "cases") {
    if (param) {
      // #/cases/:case_id
      if (subAction === "tuning") {
        switchSubTab("page-cases", "case-tuning");
        if (currentCaseId !== param) {
          openCaseStudio(param, false).then(() => {
            syncTuningSlidersFromCase(currentCaseData);
          });
        } else {
          syncTuningSlidersFromCase(currentCaseData);
        }
      } else {
        switchSubTab("page-cases", "case-studio");
      }
      if (currentCaseId !== param && subAction !== "tuning") {
        openCaseStudio(param, false); // Don't re-push hash
      } else if (subAction !== "tuning") {
        setTimeout(resizePlots, 80);
      }
    } else {
      // #/cases (Explorer list)
      switchSubTab("page-cases", "case-explorer");
    }
  } else if (root === "live") {
    const selectDev = document.getElementById("live-select-device");
    if (selectDev) {
      if (param && selectDev.value !== param) {
        selectDev.value = param;
      }
      if (selectDev.value) {
        selectDev.dispatchEvent(new Event("change"));
      }
    }
    setTimeout(resizePlots, 100);
    setTimeout(resizePlots, 300);
  } else if (root === "data-eval") {
    if (window.loadDataEvaluationWorkbench) {
      window.loadDataEvaluationWorkbench(param || currentCaseId);
    }
  } else if (root === "vlm-eval") {
    const selectCase = document.getElementById("vlm-select-case");
    if (selectCase) {
      if (param && selectCase.value !== param) {
        selectCase.value = param;
      } else if (!param && currentCaseId && selectCase.value !== currentCaseId) {
        selectCase.value = currentCaseId;
      }
      if (selectCase.value) {
        selectCase.dispatchEvent(new Event("change"));
      }
    }
  }
}

function navigateTo(hash) {
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  } else {
    handleRoute();
  }
}

function switchSubTab(pageId, subId) {
  const page = document.getElementById(pageId);
  if (!page) return;
  page.querySelectorAll(".sub-tab-btn").forEach((b) => {
    if (b.getAttribute("data-sub") === subId) b.classList.add("active");
    else b.classList.remove("active");
  });
  page.querySelectorAll(".sub-view-content").forEach((v) => (v.style.display = "none"));
  const targetView = document.getElementById(`sub-${subId}`);
  if (targetView) targetView.style.display = "block";
  if (subId === "case-studio") {
    setTimeout(resizePlots, 100);
  }
}

// ---------------------------------------------------------
// 2. WEBSOCKET REAL-TIME DEBUGGER LINK
// ---------------------------------------------------------
let debugDrawerListenersAttached = false;

function initWebSocketDebugger() {
  const badge = document.getElementById("ws-status-badge");
  const rttLabel = document.getElementById("lbl-ws-rtt");
  const drawer = document.getElementById("debug-drawer");

  if (!debugDrawerListenersAttached) {
    document.getElementById("btn-toggle-debug-drawer")?.addEventListener("click", () => {
      drawer.style.display = drawer.style.display === "flex" ? "none" : "flex";
    });
    document.getElementById("btn-close-debug-drawer")?.addEventListener("click", () => {
      drawer.style.display = "none";
    });
    document.getElementById("btn-clear-debug-log")?.addEventListener("click", () => {
      document.getElementById("debug-log-output").innerHTML = "";
    });
    debugDrawerListenersAttached = true;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/api/ws/debug`;

  logDebug(`[WebSocket] Connecting to ${wsUrl}...`);

  try {
    debugWs = new WebSocket(wsUrl);

    debugWs.onopen = () => {
      badge.textContent = "🟢 WS Connected";
      badge.style.color = "var(--accent-cyan)";
      logDebug("[WebSocket] Connected successfully to CBD Backend Engine.");

      // Start ping loop for RTT measurement
      if (wsPingInterval) clearInterval(wsPingInterval);
      wsPingInterval = setInterval(() => {
        if (debugWs.readyState === WebSocket.OPEN) {
          debugWs.send(JSON.stringify({ type: "PING", timestamp: Date.now() }));
        }
      }, 3000);
    };

    debugWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "PONG") {
          const rtt = Date.now() - msg.client_time;
          rttLabel.textContent = `${rtt} ms`;
        } else if (msg.type === "LIVE_TELEMETRY") {
          // Real-time telemetry packet received
          const t = msg.data;
          
          // 1. Update HUD numerical values
          const valSpeed = document.getElementById("live-val-speed");
          const valSharp = document.getElementById("live-val-sharpness");
          const valCad = document.getElementById("live-val-cadence");
          const valConf = document.getElementById("live-val-conf");
          const valDxDy = document.getElementById("live-val-dxdy");
          const valState = document.getElementById("live-val-state");
          const stateBadge = document.getElementById("live-val-state-badge");
          const statusText = document.getElementById("live-monitor-status");

          if (valSpeed) valSpeed.textContent = `${(t.speed || 0).toFixed(2)} px/f`;
          if (valSharp) valSharp.textContent = `${(t.sharpness || 0).toFixed(1)}`;
          if (valCad) valCad.textContent = `${(t.dominant_freq_hz || 0).toFixed(2)} Hz`;
          if (valConf) valConf.textContent = `${Math.round((t.confidence || 1.0) * 100)}%`;
          if (valDxDy) valDxDy.textContent = `${(t.dx || 0).toFixed(1)}, ${(t.dy || 0).toFixed(1)}`;
          if (valState) valState.textContent = (t.predicted_state || "STABLE").toUpperCase();
          
          if (stateBadge) {
            const st = t.predicted_state || "stable";
            stateBadge.textContent = st.toUpperCase();
            stateBadge.className = `metric-state state-${st.includes("periodic") ? "periodic" : st.includes("high") ? "high" : st}`;
          }

          if (statusText) {
            statusText.textContent = `• WS Frame #${t.frame_idx} | Speed: ${(t.speed||0).toFixed(1)}px | Sharp: ${(t.sharpness||0).toFixed(1)} | State: ${t.predicted_state}`;
          }

          // 2. Ingest into Rolling Charts
          pushLiveTelemetryData(t);

          // 3. Draw live canvas motion vector overlay
          drawLiveCanvasOverlay(t);

          logDebug(`[WS-Live #${t.frame_idx}] State: ${t.predicted_state} | Speed: ${(t.speed||0).toFixed(2)} | Latency: ${rttLabel.textContent}`);
        } else if (msg.type === "PROCESSING_PROGRESS") {
          // Progress update for video re-run
          if (msg.case_id === currentCaseId) {
            updateTuningProgress(msg);
          }
        } else if (msg.type === "PROCESSING_FINISHED") {
          // Finished event
          if (msg.case_id === currentCaseId) {
            handleTuningFinished(msg);
          }
        } else if (msg.type === "SYSTEM_INFO") {
          logDebug(`[System] Server Info: ${msg.data.server} (${msg.data.version}) - Status: ${msg.data.status}`);
        }
      } catch (e) {
        logDebug(`[WebSocket Raw] ${event.data}`);
      }
    };

    debugWs.onclose = () => {
      badge.textContent = "🔴 WS Disconnected";
      badge.style.color = "var(--accent-red)";
      logDebug("[WebSocket] Disconnected. Retrying in 4s...");
      if (wsPingInterval) clearInterval(wsPingInterval);
      setTimeout(initWebSocketDebugger, 4000);
    };

    debugWs.onerror = (err) => {
      logDebug(`[WebSocket Error] ${err.message || "Connection error"}`);
    };
  } catch (err) {
    logDebug(`[WebSocket Exception] ${err.message}`);
  }
}

function logDebug(text) {
  const out = document.getElementById("debug-log-output");
  if (!out) return;
  const now = new Date();
  const timeStr = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false
  }).format(now);
  const div = document.createElement("div");
  div.textContent = `[${timeStr}] ${text}`;
  out.appendChild(div);
  out.scrollTop = out.scrollHeight;
}

// ---------------------------------------------------------
// 3. SIDEBAR & NAVIGATION
// ---------------------------------------------------------
function initSidebar() {
  const sidebar = document.getElementById("sidebar");
  const toggleBtn = document.getElementById("btn-toggle-sidebar");
  const drawer = document.getElementById("debug-drawer");

  toggleBtn.addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
    if (drawer) {
      drawer.style.left = sidebar.classList.contains("collapsed") ? "var(--sidebar-collapsed-width)" : "var(--sidebar-width)";
    }
  });

  const menuItems = document.querySelectorAll(".sidebar-menu .menu-item");
  menuItems.forEach((item) => {
    item.addEventListener("click", () => {
      const pageId = item.getAttribute("data-page");
      const routeMap = {
        "page-cases": "#/cases",
        "page-data-eval": "#/data-eval",
        "page-devices": "#/devices",
        "page-live": "#/live",
        "page-vlm-eval": "#/vlm-eval",
        "page-settings": "#/settings",
      };
      navigateTo(routeMap[pageId] || "#/cases");
    });
  });
}

function initSubTabs() {
  const subTabBtns = document.querySelectorAll(".sub-tab-btn");
  subTabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const subId = btn.getAttribute("data-sub");
      if (subId === "case-explorer") {
        navigateTo("#/cases");
      } else if (subId === "case-studio") {
        if (currentCaseId) navigateTo(`#/cases/${currentCaseId}`);
        else navigateTo("#/cases");
      } else if (subId === "case-tuning") {
        if (currentCaseId) navigateTo(`#/cases/${currentCaseId}/tuning`);
      }
    });
  });
}

// ---------------------------------------------------------
// 2. MODALS (ROBUST SYSTEM WITH ACTIVE CLASS)
// ---------------------------------------------------------
// Safe Global Toast aliases
window.showToast = (msg, type = "info") => toast.show(msg, type);

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add("active");
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove("active");
  }
}

function initModals() {
  // Upload modal
  const uploadModal = document.getElementById("upload-modal");
  const formUpload = document.getElementById("form-upload-video");
  const btnSubmitUpload = document.getElementById("btn-submit-upload");
  const progressBox = document.getElementById("upload-progress-box");
  const progressBar = document.getElementById("upload-progress-bar");
  const progressPercent = document.getElementById("upload-progress-percent");
  const progressBytes = document.getElementById("upload-progress-bytes");
  const progressSpeed = document.getElementById("upload-progress-speed");
  const progressStatus = document.getElementById("upload-progress-status");

  document.getElementById("btn-open-upload-modal").addEventListener("click", () => {
    // Reset upload form & progress state
    if (formUpload) formUpload.reset();
    if (progressBox) progressBox.style.display = "none";
    if (btnSubmitUpload) {
      btnSubmitUpload.disabled = false;
      btnSubmitUpload.textContent = "🚀 Bắt Đầu Tải Lên & Phân Tích";
    }
    openModal("upload-modal");
  });
  document.getElementById("btn-close-upload-modal").addEventListener("click", () => {
    closeModal("upload-modal");
  });

  formUpload.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = document.getElementById("upload-case-title").value;
    const file = document.getElementById("upload-video-file").files[0];
    if (!file) {
      toast.warning("Vui lòng chọn 1 file video!");
      return;
    }

    const formData = new FormData();
    formData.append("file", file);
    if (title) formData.append("title", title);

    // Show Progress Bar
    if (progressBox) progressBox.style.display = "block";
    if (progressBar) progressBar.style.width = "0%";
    if (progressPercent) progressPercent.textContent = "0%";
    if (progressStatus) progressStatus.textContent = "🚀 Đang tải lên server...";
    if (btnSubmitUpload) {
      btnSubmitUpload.disabled = true;
      btnSubmitUpload.textContent = "⏳ Đang tải lên...";
    }

    toast.info(`Bắt đầu tải file: ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)...`);

    const xhr = new XMLHttpRequest();
    const startTime = Date.now();

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        const loadedMb = (event.loaded / (1024 * 1024)).toFixed(1);
        const totalMb = (event.total / (1024 * 1024)).toFixed(1);
        const elapsedSec = (Date.now() - startTime) / 1000.0;
        const speedMb = elapsedSec > 0 ? (event.loaded / (1024 * 1024) / elapsedSec).toFixed(1) : "--";

        if (progressBar) progressBar.style.width = `${percent}%`;
        if (progressPercent) progressPercent.textContent = `${percent}%`;
        if (progressBytes) progressBytes.textContent = `${loadedMb} MB / ${totalMb} MB`;
        if (progressSpeed) progressSpeed.textContent = `${speedMb} MB/s`;

        if (percent >= 100) {
          if (progressStatus) progressStatus.textContent = "⚙️ Đang xử lý & khởi tạo Case...";
          if (btnSubmitUpload) btnSubmitUpload.textContent = "⚙️ Đang xử lý...";
        }
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          toast.success(`Upload thành công! Case ID: ${data.case_id}`);
          closeModal("upload-modal");
          loadCases();
          navigateTo(`#/cases/${data.case_id}`);
        } catch (err) {
          toast.error("Lỗi đọc kết quả server: " + err.message);
          if (btnSubmitUpload) {
            btnSubmitUpload.disabled = false;
            btnSubmitUpload.textContent = "🚀 Bắt Đầu Tải Lên & Phân Tích";
          }
        }
      } else {
        toast.error(`Upload thất bại (HTTP ${xhr.status}): ${xhr.statusText}`);
        if (btnSubmitUpload) {
          btnSubmitUpload.disabled = false;
          btnSubmitUpload.textContent = "🚀 Bắt Đầu Tải Lên & Phân Tích";
        }
      }
    };

    xhr.onerror = () => {
      toast.error("Lỗi kết nối mạng khi tải lên!");
      if (btnSubmitUpload) {
        btnSubmitUpload.disabled = false;
        btnSubmitUpload.textContent = "🚀 Bắt Đầu Tải Lên & Phân Tích";
      }
    };

    xhr.open("POST", "/api/cases/upload");
    xhr.send(formData);
  });

  // Device modal
  document.getElementById("btn-open-add-device-modal").addEventListener("click", () => {
    openModal("add-device-modal");
  });
  document.getElementById("btn-close-device-modal").addEventListener("click", () => {
    closeModal("add-device-modal");
  });

  document.getElementById("form-add-device").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById("device-name").value,
      rtsp_main_url: document.getElementById("device-rtsp-main").value,
      rtsp_sub_url: document.getElementById("device-rtsp-sub").value,
      location: document.getElementById("device-location").value,
    };
    closeModal("add-device-modal");
    await fetch("/api/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast.success("Đã thêm camera mới thành công!");
    loadDevices();
  });

  // Evidence modal
  document.getElementById("btn-close-evidence-modal").addEventListener("click", () => {
    closeModal("evidence-modal");
  });

  // Global close on backdrop click & ESC key
  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        overlay.classList.remove("active");
      }
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      document.querySelectorAll(".modal-overlay.active").forEach((m) => {
        m.classList.remove("active");
      });
    }
  });
}

// ---------------------------------------------------------
// 2.5 STUDIO WORKBENCH LAYOUT SWITCHER
// ---------------------------------------------------------
function initStudioLayout() {
  const container = document.getElementById("studio-grid-container");
  const btnSplit = document.getElementById("btn-layout-split");
  const btnStacked = document.getElementById("btn-layout-stacked");
  const btnPip = document.getElementById("btn-layout-pip");
  const pipBox = document.getElementById("pip-mini-video-box");
  const btnClosePip = document.getElementById("btn-close-pip");
  const pipVideo = document.getElementById("pip-video");
  const mainVideo = document.getElementById("main-video");

  // Load saved preference
  const savedMode = localStorage.getItem("cbd_studio_layout") || "side-by-side";
  setStudioLayout(savedMode);

  if (btnSplit) {
    btnSplit.addEventListener("click", () => setStudioLayout("side-by-side"));
  }
  if (btnStacked) {
    btnStacked.addEventListener("click", () => setStudioLayout("stacked"));
  }
  if (btnPip) {
    btnPip.addEventListener("click", () => togglePipMode());
  }
  if (btnClosePip) {
    btnClosePip.addEventListener("click", () => {
      pipActive = false;
      if (pipBox) pipBox.style.display = "none";
      if (btnPip) btnPip.classList.remove("active");
    });
  }

  function setStudioLayout(mode) {
    if (!container) return;
    localStorage.setItem("cbd_studio_layout", mode);

    if (mode === "stacked") {
      container.classList.remove("layout-side-by-side");
      container.classList.add("layout-stacked");
      if (btnStacked) btnStacked.classList.add("active");
      if (btnSplit) btnSplit.classList.remove("active");
    } else {
      container.classList.remove("layout-stacked");
      container.classList.add("layout-side-by-side");
      if (btnSplit) btnSplit.classList.add("active");
      if (btnStacked) btnStacked.classList.remove("active");
    }

    // Force uPlot to adapt to new container width
    setTimeout(resizePlots, 80);
    setTimeout(resizePlots, 250);
  }

  function togglePipMode() {
    pipActive = !pipActive;
    if (pipActive) {
      if (pipBox) pipBox.style.display = "flex";
      if (btnPip) btnPip.classList.add("active");
      if (pipVideo && mainVideo && pipVideo.src !== mainVideo.src) {
        pipVideo.src = mainVideo.src;
        pipVideo.currentTime = mainVideo.currentTime;
      }
    } else {
      if (pipBox) pipBox.style.display = "none";
      if (btnPip) btnPip.classList.remove("active");
    }
  }
}

// ---------------------------------------------------------
// 3. CASE EXPLORER & DATA FETCHING
// ---------------------------------------------------------
async function loadCases() {
  const tbody = document.getElementById("case-table-body");
  const selectVLMCase = document.getElementById("vlm-select-case");
  tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;">Đang tải danh sách...</td></tr>`;

  try {
    const res = await fetch("/api/cases");
    const cases = await res.json();
    tbody.innerHTML = "";
    if (selectVLMCase) selectVLMCase.innerHTML = "";

    if (cases.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; color:var(--text-muted);">Chưa có case nào. Hãy bấm 'Upload Video Mới' để bắt đầu.</td></tr>`;
      if (selectVLMCase) selectVLMCase.innerHTML = `<option value="">Chưa có Case nào</option>`;
      return;
    }

    cases.forEach((c) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><code style="color:var(--accent-cyan);">${c.id}</code></td>
        <td><b>${c.title}</b></td>
        <td><span class="trigger-tag tag-periodic">${c.source_type}</span></td>
        <td><b>${formatDuration(c.duration_sec)}</b></td>
        <td>${(c.fps || 0).toFixed(1)} fps / ${c.total_frames || 0} f</td>
        <td style="font-size:0.8rem; color:var(--text-secondary);">${formatDateTime(c.created_at)}</td>
        <td><b>${c.trigger_count}</b> nổ</td>
        <td><span class="trigger-tag ${c.status === "ready" ? "tag-stable" : "tag-spike"}">${c.status}</span></td>
        <td>
          <button class="btn btn-primary btn-open-case" data-id="${c.id}" style="padding:4px 10px;">🧪 Mở Studio</button>
          <button class="btn btn-danger btn-del-case" data-id="${c.id}" style="padding:4px 8px;">✕</button>
        </td>
      `;
      tbody.appendChild(tr);

      // Populate VLM Case Select Box
      if (selectVLMCase) {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = `${c.title} (${c.id}) - ${c.trigger_count} Triggers`;
        selectVLMCase.appendChild(opt);
      }
    });

    // Auto-select in VLM if currentCaseId exists
    if (selectVLMCase && currentCaseId) {
      selectVLMCase.value = currentCaseId;
    }

    document.querySelectorAll(".btn-open-case").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        navigateTo(`#/cases/${id}`);
      });
    });

    document.querySelectorAll(".btn-del-case").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (confirm("Xóa case này?")) {
          await fetch(`/api/cases/${btn.getAttribute("data-id")}`, { method: "DELETE" });
          loadCases();
        }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" style="color:var(--accent-red)">Lỗi: ${err.message}</td></tr>`;
  }
}

document.getElementById("btn-refresh-cases").addEventListener("click", loadCases);

// ---------------------------------------------------------
// 4. CASE STUDIO & SYNCHRONIZATION
// ---------------------------------------------------------
async function openCaseStudio(caseId, updateHash = true, forceReload = false) {
  if (currentCaseId === caseId && !forceReload && telemetryData.length > 0) {
    if (updateHash) navigateTo(`#/cases/${caseId}`);
    setTimeout(resizePlots, 100);
    return;
  }

  currentCaseId = caseId;
  if (updateHash) {
    navigateTo(`#/cases/${caseId}`);
  }

  logDebug(`[Studio] Loading details for Case: ${caseId}`);
  const res = await fetch(`/api/cases/${caseId}`);
  currentCaseData = await res.json();

  document.getElementById("studio-case-title").textContent = `${currentCaseData.title} (${currentCaseData.id})`;
  
  // Set detailed metadata badges
  const resBadge = document.getElementById("studio-meta-res");
  const fpsBadge = document.getElementById("studio-meta-fps");
  const durBadge = document.getElementById("studio-meta-duration");
  const createdBadge = document.getElementById("studio-meta-created");

  if (resBadge) resBadge.textContent = `📐 ${currentCaseData.resolution || "HD"}`;
  if (fpsBadge) fpsBadge.textContent = `🎞️ ${(currentCaseData.fps || 0).toFixed(1)} fps (${currentCaseData.total_frames || 0} f)`;
  if (durBadge) durBadge.textContent = `⏱️ ${formatDuration(currentCaseData.duration_sec)}`;
  if (createdBadge) createdBadge.textContent = `📅 ${formatDateTime(currentCaseData.created_at)}`;

  // Check status & display banner if processing
  const processingBanner = document.getElementById("studio-processing-banner");
  if (currentCaseData.status === "processing") {
    if (processingBanner) {
      processingBanner.style.display = "block";
      const procTxt = document.getElementById("studio-processing-text");
      if (procTxt) procTxt.textContent = `Đang phân tích mô hình toán học trên video (${currentCaseData.id})...`;
    }
  } else {
    if (processingBanner) processingBanner.style.display = "none";
  }

  // Sync sliders for tuning tab
  syncTuningSlidersFromCase(currentCaseData);

  // Load Video source
  const video = document.getElementById("main-video");
  video.src = `/api/cases/${caseId}/video`;
  video.load();

  // Also sync pip video source if open
  const pipVideo = document.getElementById("pip-video");
  if (pipVideo) {
    pipVideo.src = `/api/cases/${caseId}/video`;
    pipVideo.load();
  }

  // Load Telemetry & Build uPlot Charts
  const telRes = await fetch(`/api/cases/${caseId}/telemetry`);
  telemetryData = await telRes.json();

  renderTriggers(currentCaseData.triggers || []);
  renderBehaviorTimeline(telemetryData);
  buildCharts(telemetryData);
  logDebug(`[Studio] Loaded ${telemetryData.length} telemetry records & ${(currentCaseData.triggers || []).length} triggers.`);
}

function renderTriggers(triggers) {
  const container = document.getElementById("trigger-list");
  const metaDeck = document.getElementById("trigger-metadata-deck");
  container.innerHTML = "";
  document.getElementById("trigger-total-count").textContent = `${triggers.length} Sự kiện`;

  if (triggers.length === 0) {
    container.innerHTML = `<div style="padding:12px; color:var(--text-muted); font-size:0.85rem;">Không có trigger nào nổ trong case này.</div>`;
    if (metaDeck) metaDeck.style.display = "none";
    return;
  }

  // Display rich metadata in the Deck for selected trigger
  function showTriggerMetaDeck(tr) {
    if (!metaDeck) return;
    metaDeck.style.display = "block";
    const timeSec = (tr.timestamp_ms / 1000.0).toFixed(2);
    document.getElementById("deck-trigger-time").textContent = `⏱️ ${formatSecondsToMMSS(tr.timestamp_ms / 1000.0)} (${timeSec}s)`;

    const d = tr.details || {};
    const sp = d.spatial_motion || {};
    const vq = d.visual_quality || {};
    const cg = d.cadence_gait || {};
    const tc = d.temporal_context || {};

    const sharpVal = vq.sharpness_laplacian || tr.sharpness_score || 0;
    const occlVal = vq.occlusion_ratio !== undefined ? (vq.occlusion_ratio * 100).toFixed(0) : "0";
    const dwellVal = tc.dwell_duration_sec !== undefined ? tc.dwell_duration_sec : (d.stable_duration_sec || 0);
    const yawVal = sp.angular_yaw_vel_px_s !== undefined ? sp.angular_yaw_vel_px_s : 0;
    const preVal = tc.pre_stability_score !== undefined ? tc.pre_stability_score : 1.0;
    const stateVal = cg.predicted_state || tr.context_state || "stable";

    document.getElementById("deck-val-sharpness").textContent = `${Number(sharpVal).toFixed(1)}`;
    document.getElementById("deck-val-occlusion").textContent = `${occlVal}%`;
    document.getElementById("deck-val-dwell").textContent = `${dwellVal}s`;
    document.getElementById("deck-val-yaw").textContent = `${yawVal} px/s`;
    document.getElementById("deck-val-pre-stability").textContent = `${preVal}`;
    document.getElementById("deck-val-state").textContent = `${stateVal}`;

    const jsonPre = document.getElementById("deck-json-payload");
    if (jsonPre) {
      jsonPre.textContent = JSON.stringify({
        trigger_type: tr.trigger_type,
        timestamp_sec: parseFloat(timeSec),
        reason: tr.reason,
        evidence_url: tr.evidence_minio_url,
        rich_metadata: d
      }, null, 2);
    }
  }

  // Default display first trigger
  if (triggers.length > 0) {
    showTriggerMetaDeck(triggers[0]);
    if (window.setStudioSelectedTriggerForEval) {
      window.setStudioSelectedTriggerForEval(triggers[0]);
    }
  }

  triggers.forEach((tr, idx) => {
    const timeSec = (tr.timestamp_ms / 1000.0).toFixed(2);
    const item = document.createElement("div");
    item.className = `trigger-item ${idx === 0 ? "active-trigger" : ""}`;
    item.innerHTML = `
      <div>
        <span class="trigger-tag ${tr.trigger_type.includes("STABLE") ? "tag-stable" : "tag-spike"}">${tr.trigger_type}</span>
        <span style="font-family:monospace; margin-left:8px;">${timeSec}s</span>
        <div style="font-size:0.78rem; color:var(--text-secondary); margin-top:2px;">${tr.reason}</div>
      </div>
      ${tr.evidence_minio_url ? `<button class="btn btn-show-evidence" data-url="${tr.evidence_minio_url}" data-reason="${tr.reason}" style="padding:3px 8px; font-size:0.75rem;">📸 Xem ảnh</button>` : ""}
    `;

    item.addEventListener("click", (e) => {
      if (e.target.classList.contains("btn-show-evidence")) return;
      document.querySelectorAll(".trigger-item").forEach(el => el.classList.remove("active-trigger"));
      item.classList.add("active-trigger");
      showTriggerMetaDeck(tr);
      if (window.setStudioSelectedTriggerForEval) {
        window.setStudioSelectedTriggerForEval(tr);
      }

      const targetSec = tr.timestamp_ms / 1000.0;
      seekVideoToTime(targetSec);

      // Focus timeline zoom window around trigger (30s window) if currently zoomed
      if (motionPlot && (chartFullRange[1] - chartFullRange[0]) > 60) {
        const zoomSpan = 45; // 45s context window
        let zMin = Math.max(chartFullRange[0], targetSec - 15);
        let zMax = Math.min(chartFullRange[1], zMin + zoomSpan);
        if (zMax - zMin < zoomSpan) zMin = Math.max(chartFullRange[0], zMax - zoomSpan);

        motionPlot.setScale("x", { min: zMin, max: zMax });
        if (cadencePlot) cadencePlot.setScale("x", { min: zMin, max: zMax });
        updateZoomLabel(zMin, zMax);
      }
    });

    const evBtn = item.querySelector(".btn-show-evidence");
    if (evBtn) {
      evBtn.addEventListener("click", () => {
        document.getElementById("evidence-img").src = evBtn.getAttribute("data-url");
        document.getElementById("evidence-reason").textContent = evBtn.getAttribute("data-reason");
        openModal("evidence-modal");
      });
    }

    container.appendChild(item);
  });
}

// ---------------------------------------------------------
// 5. uPlot INTERACTIVE CHARTS WITH ZOOM & PAN
// ---------------------------------------------------------
let chartFullRange = [0, 10]; // [min, max]

function formatSecondsToMMSS(val) {
  if (val === null || val === undefined || isNaN(val)) return "--:--";
  const m = Math.floor(Math.max(0, val) / 60);
  const s = Math.floor(Math.max(0, val) % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function updateZoomLabel(min, max) {
  const lbl = document.getElementById("lbl-zoom-window");
  if (lbl) {
    lbl.textContent = `${formatSecondsToMMSS(min)} - ${formatSecondsToMMSS(max)} (Δ${(max - min).toFixed(1)}s)`;
  }
}

function setTimelineZoomSpan(spanSeconds) {
  if (!motionPlot || !cadencePlot) return;
  const maxTime = chartFullRange[1];

  if (spanSeconds === "all" || spanSeconds >= maxTime) {
    motionPlot.setScale("x", { min: chartFullRange[0], max: chartFullRange[1] });
    cadencePlot.setScale("x", { min: chartFullRange[0], max: chartFullRange[1] });
    updateZoomLabel(chartFullRange[0], chartFullRange[1]);
    return;
  }

  const video = document.getElementById("main-video");
  const curTime = (video && isFinite(video.currentTime)) ? video.currentTime : 0;
  
  let newMin = Math.max(0, curTime - spanSeconds / 3);
  let newMax = newMin + spanSeconds;
  if (newMax > maxTime) {
    newMax = maxTime;
    newMin = Math.max(0, newMax - spanSeconds);
  }

  motionPlot.setScale("x", { min: newMin, max: newMax });
  cadencePlot.setScale("x", { min: newMin, max: newMax });
  updateZoomLabel(newMin, newMax);
}

function buildCharts(data) {
  if (!data || data.length === 0) return;

  const timestampsSec = data.map((d) => d.timestamp_ms / 1000.0);
  const speeds = data.map((d) => d.speed);
  const sharpnesses = data.map((d) => d.sharpness);
  const cadences = data.map((d) => d.dominant_freq_hz);

  const minTime = timestampsSec[0] || 0;
  const maxTime = timestampsSec[timestampsSec.length - 1] || 10;
  chartFullRange = [minTime, maxTime];
  updateZoomLabel(minTime, maxTime);

  const motionContainer = document.getElementById("chart-motion");
  const cadenceContainer = document.getElementById("chart-cadence");
  motionContainer.innerHTML = "";
  cadenceContainer.innerHTML = "";

  const width = motionContainer.clientWidth || 800;

  // Zoom plugin: Mouse Wheel Zoom
  function wheelZoomPlugin() {
    return {
      hooks: {
        init: (u) => {
          u.over.addEventListener("wheel", (e) => {
            e.preventDefault();
            const { left, width } = u.over.getBoundingClientRect();
            const xVal = u.posToVal(e.clientX - left, "x");
            const factor = e.deltaY < 0 ? 0.75 : 1.33;

            const min = u.scales.x.min;
            const max = u.scales.x.max;
            const range = (max - min) * factor;

            if (range < 2.0 && factor < 1) return; // limit min 2s zoom
            if (range > (chartFullRange[1] - chartFullRange[0]) && factor > 1) {
              u.setScale("x", { min: chartFullRange[0], max: chartFullRange[1] });
              if (cadencePlot && u !== cadencePlot) cadencePlot.setScale("x", { min: chartFullRange[0], max: chartFullRange[1] });
              if (motionPlot && u !== motionPlot) motionPlot.setScale("x", { min: chartFullRange[0], max: chartFullRange[1] });
              updateZoomLabel(chartFullRange[0], chartFullRange[1]);
              return;
            }

            const leftRatio = (xVal - min) / (max - min);
            const newMin = Math.max(chartFullRange[0], xVal - leftRatio * range);
            const newMax = Math.min(chartFullRange[1], newMin + range);

            u.setScale("x", { min: newMin, max: newMax });
            if (cadencePlot && u !== cadencePlot) cadencePlot.setScale("x", { min: newMin, max: newMax });
            if (motionPlot && u !== motionPlot) motionPlot.setScale("x", { min: newMin, max: newMax });
            updateZoomLabel(newMin, newMax);
          });
        },
      },
    };
  }

  // Chart 1: Motion Speed
  const optsMotion = {
    width: width,
    height: 180,
    cursor: {
      sync: { key: "cbd_sync" },
      drag: { x: true, y: false, setScale: false },
    },
    plugins: [wheelZoomPlugin()],
    scales: {
      x: { time: false, min: minTime, max: maxTime },
    },
    series: [
      {
        label: "Thời gian",
        value: (u, v) => formatSecondsToMMSS(v) + ` (${(v||0).toFixed(1)}s)`,
      },
      {
        label: "Tốc độ rung (px/f)",
        stroke: "#00e5a3",
        width: 2,
        fill: "rgba(0, 229, 163, 0.1)",
      },
    ],
    axes: [
      {
        stroke: "#8b949e",
        grid: { stroke: "#21262d" },
        values: (u, vals) => vals.map(formatSecondsToMMSS),
      },
      { stroke: "#8b949e", grid: { stroke: "#21262d" } },
    ],
    hooks: {
      setCursor: [
        (u) => {
          if (u.cursor.idx !== null && !document.getElementById("main-video").seeking) {
            const timeSec = timestampsSec[u.cursor.idx];
            if (timeSec !== undefined && Math.abs(document.getElementById("main-video").currentTime - timeSec) > 0.15) {
              seekVideoToTime(timeSec);
            }
          }
        },
      ],
      setSelect: [
        (u) => {
          const min = u.posToVal(u.select.left, "x");
          const max = u.posToVal(u.select.left + u.select.width, "x");
          if (Math.abs(max - min) > 1.0) {
            u.setScale("x", { min, max });
            if (cadencePlot) cadencePlot.setScale("x", { min, max });
            updateZoomLabel(min, max);
          }
          u.setSelect({ width: 0, height: 0 }, false);
        },
      ],
    },
  };

  motionPlot = new uPlot(optsMotion, [timestampsSec, speeds], motionContainer);

  // Chart 2: Cadence Hz & Sharpness
  const optsCadence = {
    width: width,
    height: 140,
    cursor: {
      sync: { key: "cbd_sync" },
      drag: { x: true, y: false, setScale: false },
    },
    plugins: [wheelZoomPlugin()],
    scales: {
      x: { time: false, min: minTime, max: maxTime },
    },
    series: [
      {
        label: "Thời gian",
        value: (u, v) => formatSecondsToMMSS(v) + ` (${(v||0).toFixed(1)}s)`,
      },
      {
        label: "Nhịp Hz",
        stroke: "#a371f7",
        width: 2,
      },
      {
        label: "Độ nét",
        stroke: "#388bfd",
        width: 1.5,
      },
    ],
    axes: [
      {
        stroke: "#8b949e",
        grid: { stroke: "#21262d" },
        values: (u, vals) => vals.map(formatSecondsToMMSS),
      },
      { stroke: "#8b949e", grid: { stroke: "#21262d" } },
    ],
    hooks: {
      setSelect: [
        (u) => {
          const min = u.posToVal(u.select.left, "x");
          const max = u.posToVal(u.select.left + u.select.width, "x");
          if (Math.abs(max - min) > 1.0) {
            u.setScale("x", { min, max });
            if (motionPlot) motionPlot.setScale("x", { min, max });
            updateZoomLabel(min, max);
          }
          u.setSelect({ width: 0, height: 0 }, false);
        },
      ],
    },
  };

  cadencePlot = new uPlot(optsCadence, [timestampsSec, cadences, sharpnesses], cadenceContainer);

  // Bind Preset Buttons
  document.querySelectorAll(".btn-time-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".btn-time-preset").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const span = btn.getAttribute("data-span");
      setTimelineZoomSpan(span === "all" ? "all" : parseFloat(span));
    });
  });

  const btnResetZoom = document.getElementById("btn-reset-zoom");
  if (btnResetZoom) {
    btnResetZoom.addEventListener("click", () => {
      document.querySelectorAll(".btn-time-preset").forEach((b) => b.classList.remove("active"));
      const allBtn = document.querySelector(".btn-time-preset[data-span='all']");
      if (allBtn) allBtn.classList.add("active");
      setTimelineZoomSpan("all");
    });
  }
}

function resizePlots() {
  const motionContainer = document.getElementById("chart-motion");
  const cadenceContainer = document.getElementById("chart-cadence");
  const liveMotionContainer = document.getElementById("live-chart-motion");
  const liveCadenceContainer = document.getElementById("live-chart-cadence");

  if (motionContainer && cadenceContainer) {
    const width = motionContainer.clientWidth || 800;
    if (motionPlot) motionPlot.setSize({ width, height: 180 });
    if (cadencePlot) cadencePlot.setSize({ width, height: 140 });
  }

  if (liveMotionContainer && liveCadenceContainer) {
    const liveWidth = liveMotionContainer.clientWidth || 500;
    if (liveMotionPlot) liveMotionPlot.setSize({ width: liveWidth, height: 170 });
    if (liveCadencePlot) liveCadencePlot.setSize({ width: liveWidth, height: 130 });
  }
}
window.addEventListener("resize", resizePlots);

// ---------------------------------------------------------
// 6. VIDEO PLAYER SYNC & CANVAS OVERLAY
// ---------------------------------------------------------
function initVideoPlayerSync() {
  const video = document.getElementById("main-video");
  const playBtn = document.getElementById("btn-play-pause");
  const rateSelect = document.getElementById("select-playback-rate");

  playBtn.addEventListener("click", () => {
    if (video.paused) {
      video.play().then(() => {
        playBtn.textContent = "⏸ Pause";
        startSyncLoop();
      }).catch(e => console.warn("Play error:", e));
    } else {
      video.pause();
      playBtn.textContent = "▶ Play";
      stopSyncLoop();
    }
  });

  rateSelect.addEventListener("change", () => {
    video.playbackRate = parseFloat(rateSelect.value);
  });

  document.getElementById("btn-prev-frame").addEventListener("click", () => {
    const fps = (currentCaseData && currentCaseData.fps) ? currentCaseData.fps : 30.0;
    const cur = isFinite(video.currentTime) ? video.currentTime : 0;
    seekVideoToTime(Math.max(0, cur - 1.0 / fps));
  });

  document.getElementById("btn-next-frame").addEventListener("click", () => {
    const fps = (currentCaseData && currentCaseData.fps) ? currentCaseData.fps : 30.0;
    const cur = isFinite(video.currentTime) ? video.currentTime : 0;
    const dur = isFinite(video.duration) ? video.duration : cur + 10;
    seekVideoToTime(Math.min(dur, cur + 1.0 / fps));
  });

  video.addEventListener("seeked", () => {
    updateCurrentMetrics();
    syncPipVideo();
  });
  video.addEventListener("timeupdate", () => {
    updateCurrentMetrics();
    syncPipVideo();
  });
}

function syncPipVideo() {
  if (!pipActive) return;
  const mainVideo = document.getElementById("main-video");
  const pipVideo = document.getElementById("pip-video");
  if (mainVideo && pipVideo && isFinite(mainVideo.currentTime)) {
    if (Math.abs(pipVideo.currentTime - mainVideo.currentTime) > 0.2) {
      pipVideo.currentTime = mainVideo.currentTime;
    }
    if (!mainVideo.paused && pipVideo.paused) pipVideo.play().catch(()=>{});
    if (mainVideo.paused && !pipVideo.paused) pipVideo.pause();
  }
}

function seekVideoToTime(timeSec) {
  if (!isFinite(timeSec) || isNaN(timeSec)) return;
  const video = document.getElementById("main-video");
  video.currentTime = timeSec;
  updateCurrentMetrics();
  syncPipVideo();
}

function startSyncLoop() {
  function loop() {
    updateCurrentMetrics();
    animationFrameId = requestAnimationFrame(loop);
  }
  animationFrameId = requestAnimationFrame(loop);
}

function stopSyncLoop() {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
}

function updateCurrentMetrics() {
  const video = document.getElementById("main-video");
  const curTime = isFinite(video.currentTime) ? video.currentTime : 0;
  const dur = isFinite(video.duration) ? video.duration : 0;

  document.getElementById("time-display").textContent = `${formatTime(curTime)} / ${formatTime(dur)}`;

  if (!telemetryData || telemetryData.length === 0) return;

  // Binary search or find nearest telemetry record
  const curMs = curTime * 1000.0;
  let rec = telemetryData[0];
  let minDiff = 999999;
  for (let i = 0; i < telemetryData.length; i++) {
    const diff = Math.abs(telemetryData[i].timestamp_ms - curMs);
    if (diff < minDiff) {
      minDiff = diff;
      rec = telemetryData[i];
    } else {
      break;
    }
  }

  // Update UI values
  document.getElementById("val-speed").textContent = `${rec.speed.toFixed(2)} px/f`;
  document.getElementById("val-dx-dy").textContent = `${rec.flow_dx.toFixed(1)}, ${rec.flow_dy.toFixed(1)}`;
  document.getElementById("val-rotation").textContent = `${rec.rotation_deg.toFixed(2)}°`;
  document.getElementById("val-sharpness").textContent = `${rec.sharpness.toFixed(1)}`;
  document.getElementById("val-cadence").textContent = `${rec.dominant_freq_hz.toFixed(2)} Hz`;
  document.getElementById("val-confidence").textContent = `${Math.round(rec.confidence * 100)}%`;

  const badge = document.getElementById("current-state-badge");
  badge.textContent = rec.predicted_state.toUpperCase();
  badge.className = `metric-state state-${rec.predicted_state.includes("periodic") ? "periodic" : rec.predicted_state.includes("high") ? "high" : rec.predicted_state}`;

  // Draw Canvas Overlay
  drawCanvasOverlay(rec);
}

function drawCanvasOverlay(rec) {
  const video = document.getElementById("main-video");
  const canvas = document.getElementById("canvas-overlay");
  const ctx = canvas.getContext("2d");

  canvas.width = video.clientWidth;
  canvas.height = video.clientHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!rec) return;

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  // Draw Global Motion Arrow
  const arrowScale = 8.0;
  const targetX = cx + rec.flow_dx * arrowScale;
  const targetY = cy + rec.flow_dy * arrowScale;

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(targetX, targetY);
  ctx.strokeStyle = "#00e5a3";
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(targetX, targetY, 5, 0, 2 * Math.PI);
  ctx.fillStyle = "#ff4d4f";
  ctx.fill();
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

// ---------------------------------------------------------
// 7. REAL-TIME LIVE ROLLING CHARTS & HUD OVERLAY
// ---------------------------------------------------------
function initLiveCharts() {
  const motionContainer = document.getElementById("live-chart-motion");
  const cadenceContainer = document.getElementById("live-chart-cadence");
  if (!motionContainer || !cadenceContainer) return;

  motionContainer.innerHTML = "";
  cadenceContainer.innerHTML = "";
  const width = motionContainer.clientWidth || 500;

  // Initialize buffer with placeholder 0 points
  liveBuffer.times = [];
  liveBuffer.speeds = [];
  liveBuffer.sharpnesses = [];
  liveBuffer.cadences = [];

  for (let i = 0; i < 30; i++) {
    liveBuffer.times.push(i);
    liveBuffer.speeds.push(0);
    liveBuffer.sharpnesses.push(0);
    liveBuffer.cadences.push(0);
  }

  // Chart 1: Real-time Speed Waveform
  const optsMotion = {
    width: width,
    height: 170,
    scales: {
      x: { time: false },
      y: { auto: true, range: [0, 25] },
    },
    series: [
      { label: "Mốc (s)" },
      {
        label: "Tốc độ rung (px/f)",
        stroke: "#00e5a3",
        width: 2,
        fill: "rgba(0, 229, 163, 0.12)",
      },
    ],
    axes: [
      { stroke: "#8b949e", grid: { stroke: "#21262d" } },
      { stroke: "#8b949e", grid: { stroke: "#21262d" } },
    ],
  };

  // Chart 2: Real-time Sharpness & Cadence
  const optsCadence = {
    width: width,
    height: 130,
    scales: {
      x: { time: false },
      y: { auto: true },
      cadence: { auto: true, range: [0, 4] },
    },
    series: [
      { label: "Mốc (s)" },
      {
        label: "Độ nét (Sharpness)",
        stroke: "#58a6ff",
        width: 1.5,
        scale: "y",
      },
      {
        label: "Nhịp bước (Hz)",
        stroke: "#d2a8ff",
        width: 2,
        scale: "cadence",
      },
    ],
    axes: [
      { stroke: "#8b949e", grid: { stroke: "#21262d" } },
      { stroke: "#58a6ff", scale: "y", grid: { stroke: "#21262d" } },
      { stroke: "#d2a8ff", scale: "cadence", side: 1, grid: { show: false } },
    ],
  };

  try {
    liveMotionPlot = new uPlot(optsMotion, [liveBuffer.times, liveBuffer.speeds], motionContainer);
    liveCadencePlot = new uPlot(optsCadence, [liveBuffer.times, liveBuffer.sharpnesses, liveBuffer.cadences], cadenceContainer);
  } catch (e) {
    console.warn("Live plot init err:", e);
  }
}

function pushLiveTelemetryData(t) {
  if (!liveStartTime) liveStartTime = Date.now();
  const elapsedSec = (Date.now() - liveStartTime) / 1000.0;

  liveBuffer.times.push(parseFloat(elapsedSec.toFixed(2)));
  liveBuffer.speeds.push(parseFloat((t.speed || 0).toFixed(2)));
  liveBuffer.sharpnesses.push(parseFloat((t.sharpness || 0).toFixed(1)));
  liveBuffer.cadences.push(parseFloat((t.dominant_freq_hz || 0).toFixed(2)));

  if (liveBuffer.times.length > LIVE_BUFFER_MAX) {
    liveBuffer.times.shift();
    liveBuffer.speeds.shift();
    liveBuffer.sharpnesses.shift();
    liveBuffer.cadences.shift();
  }

  // Throttled chart render for smooth 60fps UI
  if (liveMotionPlot) {
    liveMotionPlot.setData([liveBuffer.times, liveBuffer.speeds]);
  }
  if (liveCadencePlot) {
    liveCadencePlot.setData([liveBuffer.times, liveBuffer.sharpnesses, liveBuffer.cadences]);
  }

  // Add event to Live Ticker if significant state change
  if (t.predicted_state && t.predicted_state !== "unknown") {
    handleLiveEventStream(t);
  }
}

let lastLoggedState = null;
function handleLiveEventStream(t) {
  if (t.predicted_state === lastLoggedState) return;
  lastLoggedState = t.predicted_state;

  const list = document.getElementById("live-event-log-list");
  const countLabel = document.getElementById("live-event-count");
  if (!list) return;

  if (liveEventsList.length === 0) {
    list.innerHTML = "";
  }

  const timeStr = new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date());

  const div = document.createElement("div");
  div.className = "trigger-item";
  div.style.marginBottom = "6px";
  div.innerHTML = `
    <div>
      <span class="trigger-tag ${t.predicted_state.includes("stable") ? "tag-stable" : "tag-periodic"}">${t.predicted_state.toUpperCase()}</span>
      <span style="font-family:monospace; margin-left:8px; font-size:0.8rem;">[${timeStr}]</span>
      <div style="font-size:0.76rem; color:var(--text-secondary); margin-top:2px;">
        Vận tốc: ${(t.speed||0).toFixed(1)} px/f | Độ nét: ${(t.sharpness||0).toFixed(1)} | Nhịp: ${(t.dominant_freq_hz||0).toFixed(2)} Hz
      </div>
    </div>
  `;

  list.prepend(div);
  liveEventsList.push(t);
  if (countLabel) countLabel.textContent = `${liveEventsList.length} Sự kiện`;
}

function drawLiveCanvasOverlay(t) {
  const feedImg = document.getElementById("live-feed-img");
  const canvas = document.getElementById("live-canvas-overlay");
  if (!feedImg || !canvas) return;

  canvas.width = feedImg.clientWidth || 480;
  canvas.height = feedImg.clientHeight || 360;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  // 1. Draw Optical Flow Tracking Inlier Points
  if (t.inliers && Array.isArray(t.inliers)) {
    ctx.fillStyle = "rgba(0, 229, 163, 0.8)";
    const scaleX = canvas.width / 640.0;
    const scaleY = canvas.height / 480.0;
    for (const pt of t.inliers) {
      if (Array.isArray(pt) && pt.length >= 2) {
        ctx.beginPath();
        ctx.arc(pt[0] * scaleX, pt[1] * scaleY, 3, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }

  // 2. Draw Motion Vector Arrow
  const arrowScale = 10.0;
  const targetX = cx + (t.dx || 0) * arrowScale;
  const targetY = cy + (t.dy || 0) * arrowScale;

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(targetX, targetY);
  ctx.strokeStyle = "#00e5a3";
  ctx.lineWidth = 3.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(targetX, targetY, 6, 0, 2 * Math.PI);
  ctx.fillStyle = "#ff4d4f";
  ctx.fill();

  // 3. Draw On-Screen Head-Up Display Tag
  ctx.font = "bold 12px monospace";
  ctx.fillStyle = "rgba(13, 17, 23, 0.85)";
  ctx.fillRect(10, 10, 180, 48);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
  ctx.strokeRect(10, 10, 180, 48);

  ctx.fillStyle = "#00e5a3";
  ctx.fillText(`MOTION: ${(t.speed||0).toFixed(2)} px/f`, 18, 28);
  ctx.fillStyle = "#58a6ff";
  ctx.fillText(`STATE : ${(t.predicted_state||"STABLE").toUpperCase()}`, 18, 46);
}

// ---------------------------------------------------------
// 8. TUNING CONTROLS & RERUN BENCHMARK ENGINE
// ---------------------------------------------------------
let prevCaseSummary = null;

function syncTuningSlidersFromCase(caseData) {
  syncPluginCase(caseData);
  return;
  if (!caseData) return;
  const titleEl = document.getElementById("tuning-case-title");
  const metaId = document.getElementById("tuning-meta-id");
  const metaFps = document.getElementById("tuning-meta-fps");
  const metaDur = document.getElementById("tuning-meta-duration");
  const metaTrig = document.getElementById("tuning-meta-triggers");
  const metaStatus = document.getElementById("tuning-meta-status");

  if (titleEl) titleEl.textContent = `⚙️ Tinh Chỉnh Case: ${caseData.title || caseData.id}`;
  if (metaId) metaId.textContent = `Case: ${caseData.id}`;
  if (metaFps) metaFps.textContent = `🎞️ ${(caseData.fps || 0).toFixed(1)} fps`;
  if (metaDur) metaDur.textContent = `⏱️ ${formatDuration(caseData.duration_sec)}`;
  if (metaTrig) metaTrig.textContent = `🎯 ${(caseData.triggers || []).length} triggers`;
  if (metaStatus) metaStatus.textContent = `Trạng thái: ${caseData.status === "ready" ? "Sẵn sàng" : caseData.status}`;

  const cfg = caseData.config_params || {};
  const selProfile = document.getElementById("tune-profile");
  const sMaxCorners = document.getElementById("tune-max-corners");
  const sWindowSec = document.getElementById("tune-window-sec");
  const sStableThresh = document.getElementById("tune-stable-thresh");
  const sMinSharpness = document.getElementById("tune-min-sharpness");
  const sMaxOcclusion = document.getElementById("tune-max-occlusion");
  const sCooldownSec = document.getElementById("tune-cooldown-sec");

  if (selProfile && cfg.profile) selProfile.value = cfg.profile;
  if (sMaxCorners && cfg.max_corners) sMaxCorners.value = cfg.max_corners;
  if (sWindowSec && cfg.window_sec) sWindowSec.value = cfg.window_sec;
  if (sStableThresh && cfg.stable_speed_threshold) sStableThresh.value = cfg.stable_speed_threshold;
  if (sMinSharpness && cfg.min_sharpness) sMinSharpness.value = cfg.min_sharpness;
  if (sMaxOcclusion && cfg.max_occlusion_ratio !== undefined) sMaxOcclusion.value = cfg.max_occlusion_ratio;
  if (sCooldownSec && cfg.cooldown_sec !== undefined) sCooldownSec.value = cfg.cooldown_sec;

  // Trigger input events to refresh all badges
  if (selProfile) selProfile.dispatchEvent(new Event("change"));
  if (sMaxCorners) sMaxCorners.dispatchEvent(new Event("input"));
  if (sWindowSec) sWindowSec.dispatchEvent(new Event("input"));
  if (sStableThresh) sStableThresh.dispatchEvent(new Event("input"));
  if (sMinSharpness) sMinSharpness.dispatchEvent(new Event("input"));
  if (sMaxOcclusion) sMaxOcclusion.dispatchEvent(new Event("input"));
  if (sCooldownSec) sCooldownSec.dispatchEvent(new Event("input"));
}

function initTuningControls() {
  const selProfile = document.getElementById("tune-profile");
  const sMaxCorners = document.getElementById("tune-max-corners");
  const sWindowSec = document.getElementById("tune-window-sec");
  const sStableThresh = document.getElementById("tune-stable-thresh");
  const sMinSharpness = document.getElementById("tune-min-sharpness");
  const sMaxOcclusion = document.getElementById("tune-max-occlusion");
  const sCooldownSec = document.getElementById("tune-cooldown-sec");

  if (selProfile) {
    selProfile.addEventListener("change", () => {
      const badge = document.getElementById("val-badge-profile");
      if (badge) {
        if (selProfile.value === "inspection_sensor") {
          badge.textContent = "Station-Body Sensor";
          badge.style.background = "var(--accent-cyan)";
          badge.style.color = "#000";
        } else {
          badge.textContent = "Research Lab Raw";
          badge.style.background = "var(--accent-yellow)";
          badge.style.color = "#000";
        }
      }
    });
  }

  // Sync Slider values with live badges
  sMaxCorners.addEventListener("input", () => {
    document.getElementById("val-badge-max-corners").textContent = `${sMaxCorners.value} điểm`;
  });
  sWindowSec.addEventListener("input", () => {
    document.getElementById("val-badge-window-sec").textContent = `${parseFloat(sWindowSec.value).toFixed(1)} giây`;
  });
  sStableThresh.addEventListener("input", () => {
    document.getElementById("val-badge-stable-thresh").textContent = `${parseFloat(sStableThresh.value).toFixed(1)} px/f`;
  });
  sMinSharpness.addEventListener("input", () => {
    document.getElementById("val-badge-min-sharpness").textContent = `${parseFloat(sMinSharpness.value).toFixed(1)}`;
  });
  if (sMaxOcclusion) {
    sMaxOcclusion.addEventListener("input", () => {
      document.getElementById("val-badge-occlusion").textContent = `${(parseFloat(sMaxOcclusion.value) * 100).toFixed(0)}%`;
    });
  }
  if (sCooldownSec) {
    sCooldownSec.addEventListener("input", () => {
      document.getElementById("val-badge-cooldown-sec").textContent = `${parseFloat(sCooldownSec.value).toFixed(1)} giây`;
    });
  }

  // Reset defaults button
  document.getElementById("btn-reset-tuning-defaults").addEventListener("click", () => {
    if (selProfile) selProfile.value = "inspection_sensor";
    sMaxCorners.value = 150;
    sWindowSec.value = 0.8;
    sStableThresh.value = 1.2;
    sMinSharpness.value = 150;
    if (sMaxOcclusion) sMaxOcclusion.value = 0.30;
    if (sCooldownSec) sCooldownSec.value = 15.0;

    if (selProfile) selProfile.dispatchEvent(new Event("change"));
    sMaxCorners.dispatchEvent(new Event("input"));
    sWindowSec.dispatchEvent(new Event("input"));
    sStableThresh.dispatchEvent(new Event("input"));
    sMinSharpness.dispatchEvent(new Event("input"));
    if (sMaxOcclusion) sMaxOcclusion.dispatchEvent(new Event("input"));
    if (sCooldownSec) sCooldownSec.dispatchEvent(new Event("input"));
    toast.info("Đã khôi phục bộ tham số về cấu hình tối ưu mặc định cho Station-Body Sensor.");
  });

  // Submit Re-run Button
  const btnRerun = document.getElementById("btn-submit-rerun");
  btnRerun.addEventListener("click", async () => {
    if (!currentCaseId) {
      toast.warning("Vui lòng chọn một Video trước khi chạy lại!");
      return;
    }

    const payload = {
      config_params: {
        profile: selProfile ? selProfile.value : "inspection_sensor",
        max_corners: parseInt(sMaxCorners.value),
        window_sec: parseFloat(sWindowSec.value),
        stable_speed_threshold: parseFloat(sStableThresh.value),
        min_sharpness: parseFloat(sMinSharpness.value),
        max_occlusion_ratio: sMaxOcclusion ? parseFloat(sMaxOcclusion.value) : 0.30,
        cooldown_sec: sCooldownSec ? parseFloat(sCooldownSec.value) : 15.0,
      },
      algorithm_version: `v1.2-sensor-${selProfile ? selProfile.value : "insp"}-w${sWindowSec.value}s`,
    };

    // Save previous baseline for diff comparison
    if (currentCaseData && currentCaseData.summary_stats) {
      prevCaseSummary = {
        summary: { ...currentCaseData.summary_stats },
        triggers: (currentCaseData.triggers || []).length,
      };
    }

    // UI state: Processing
    btnRerun.disabled = true;
    btnRerun.textContent = "⏳ Đang Chạy Thuật Toán...";
    document.getElementById("tuning-status-tag").textContent = "ĐANG TÍNH...";
    document.getElementById("tuning-status-tag").className = "trigger-tag tag-spike";
    document.getElementById("tuning-progress-box").style.display = "block";
    document.getElementById("tuning-diff-box").style.display = "none";
    document.getElementById("tuning-progress-bar").style.width = "0%";
    document.getElementById("tuning-progress-percent").textContent = "0%";

    toast.info(`Bắt đầu tính toán lại Case ${currentCaseId} trên video gốc...`);

    // Safety fallback polling in case WebSocket event is delayed
    let fallbackPollCount = 0;
    const fallbackPollInterval = setInterval(async () => {
      fallbackPollCount++;
      if (fallbackPollCount > 180) { // 270s max
        clearInterval(fallbackPollInterval);
        return;
      }
      try {
        const checkRes = await fetch(`/api/cases/${currentCaseId}`);
        const checkData = await checkRes.json();
        if (checkData.status === "ready" && btnRerun.disabled) {
          clearInterval(fallbackPollInterval);
          handleTuningFinished({
            case_id: currentCaseId,
            summary: checkData.summary_stats || {},
            total_frames: checkData.total_frames,
            triggers_count: (checkData.triggers || []).length,
          });
        }
      } catch (e) {
        // ignore poll errors
      }
    }, 1500);

    try {
      const res = await fetch(`/api/cases/${currentCaseId}/rerun`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Server rejected rerun request");
    } catch (err) {
      clearInterval(fallbackPollInterval);
      toast.error(`Lỗi khi yêu cầu tính lại: ${err.message}`);
      btnRerun.disabled = false;
      btnRerun.textContent = "🔄 Bắt Đầu Tính Lại Case Với Bộ Tham Số Mới";
    }
  });

  // Jump to Studio button from diff box
  document.getElementById("btn-view-tuned-studio").addEventListener("click", () => {
    switchSubTab("page-cases", "case-studio");
    openCaseStudio(currentCaseId, true, true);
  });
}

function updateTuningProgress(data) {
  document.getElementById("tuning-progress-bar").style.width = `${data.percent}%`;
  document.getElementById("tuning-progress-percent").textContent = `${data.percent}%`;
  document.getElementById("tuning-progress-frames").textContent = `Frame: ${data.current_frame} / ${data.total_frames}`;
  document.getElementById("tuning-progress-fps").textContent = `Tốc độ: ${data.current_fps} FPS`;
  document.getElementById("tuning-progress-elapsed").textContent = `Thời gian: ${data.elapsed_sec}s`;
}

function handleTuningFinished(data) {
  const btnRerun = document.getElementById("btn-submit-rerun");
  if (!btnRerun) return;
  btnRerun.disabled = false;
  btnRerun.textContent = "🔄 Bắt Đầu Tính Lại Case Với Bộ Tham Số Mới";

  document.getElementById("tuning-status-tag").textContent = "HOÀN TẤT";
  document.getElementById("tuning-status-tag").className = "trigger-tag tag-stable";
  document.getElementById("tuning-progress-bar").style.width = "100%";
  document.getElementById("tuning-progress-percent").textContent = "100%";

  toast.success(`Đã tính toán xong Case ${currentCaseId} với tốc độ ${(data.summary.processing_fps || 0).toFixed(1)} FPS!`);

  // Refresh case table in background
  loadCases();

  // Build Diff Table
  const tbody = document.getElementById("tuning-diff-tbody");
  tbody.innerHTML = "";

  const prevFps = prevCaseSummary ? (prevCaseSummary.summary.processing_fps || "--") : "--";
  const newFps = data.summary.processing_fps || "--";

  const prevTrigs = prevCaseSummary ? prevCaseSummary.triggers : "--";
  const newTrigs = data.triggers_count !== undefined ? data.triggers_count : (data.summary.total_triggers || 0);

  const prevSpeed = prevCaseSummary ? (prevCaseSummary.summary.avg_speed || "--") : "--";
  const newSpeed = (data.summary.avg_speed || 0).toFixed(2);

  const prevSharp = prevCaseSummary ? (prevCaseSummary.summary.avg_sharpness || "--") : "--";
  const newSharp = (data.summary.avg_sharpness || 0).toFixed(1);

  tbody.innerHTML = `
    <tr>
      <td><b>Tốc độ xử lý (Processing Speed)</b></td>
      <td>${prevFps} FPS</td>
      <td class="diff-highlight">${newFps} FPS ⚡</td>
    </tr>
    <tr>
      <td><b>Số Trigger phát hiện (Total Triggers)</b></td>
      <td>${prevTrigs} sự kiện</td>
      <td class="diff-highlight">${newTrigs} sự kiện 🎯</td>
    </tr>
    <tr>
      <td><b>Vận tốc trôi trung bình (Avg Speed)</b></td>
      <td>${prevSpeed} px/f</td>
      <td>${newSpeed} px/f</td>
    </tr>
    <tr>
      <td><b>Độ nét trung bình (Avg Sharpness)</b></td>
      <td>${prevSharp}</td>
      <td class="diff-highlight">${newSharp}</td>
    </tr>
  `;

  document.getElementById("tuning-diff-box").style.display = "block";
}
let livePollingInterval = null;
let liveActiveCaseId = null;

async function loadDevices() {
  const res = await fetch("/api/devices");
  const devices = await res.json();
  const tbody = document.getElementById("device-table-body");
  const selectDev = document.getElementById("live-select-device");

  tbody.innerHTML = "";
  selectDev.innerHTML = "";

  if (devices.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted)">Chưa có thiết bị nào. Bấm '+ Thêm Camera Mới' để cấu hình.</td></tr>`;
    return;
  }

  devices.forEach((d) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><code>${d.id}</code></td>
      <td><b>${d.name}</b></td>
      <td>${d.location || "N/A"}</td>
      <td>${d.assigned_worker || "N/A"}</td>
      <td><span style="font-size:0.75rem; color:var(--text-muted);">${d.rtsp_sub_url || "Chưa có"}</span></td>
      <td><span class="trigger-tag tag-stable">${d.status}</span></td>
      <td>
        <button class="btn btn-primary btn-select-live" data-id="${d.id}" style="padding:4px 8px;">🚀 Giám Sát</button>
        <button class="btn btn-danger btn-del-dev" data-id="${d.id}" style="padding:4px 8px;">✕</button>
      </td>
    `;
    tbody.appendChild(tr);

    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = `${d.name} (${d.location || "No location"})`;
    selectDev.appendChild(opt);
  });

  document.querySelectorAll(".btn-select-live").forEach((btn) => {
    btn.addEventListener("click", () => {
      const devId = btn.getAttribute("data-id");
      if (selectDev) {
        selectDev.value = devId;
        selectDev.dispatchEvent(new Event("change"));
      }
      navigateTo(`#/live/${devId}`);
    });
  });

  document.querySelectorAll(".btn-del-dev").forEach((b) => {
    b.addEventListener("click", async () => {
      await fetch(`/api/devices/${b.getAttribute("data-id")}`, { method: "DELETE" });
      loadDevices();
    });
  });

  // Attach Change event to device selector
  selectDev.addEventListener("change", () => {
    const devId = selectDev.value;
    const feedImg = document.getElementById("live-feed-img");
    if (devId) {
      feedImg.src = `/api/live/${devId}/feed`;
      document.getElementById("live-camera-title").textContent = `📹 Trực Tiếp: ${selectDev.options[selectDev.selectedIndex].text}`;
      document.getElementById("live-monitor-status").textContent = `• Đã kết nối luồng RTSP từ thiết bị: ${devId}`;
    }
  });

  // Trigger initial selection
  if (devices.length > 0) {
    selectDev.dispatchEvent(new Event("change"));
  }

  // Live recording buttons
  const btnStartLive = document.getElementById("btn-start-live");
  const btnStopLive = document.getElementById("btn-stop-live");
  const liveTimer = document.getElementById("live-recording-timer");

  btnStartLive.addEventListener("click", async () => {
    const devId = selectDev.value;
    const title = document.getElementById("live-session-title").value || `Session ${devId}`;
    const selectedDev = devices.find(d => d.id === devId);
    if (!selectedDev || !selectedDev.rtsp_sub_url) {
      alert("Thiết bị chưa có RTSP URL!");
      return;
    }

    try {
      const res = await fetch("/api/live/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: devId,
          rtsp_url: selectedDev.rtsp_sub_url,
          title: title
        })
      });
      const data = await res.json();
      liveActiveCaseId = data.case_id;

      btnStartLive.style.display = "none";
      btnStopLive.style.display = "inline-flex";
      liveTimer.style.display = "inline-block";

      startLivePolling(liveActiveCaseId);
    } catch (err) {
      alert("Lỗi start live: " + err.message);
    }
  });

  btnStopLive.addEventListener("click", async () => {
    if (!liveActiveCaseId) return;
    try {
      btnStopLive.textContent = "Đang đóng gói...";
      const res = await fetch("/api/live/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_id: liveActiveCaseId })
      });
      const data = await res.json();
      
      stopLivePolling();
      btnStartLive.style.display = "inline-flex";
      btnStopLive.style.display = "none";
      btnStopLive.textContent = "⏹ Dừng & Đóng Gói Thành Case";
      liveTimer.style.display = "none";

      alert(`Đã lưu thành công Case: ${data.case_id}! Chuyển sang Studio để xem lại.`);
      await loadCases();
      openCaseStudio(data.case_id);
    } catch (err) {
      alert("Lỗi stop live: " + err.message);
    }
  });
}

function startLivePolling(caseId) {
  let secCount = 0;
  livePollingInterval = setInterval(async () => {
    secCount++;
    const m = Math.floor(secCount / 60);
    const s = secCount % 60;
    document.getElementById("live-recording-timer").textContent = `🔴 RECORDING: ${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

    try {
      const res = await fetch(`/api/live/${caseId}/state`);
      const data = await res.json();
      if (data && data.telemetry) {
        const t = data.telemetry;
        document.getElementById("live-val-speed").textContent = `${(t.speed || 0).toFixed(2)} px/f`;
        document.getElementById("live-val-sharpness").textContent = `${(t.sharpness || 0).toFixed(1)}`;
        document.getElementById("live-val-state").textContent = (t.predicted_state || "--").toUpperCase();
        document.getElementById("live-monitor-status").textContent = `• Frame: #${t.frame_idx} | Tốc độ: ${(t.speed||0).toFixed(1)}px | Trạng thái: ${t.predicted_state}`;
      }
    } catch (e) {}
  }, 1000);
}

function stopLivePolling() {
  if (livePollingInterval) {
    clearInterval(livePollingInterval);
    livePollingInterval = null;
  }
}

// ---------------------------------------------------------
// 9. VLM EVALUATION & BENCHMARK WORKBENCH
// ---------------------------------------------------------
function initVLMEvalWorkbench() {
  const selectCase = document.getElementById("vlm-select-case");
  const selectModel = document.getElementById("vlm-select-model");
  const selectPrompt = document.getElementById("vlm-select-prompt");
  const btnRun = document.getElementById("btn-run-vlm-eval");
  const btnApplyParams = document.getElementById("btn-apply-vlm-params");

  if (!btnRun) return;

  if (selectCase) {
    // Populate options if empty
    if (selectCase.options.length <= 1) {
      fetch("/api/cases")
        .then((r) => r.json())
        .then((cases) => {
          selectCase.innerHTML = `<option value="" disabled selected>-- Chọn Case Phân Tích --</option>`;
          cases.forEach((c) => {
            const opt = document.createElement("option");
            opt.value = c.id;
            opt.textContent = `${c.title} (${c.id} - ${c.trigger_count || 0} triggers)`;
            selectCase.appendChild(opt);
          });
          if (currentCaseId) {
            selectCase.value = currentCaseId;
            selectCase.dispatchEvent(new Event("change"));
          }
        })
        .catch(() => {});
    }

    selectCase.addEventListener("change", () => {
      const caseId = selectCase.value;
      const badge = document.getElementById("vlm-selected-case-badge");
      if (badge) badge.textContent = `Case: ${caseId || "Chưa chọn"}`;
      if (caseId) loadVLMEvalHistory(caseId);
    });
  }

  btnRun.addEventListener("click", async () => {
    const caseId = selectCase.value;
    if (!caseId) {
      toast.warning("Vui lòng chọn 1 Case để đánh giá với VLM!");
      return;
    }

    const payload = {
      case_id: caseId,
      model_name: selectModel.value,
      prompt_template: selectPrompt.value,
    };

    btnRun.disabled = true;
    btnRun.textContent = "⏳ VLM Đang Thẩm Định...";
    toast.info(`Bắt đầu chạy thẩm định VLM (${selectModel.value}) trên Case ${caseId}...`);

    try {
      const res = await fetch("/api/vlm/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("VLM Evaluation failed");
      const data = await res.json();
      toast.success(`Thẩm định VLM hoàn tất! Tiết kiệm ${data.reduction_rate}% token.`);
      await loadVLMEvalHistory(caseId);
    } catch (err) {
      toast.error("Lỗi khi chạy VLM: " + err.message);
    } finally {
      btnRun.disabled = false;
      btnRun.textContent = "🚀 Bắt Đầu Đánh Giá Với VLM";
    }
  });

  if (btnApplyParams) {
    btnApplyParams.addEventListener("click", () => {
      if (!currentVLMEvalRun || !currentVLMEvalRun.recommended_params) {
        toast.warning("Chưa có bộ tham số tối ưu nào từ VLM. Hãy bấm 'Bắt Đầu Đánh Giá Với VLM' trước!");
        return;
      }
      const p = currentVLMEvalRun.recommended_params;
      pluginRecommendedParams = p;
      
      // Fill values to Tuning page
      const selProfile = document.getElementById("tune-profile");
      const sMaxCorners = document.getElementById("tune-max-corners");
      const sWindowSec = document.getElementById("tune-window-sec");
      const sStableThresh = document.getElementById("tune-stable-thresh");
      const sMinSharpness = document.getElementById("tune-min-sharpness");
      const sCooldownSec = document.getElementById("tune-cooldown-sec");

      if (selProfile) { selProfile.value = "inspection_sensor"; selProfile.dispatchEvent(new Event("change")); }
      if (sMaxCorners && p.max_corners) { sMaxCorners.value = p.max_corners; sMaxCorners.dispatchEvent(new Event("input")); }
      if (sWindowSec && p.window_sec) { sWindowSec.value = p.window_sec; sWindowSec.dispatchEvent(new Event("input")); }
      if (sStableThresh && p.stable_speed_threshold) { sStableThresh.value = p.stable_speed_threshold; sStableThresh.dispatchEvent(new Event("input")); }
      if (sMinSharpness && p.min_sharpness) { sMinSharpness.value = p.min_sharpness; sMinSharpness.dispatchEvent(new Event("input")); }
      if (sCooldownSec && p.cooldown_sec) { sCooldownSec.value = p.cooldown_sec; sCooldownSec.dispatchEvent(new Event("input")); }

      toast.success("Đã nạp bộ tham số tối ưu vào trang Tuning & Re-run!");
      navigateTo(`#/cases/${selectCase.value}/tuning`);
    });
  }

  // Export Sensor Spec & Config JSON Button
  const btnExportSpec = document.getElementById("btn-export-sensor-spec");
  if (btnExportSpec) {
    btnExportSpec.addEventListener("click", async () => {
      if (!currentCaseId) {
        toast.warning("Vui lòng chọn một Video trước khi xuất đặc tả Sensor!");
        return;
      }
      try {
        toast.info(`Đang tải gói đặc tả Sensor JSON cho ${currentCaseId}...`);
        const res = await fetch(`/api/cases/${currentCaseId}/export-spec`);
        if (!res.ok) throw new Error("Không thể xuất đặc tả Sensor");
        const specData = await res.json();
        
        // Trigger download of JSON
        const blob = new Blob([JSON.stringify(specData, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `CBD_Sensor_Spec_${currentCaseId}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast.success(`Đã xuất thành công gói đặc tả Sensor JSON cho ${currentCaseId}!`);
      } catch (err) {
        toast.error("Lỗi xuất JSON: " + err.message);
      }
    });
  }
}

async function loadVLMEvalHistory(caseId) {
  const tbody = document.getElementById("vlm-audit-tbody");
  const countBadge = document.getElementById("vlm-audit-count");
  const insightBox = document.getElementById("vlm-insight-box");
  const insightText = document.getElementById("vlm-insight-text");
  const paramsPreview = document.getElementById("vlm-params-preview");
  const evalTime = document.getElementById("vlm-eval-time");

  tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;">Đang tải lịch sử thẩm định VLM...</td></tr>`;

  try {
    const res = await fetch(`/api/vlm/evaluations/${caseId}`);
    const runs = await res.json();

    if (!runs || runs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">Case này chưa được đánh giá qua VLM. Hãy bấm nút '🚀 Bắt Đầu Đánh Giá Với VLM' ở trên.</td></tr>`;
      document.getElementById("vlm-kpi-total").textContent = "--";
      document.getElementById("vlm-kpi-useful").textContent = "--";
      document.getElementById("vlm-kpi-redundant").textContent = "--";
      document.getElementById("vlm-kpi-savings").textContent = "--%";
      if (insightBox) insightBox.style.display = "none";
      if (countBadge) countBadge.textContent = "0 Bản ghi";
      return;
    }

    const latestRun = runs[0];
    currentVLMEvalRun = latestRun;

    // Update KPI Badges
    document.getElementById("vlm-kpi-total").textContent = latestRun.total_triggers;
    document.getElementById("vlm-kpi-useful").textContent = latestRun.true_positive;
    document.getElementById("vlm-kpi-redundant").textContent = latestRun.redundant + latestRun.blurred;
    document.getElementById("vlm-kpi-savings").textContent = `${latestRun.reduction_rate}%`;

    // Update Insight Box
    if (insightBox) insightBox.style.display = "block";
    if (insightText) insightText.textContent = latestRun.summary_insight;
    if (evalTime) evalTime.textContent = `Thẩm định lúc: ${formatDateTime(latestRun.created_at)}`;
    if (paramsPreview && latestRun.recommended_params) {
      const p = latestRun.recommended_params;
      paramsPreview.textContent = `🎯 Khuyến nghị Classical CV: min_sharpness=${p.min_sharpness} | cooldown_sec=${p.cooldown_sec}s | window_sec=${p.window_sec}s -> (${p.reduction_target})`;
    }

    // Render Audit Table
    tbody.innerHTML = "";
    const feedbacks = latestRun.feedbacks || [];
    if (countBadge) countBadge.textContent = `${feedbacks.length} Bản ghi`;

    // Fetch case triggers to link images
    const caseRes = await fetch(`/api/cases/${caseId}`);
    const caseData = await caseRes.json();
    const trigMap = {};
    (caseData.triggers || []).forEach(t => { trigMap[t.id] = t; });

    feedbacks.forEach((fb, i) => {
      const origTrig = trigMap[fb.trigger_id] || {};
      const timeSec = (origTrig.timestamp_ms ? (origTrig.timestamp_ms / 1000.0).toFixed(1) : "--");
      const sharp = origTrig.sharpness_score ? origTrig.sharpness_score.toFixed(1) : "--";
      const trType = origTrig.trigger_type || "TRIGGER";
      const evUrl = origTrig.evidence_minio_url || "";

      let verdictBadge = "";
      if (fb.verdict === "useful_keyframe") {
        verdictBadge = `<span class="trigger-tag tag-stable">✅ HỢP LỆ (VLM OK)</span>`;
      } else if (fb.verdict === "redundant_motion") {
        verdictBadge = `<span class="trigger-tag tag-periodic">⚠️ TRÙNG LẶP (SPAM)</span>`;
      } else {
        verdictBadge = `<span class="trigger-tag tag-spike">❌ MỜ NHÒE (BLUR)</span>`;
      }

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td style="font-family:monospace; font-weight:700;">${timeSec}s</td>
        <td>
          ${evUrl ? `<img src="${evUrl}" style="width:70px; height:42px; object-fit:cover; border-radius:4px; border:1px solid var(--border-color); cursor:pointer;" class="vlm-thumb-preview" data-url="${evUrl}" data-desc="${fb.scene_description}">` : `<span style="font-size:0.75rem; color:var(--text-muted);">Không ảnh</span>`}
        </td>
        <td>
          <span class="trigger-tag ${trType.includes("STABLE") ? "tag-stable" : "tag-spike"}">${trType}</span>
          <div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${origTrig.reason || ""}</div>
        </td>
        <td style="font-family:monospace; font-weight:600; color:var(--accent-cyan);">${sharp}</td>
        <td>
          <div style="font-size:0.84rem; font-weight:600; color:var(--text-primary);">${fb.worker_action.toUpperCase()}</div>
          <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:2px;">${fb.scene_description}</div>
        </td>
        <td>${verdictBadge}</td>
        <td>
          <button class="btn btn-show-vlm-evidence" data-url="${evUrl}" data-desc="${fb.scene_description}" style="padding:3px 8px; font-size:0.75rem;">👁️ Xem</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    document.querySelectorAll(".vlm-thumb-preview, .btn-show-vlm-evidence").forEach((el) => {
      el.addEventListener("click", () => {
        const url = el.getAttribute("data-url");
        const desc = el.getAttribute("data-desc");
        if (url) {
          document.getElementById("evidence-img").src = url;
          document.getElementById("evidence-reason").textContent = desc;
          openModal("evidence-modal");
        }
      });
    });

  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--accent-red);">Lỗi: ${err.message}</td></tr>`;
  }
}
