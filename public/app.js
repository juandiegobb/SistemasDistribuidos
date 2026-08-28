/**
 * NexusCluster - Client Dashboard Application
 * Handles live polling, server cluster monitoring, topology canvas animation,
 * interactive message feeds, filters, sound synthesis, and simulation modals.
 */

// Application State
const state = {
  servers: [],
  messages: [],
  activeFilterServer: "all",
  activeMsgType: "all",
  searchQuery: "",
  serverSearchQuery: "",
  soundEnabled: true,
  lastKnownMessageIds: new Set(),
  simulatedIntervals: {},
  showTopology: true,
  topologyPackets: [],
};

// DOM Elements
const DOM = {
  liveClock: document.getElementById("live-clock"),
  valActiveServers: document.getElementById("val-active-servers"),
  valTotalServers: document.getElementById("val-total-servers"),
  tagActiveRate: document.getElementById("tag-active-rate"),
  serversStatusSummary: document.getElementById("servers-status-summary"),
  valTotalMessages: document.getElementById("val-total-messages"),
  lastMessageTime: document.getElementById("last-message-time"),
  valUptime: document.getElementById("val-uptime"),
  
  // Servers
  serversContainer: document.getElementById("servers-container"),
  serversEmpty: document.getElementById("servers-empty"),
  filterServers: document.getElementById("filter-servers"),
  btnRefreshServers: document.getElementById("btn-refresh-servers"),
  
  // Messages
  messagesList: document.getElementById("messages-list"),
  messagesEmpty: document.getElementById("messages-empty"),
  selectMsgFilter: document.getElementById("select-msg-filter"),
  btnClearMessages: document.getElementById("btn-clear-messages"),
  filterMsgText: document.getElementById("filter-msg-text"),
  countAllMsgs: document.getElementById("count-all-msgs"),
  countNodeMsgs: document.getElementById("count-node-msgs"),
  msgCategoryChips: document.querySelectorAll(".msg-category-chips .chip"),
  
  // Composer
  formSendMessage: document.getElementById("form-send-message"),
  msgSenderName: document.getElementById("msg-sender-name"),
  msgTargetNode: document.getElementById("msg-target-node"),
  msgContentInput: document.getElementById("msg-content-input"),
  
  // Topology
  topologySection: document.getElementById("topology-section"),
  toggleTopology: document.getElementById("toggle-topology"),
  topologyCanvas: document.getElementById("topology-canvas"),
  
  // Modals & Controls
  modalGuide: document.getElementById("modal-guide"),
  btnGuide: document.getElementById("btn-guide"),
  modalSimulate: document.getElementById("modal-simulate"),
  btnSimulate: document.getElementById("btn-simulate"),
  btnEmptySimulate: document.getElementById("btn-empty-simulate"),
  formSimulateNode: document.getElementById("form-simulate-node"),
  simNodeName: document.getElementById("sim-node-name"),
  simNodeUrl: document.getElementById("sim-node-url"),
  simAutoHeartbeat: document.getElementById("sim-auto-heartbeat"),
  
  modalSimMessage: document.getElementById("modal-sim-message"),
  btnSimMessage: document.getElementById("btn-sim-message"),
  btnQuickSimMsg: document.getElementById("btn-quick-sim-msg"),
  formModalSimMsg: document.getElementById("form-modal-sim-msg"),
  simMsgSender: document.getElementById("sim-msg-sender"),
  simMsgRoute: document.getElementById("sim-msg-route"),
  simMsgText: document.getElementById("sim-msg-text"),
  
  btnSoundToggle: document.getElementById("btn-sound-toggle"),
  toastContainer: document.getElementById("toast-container"),
};

// ==========================================================================
// AUDIO SYNTHESIZER (Web Audio API)
// ==========================================================================
class SoundFX {
  static ctx = null;

  static init() {
    if (!this.ctx && (window.AudioContext || window.webkitAudioContext)) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
  }

  static playTone(freq = 600, type = "sine", duration = 0.1, gainVal = 0.05) {
    if (!state.soundEnabled) return;
    try {
      this.init();
      if (!this.ctx) return;
      if (this.ctx.state === "suspended") this.ctx.resume();

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      gain.gain.setValueAtTime(gainVal, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + duration);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch (e) {}
  }

  static playSuccess() {
    this.playTone(523.25, "triangle", 0.08);
    setTimeout(() => this.playTone(659.25, "triangle", 0.12), 80);
  }

  static playMessage() {
    this.playTone(440, "sine", 0.07);
    setTimeout(() => this.playTone(880, "sine", 0.12), 70);
  }

  static playAlert() {
    this.playTone(330, "sawtooth", 0.18, 0.06);
    setTimeout(() => this.playTone(220, "sawtooth", 0.22, 0.06), 120);
  }
}

// ==========================================================================
// TOAST NOTIFICATIONS
// ==========================================================================
function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  
  let iconSvg = "";
  if (type === "success") {
    iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#34d399" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
  } else if (type === "error" || type === "warning") {
    iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fb7185" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
  } else {
    iconSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#38bdf8" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12.01" y2="16"></line><path d="M12 8v4"></path></svg>`;
  }

  toast.innerHTML = `${iconSvg} <span>${escapeHtml(message)}</span>`;
  DOM.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(40px)";
    toast.style.transition = "all 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ==========================================================================
// UTILITY FUNCTIONS
// ==========================================================================
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatRelativeTime(timestampMs) {
  if (!timestampMs) return "nunca";
  const seconds = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (seconds < 2) return "ahora mismo";
  if (seconds < 60) return `hace ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes}m`;
  return `hace ${Math.floor(minutes / 60)}h`;
}

function formatUptime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ==========================================================================
// DATA FETCHING & SYNC
// ==========================================================================
async function fetchClusterStats() {
  try {
    const res = await fetch("/api/stats");
    if (!res.ok) throw new Error("Error obteniendo estadísticas");
    const data = await res.json();

    const previousServerNames = new Set(state.servers.map((s) => s.name));
    state.servers = data.serverList || [];
    
    // Check if new server registered
    state.servers.forEach((s) => {
      if (!previousServerNames.has(s.name) && previousServerNames.size > 0) {
        showToast(`Nuevo servidor conectado: ${s.name}`, "success");
        SoundFX.playSuccess();
        triggerTopologyPacket(s.name, "hub");
      }
    });

    // Update Metrics in Navbar & Cards
    DOM.valActiveServers.textContent = data.activeServers;
    DOM.valTotalServers.textContent = data.totalServers;
    DOM.valUptime.textContent = formatUptime(data.uptimeSeconds);

    const rate = data.totalServers > 0 
      ? Math.round((data.activeServers / data.totalServers) * 100) 
      : 100;
    DOM.tagActiveRate.textContent = `${rate}% Salud`;

    if (data.totalServers === 0) {
      DOM.serversStatusSummary.textContent = "Esperando conexiones de servidores...";
    } else {
      DOM.serversStatusSummary.textContent = `${data.activeServers} activo(s), ${data.inactiveServers} inactivo(s)`;
    }

    renderServers();
    updateServerSelectOptions();
  } catch (err) {
    console.error("Fetch stats error:", err);
  }
}

async function fetchMessages() {
  try {
    let url = "/api/messages";
    const params = new URLSearchParams();
    
    if (state.activeFilterServer !== "all") {
      params.append("server", state.activeFilterServer);
    }
    
    if (state.searchQuery) {
      params.append("search", state.searchQuery);
    }

    if ([...params.entries()].length > 0) {
      url += `?${params.toString()}`;
    }

    const res = await fetch(url);
    if (!res.ok) throw new Error("Error obteniendo mensajes");
    const data = await res.json();

    const previousCount = state.messages.length;
    const newMessages = data.messages || [];
    state.messages = newMessages;
    DOM.valTotalMessages.textContent = data.total;

    // Detect new messages and trigger audio / topology animation
    let hasNewIncoming = false;
    newMessages.forEach((msg) => {
      if (!state.lastKnownMessageIds.has(msg.id)) {
        state.lastKnownMessageIds.add(msg.id);
        hasNewIncoming = true;
        
        // Trigger packet animation on topology canvas
        if (msg.sender && msg.sender !== "Middleware") {
          triggerTopologyPacket(msg.sender, "hub");
        } else if (msg.target && msg.target !== "Middleware") {
          triggerTopologyPacket("hub", msg.target);
        }
      }
    });

    if (hasNewIncoming && previousCount > 0) {
      SoundFX.playMessage();
    }

    if (state.messages.length > 0) {
      DOM.lastMessageTime.textContent = `Último: ${formatRelativeTime(state.messages[0].timeMs)}`;
    } else {
      DOM.lastMessageTime.textContent = "Sin mensajes aún";
    }

    updateMessageCounts();
    renderMessages();
  } catch (err) {
    console.error("Fetch messages error:", err);
  }
}

function updateMessageCounts() {
  const allCount = state.messages.length;
  const nodeCount = state.messages.filter((m) => m.sender !== "Sistema" && m.sender !== "Middleware" && m.sender !== "Admin-Dashboard").length;

  DOM.countAllMsgs.textContent = allCount;
  DOM.countNodeMsgs.textContent = nodeCount;
}

// ==========================================================================
// RENDER SERVERS LIST
// ==========================================================================
function renderServers() {
  const searchTerm = (DOM.filterServers.value || "").toLowerCase().trim();
  const filtered = state.servers.filter(
    (s) => s.name.toLowerCase().includes(searchTerm) || s.url.toLowerCase().includes(searchTerm)
  );

  if (filtered.length === 0) {
    DOM.serversContainer.innerHTML = "";
    DOM.serversEmpty.classList.remove("hidden");
    return;
  }

  DOM.serversEmpty.classList.add("hidden");

  DOM.serversContainer.innerHTML = filtered
    .map((server) => {
      const elapsed = server.elapsedSeconds || 0;
      const isOnline = elapsed <= 15;
      const isWarning = elapsed > 7 && elapsed <= 15;
      const isOffline = elapsed > 15;

      let statusClass = "online";
      let statusText = "Activo (Online)";
      let cardBorderClass = "";

      if (isOffline) {
        statusClass = "offline";
        statusText = "Desconectado (>15s)";
        cardBorderClass = "danger";
      } else if (isWarning) {
        statusClass = "warning";
        statusText = "En espera de pulso";
        cardBorderClass = "warning";
      }

      // Heartbeat countdown bar (15 seconds maximum)
      const percent = Math.max(0, Math.min(100, 100 - (elapsed / 15) * 100));
      const barClass = isOffline ? "danger" : isWarning ? "warning" : "";

      const initials = server.name.substring(0, 2).toUpperCase();

      return `
        <div class="server-card ${cardBorderClass}" data-server-name="${escapeHtml(server.name)}">
          <div class="server-card-top">
            <div class="server-identity">
              <div class="server-avatar">${initials}</div>
              <div>
                <div class="server-name" title="${escapeHtml(server.name)}">${escapeHtml(server.name)}</div>
                <div class="server-endpoint" title="${escapeHtml(server.url)}">${escapeHtml(server.url)}</div>
              </div>
            </div>
            <span class="node-status-badge ${statusClass}">
              <span class="pulse-dot ${statusClass}"></span>
              ${statusText}
            </span>
          </div>

          <div class="server-heartbeat-box">
            <div class="heartbeat-info-row">
              <span class="heartbeat-info-label">Último Heartbeat:</span>
              <span class="heartbeat-info-val">${formatRelativeTime(server.lastHeartbeat)}</span>
            </div>
            <div class="heartbeat-bar-track" title="Tiempo restante antes de timeout (15s)">
              <div class="heartbeat-bar-fill ${barClass}" style="width: ${percent}%;"></div>
            </div>
            <div class="heartbeat-info-row" style="margin-top: 2px;">
              <span class="heartbeat-info-label">Pulsos recibidos:</span>
              <span class="heartbeat-info-val"><strong>${server.heartbeatCount || 1}</strong> pulsos</span>
            </div>
          </div>

          <div class="server-card-actions">
            <button class="btn btn-secondary btn-sm btn-action-pulse" data-name="${escapeHtml(server.name)}" title="Enviar pulso de prueba al Middleware">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path>
              </svg>
              <span>Pulso</span>
            </button>
            <button class="btn btn-primary btn-sm btn-action-msg" data-name="${escapeHtml(server.name)}" title="Escribir mensaje a este nodo">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
              <span>Mensaje</span>
            </button>
            <button class="btn btn-secondary btn-sm btn-action-filter" data-name="${escapeHtml(server.name)}" title="Filtrar mensajes de este servidor">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
              <span>Ver</span>
            </button>
            <button class="icon-button danger btn-action-kill" data-name="${escapeHtml(server.name)}" title="Detener / Desconectar Servidor">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        </div>
      `;
    })
    .join("");
}

// ==========================================================================
// RENDER MESSAGES FEED
// ==========================================================================
function renderMessages() {
  let list = [...state.messages];

  // Filter by category chip
  if (state.activeMsgType === "received") {
    list = list.filter((m) => m.type === "received" || (m.sender !== "Middleware" && m.sender !== "Sistema" && m.sender !== "Admin-Dashboard"));
  } else if (state.activeMsgType === "outgoing") {
    list = list.filter((m) => m.type === "outgoing" || m.type === "node_message" || m.target && m.target !== "Middleware");
  } else if (state.activeMsgType === "system") {
    list = list.filter((m) => m.type === "system_event" || m.type === "system_alert");
  }

  // Filter by search text in feed
  const textQuery = (DOM.filterMsgText.value || "").toLowerCase().trim();
  if (textQuery) {
    list = list.filter(
      (m) => m.message.toLowerCase().includes(textQuery) || m.sender.toLowerCase().includes(textQuery) || (m.target && m.target.toLowerCase().includes(textQuery))
    );
  }

  if (list.length === 0) {
    DOM.messagesList.innerHTML = "";
    DOM.messagesEmpty.classList.remove("hidden");
    return;
  }

  DOM.messagesEmpty.classList.add("hidden");

  DOM.messagesList.innerHTML = list
    .map((msg) => {
      let typeClass = "received";
      let senderTag = "Nodo";

      if (msg.type === "system_event") {
        typeClass = "system-event";
        senderTag = "Evento";
      } else if (msg.type === "system_alert") {
        typeClass = "system-alert";
        senderTag = "Alerta";
      } else if (msg.type === "outgoing" || msg.type === "node_message") {
        typeClass = "outgoing";
        senderTag = "Directo";
      } else if (msg.type === "broadcast") {
        typeClass = "broadcast";
        senderTag = "Difusión";
      }

      const initials = (msg.sender || "ND").substring(0, 2).toUpperCase();
      const targetLabel = msg.target ? `<span class="message-target-tag">${escapeHtml(msg.target)}</span>` : "";

      return `
        <div class="message-item ${typeClass}" data-id="${msg.id}">
          <div class="message-avatar">${initials}</div>
          <div class="message-content-wrap">
            <div class="message-header-line">
              <div class="message-sender-box">
                <span class="message-sender">${escapeHtml(msg.sender)}</span>
                ${msg.target ? `<span class="message-direction-arrow">➔</span> ${targetLabel}` : ""}
              </div>
              <div class="message-meta-right">
                <span class="message-rel-time">${formatRelativeTime(msg.timeMs)}</span>
                <span class="message-time">${formatTime(msg.timestamp)}</span>
              </div>
            </div>
            <div class="message-text">${escapeHtml(msg.message)}</div>
            <div class="message-bubble-actions">
              <button class="btn-msg-action btn-copy-msg" data-text="${escapeHtml(msg.message)}">Copiar</button>
              ${msg.sender !== "Middleware" && msg.sender !== "Sistema" ? `<button class="btn-msg-action btn-reply-msg" data-sender="${escapeHtml(msg.sender)}">Responder</button>` : ""}
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

function updateServerSelectOptions() {
  const currentVal = DOM.selectMsgFilter.value;
  const currentTarget = DOM.msgTargetNode.value;

  // Options for filter dropdown
  let filterHtml = `<option value="all">Todos los Remitentes</option>`;
  state.servers.forEach((s) => {
    filterHtml += `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`;
  });
  DOM.selectMsgFilter.innerHTML = filterHtml;
  if (currentVal && Array.from(DOM.selectMsgFilter.options).some((o) => o.value === currentVal)) {
    DOM.selectMsgFilter.value = currentVal;
  }

  // Options for target dropdown in composer
  let targetHtml = `<option value="Middleware">Middleware (General /messages)</option>`;
  state.servers.forEach((s) => {
    targetHtml += `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)} (/send-message)</option>`;
  });
  DOM.msgTargetNode.innerHTML = targetHtml;
  if (currentTarget && Array.from(DOM.msgTargetNode.options).some((o) => o.value === currentTarget)) {
    DOM.msgTargetNode.value = currentTarget;
  }
}

// ==========================================================================
// TOPOLOGY CANVAS VISUALIZER
// ==========================================================================
let canvasAnimId = null;

function initTopology() {
  const canvas = DOM.topologyCanvas;
  if (!canvas) return;

  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
  }

  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  function renderTopology() {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    const hubX = w / 2;
    const hubY = h / 2;

    const activeNodes = state.servers;
    const count = activeNodes.length;

    // Draw center Middleware Hub
    ctx.save();
    // Glowing ring
    ctx.beginPath();
    ctx.arc(hubX, hubY, 32, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(56, 189, 248, 0.12)";
    ctx.fill();
    ctx.strokeStyle = "rgba(56, 189, 248, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Inner circle
    ctx.beginPath();
    ctx.arc(hubX, hubY, 22, 0, Math.PI * 2);
    ctx.fillStyle = "#0284c7";
    ctx.fill();

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 10px Plus Jakarta Sans, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("HUB :3000", hubX, hubY);
    ctx.restore();

    // Node Positions
    const radius = Math.min(w * 0.38, 220);
    const nodeCoords = {};

    if (count === 0) {
      ctx.fillStyle = "rgba(148, 163, 184, 0.5)";
      ctx.font = "12px Plus Jakarta Sans, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Esperando que se conecten servidores...", hubX, hubY + 60);
    } else {
      activeNodes.forEach((node, idx) => {
        const angle = (idx / count) * Math.PI * 2 - Math.PI / 2;
        const nx = hubX + Math.cos(angle) * radius;
        const ny = hubY + Math.sin(angle) * (radius * 0.55); // Oval perspective

        nodeCoords[node.name] = { x: nx, y: ny };

        const isOnline = (node.elapsedSeconds || 0) <= 15;

        // Connection Line
        ctx.beginPath();
        ctx.moveTo(hubX, hubY);
        ctx.lineTo(nx, ny);
        ctx.strokeStyle = isOnline ? "rgba(56, 189, 248, 0.25)" : "rgba(244, 63, 94, 0.25)";
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);

        // Satellite Node circle
        ctx.beginPath();
        ctx.arc(nx, ny, 16, 0, Math.PI * 2);
        ctx.fillStyle = isOnline ? "rgba(16, 185, 129, 0.25)" : "rgba(244, 63, 94, 0.25)";
        ctx.fill();
        ctx.strokeStyle = isOnline ? "#10b981" : "#f43f5e";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Node label
        ctx.fillStyle = "#f8fafc";
        ctx.font = "bold 11px Outfit, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(node.name, nx, ny - 22);

        // Node URL / Status mini text
        ctx.fillStyle = isOnline ? "#34d399" : "#fb7185";
        ctx.font = "9px JetBrains Mono, monospace";
        ctx.fillText(isOnline ? "ONLINE" : "TIMEOUT", nx, ny + 28);
      });
    }

    // Animate Packets
    const now = Date.now();
    state.topologyPackets = state.topologyPackets.filter((pkt) => {
      const progress = (now - pkt.startTime) / pkt.duration;
      if (progress >= 1) return false;

      let start = { x: hubX, y: hubY };
      let end = { x: hubX, y: hubY };

      if (pkt.from === "hub" && nodeCoords[pkt.to]) {
        end = nodeCoords[pkt.to];
      } else if (pkt.to === "hub" && nodeCoords[pkt.from]) {
        start = nodeCoords[pkt.from];
      } else {
        return false;
      }

      const curX = start.x + (end.x - start.x) * progress;
      const curY = start.y + (end.y - start.y) * progress;

      ctx.beginPath();
      ctx.arc(curX, curY, 5, 0, Math.PI * 2);
      ctx.fillStyle = pkt.color || "#818cf8";
      ctx.shadowColor = pkt.color || "#818cf8";
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;

      return true;
    });

    canvasAnimId = requestAnimationFrame(renderTopology);
  }

  renderTopology();
}

function triggerTopologyPacket(from, to, color = "#818cf8") {
  state.topologyPackets.push({
    from,
    to,
    startTime: Date.now(),
    duration: 600,
    color,
  });
}

// ==========================================================================
// ACTIONS & INTERACTION HANDLERS
// ==========================================================================

// Send message from composer
DOM.formSendMessage.addEventListener("submit", async (e) => {
  e.preventDefault();
  const sender = DOM.msgSenderName.value.trim() || "Admin";
  const target = DOM.msgTargetNode.value;
  const message = DOM.msgContentInput.value.trim();

  if (!message) return;

  try {
    let res;
    if (target && target !== "Middleware") {
      res = await fetch(`/send-message/${encodeURIComponent(target)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender, message }),
      });
      triggerTopologyPacket("hub", target, "#818cf8");
    } else {
      res = await fetch("/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender, message }),
      });
    }

    if (!res.ok) throw new Error("Error al transmitir mensaje");

    DOM.msgContentInput.value = "";
    showToast(`Mensaje enviado exitosamente para ${target}`, "success");
    SoundFX.playSuccess();
    fetchMessages();
  } catch (err) {
    showToast("Error: " + err.message, "error");
  }
});

// Category Chips click
DOM.msgCategoryChips.forEach((chip) => {
  chip.addEventListener("click", () => {
    DOM.msgCategoryChips.forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    state.activeMsgType = chip.dataset.msgType;
    renderMessages();
  });
});

// Quick Templates click
document.querySelectorAll(".btn-template").forEach((btn) => {
  btn.addEventListener("click", () => {
    DOM.msgContentInput.value = btn.dataset.tpl;
    DOM.msgContentInput.focus();
  });
});

// Filter Messages by select dropdown
DOM.selectMsgFilter.addEventListener("change", (e) => {
  state.activeFilterServer = e.target.value;
  fetchMessages();
});

// Filter Message text search
DOM.filterMsgText.addEventListener("input", () => {
  renderMessages();
});

// Filter Servers search input
DOM.filterServers.addEventListener("input", () => {
  renderServers();
});

// Toggle Topology View
DOM.toggleTopology.addEventListener("click", () => {
  state.showTopology = !state.showTopology;
  DOM.topologySection.classList.toggle("hidden", !state.showTopology);
  DOM.toggleTopology.classList.toggle("active", state.showTopology);
});

// Clear messages history
DOM.btnClearMessages.addEventListener("click", async () => {
  if (confirm("¿Deseas vaciar todo el registro de mensajes?")) {
    try {
      const res = await fetch("/api/messages", { method: "DELETE" });
      if (res.ok) {
        showToast("Historial de mensajes vaciado", "info");
        state.messages = [];
        state.lastKnownMessageIds.clear();
        renderMessages();
        updateMessageCounts();
      }
    } catch (err) {
      showToast("Error: " + err.message, "error");
    }
  }
});

// Refresh button
DOM.btnRefreshServers.addEventListener("click", () => {
  fetchClusterStats();
  fetchMessages();
  showToast("Datos sincronizados", "info");
});

// Server Card Action Delegation (Pulse, Message, View Filter, Kill)
DOM.serversContainer.addEventListener("click", async (e) => {
  const btnPulse = e.target.closest(".btn-action-pulse");
  const btnMsg = e.target.closest(".btn-action-msg");
  const btnFilter = e.target.closest(".btn-action-filter");
  const btnKill = e.target.closest(".btn-action-kill");

  if (btnPulse) {
    const name = btnPulse.dataset.name;
    try {
      const res = await fetch(`/heartbeat/${encodeURIComponent(name)}`, { method: "POST" });
      if (res.ok) {
        showToast(`Pulso recibido de ${name}`, "success");
        SoundFX.playSuccess();
        triggerTopologyPacket(name, "hub", "#10b981");
        fetchClusterStats();
      }
    } catch (err) {
      showToast("Error: " + err.message, "error");
    }
  }

  if (btnMsg) {
    const name = btnMsg.dataset.name;
    DOM.msgTargetNode.value = name;
    DOM.msgContentInput.focus();
    DOM.msgContentInput.placeholder = `Escribir mensaje para ${name}...`;
  }

  if (btnFilter) {
    const name = btnFilter.dataset.name;
    DOM.selectMsgFilter.value = name;
    state.activeFilterServer = name;
    fetchMessages();
    showToast(`Mostrando mensajes relacionados con ${name}`, "info");
  }

  if (btnKill) {
    const name = btnKill.dataset.name;
    if (confirm(`¿Estás seguro de desconectar y eliminar al servidor '${name}'?`)) {
      try {
        const res = await fetch(`/kill-server/${encodeURIComponent(name)}`, { method: "POST" });
        if (res.ok) {
          showToast(`Servidor ${name} desconectado`, "info");
          SoundFX.playAlert();
          fetchClusterStats();
          fetchMessages();
        }
      } catch (err) {
        showToast("Error: " + err.message, "error");
      }
    }
  }
});

// Message List Action Delegation (Copy, Reply)
DOM.messagesList.addEventListener("click", (e) => {
  const btnCopy = e.target.closest(".btn-copy-msg");
  const btnReply = e.target.closest(".btn-reply-msg");

  if (btnCopy) {
    const text = btnCopy.dataset.text;
    navigator.clipboard.writeText(text).then(() => {
      showToast("Mensaje copiado al portapapeles", "success");
    });
  }

  if (btnReply) {
    const sender = btnReply.dataset.sender;
    DOM.msgTargetNode.value = sender;
    DOM.msgContentInput.focus();
    DOM.msgContentInput.placeholder = `Respuesta para ${sender}...`;
  }
});

// Quick Simulate Message Modal
DOM.btnSimMessage.addEventListener("click", () => DOM.modalSimMessage.classList.remove("hidden"));
if (DOM.btnQuickSimMsg) {
  DOM.btnQuickSimMsg.addEventListener("click", () => DOM.modalSimMessage.classList.remove("hidden"));
}

DOM.formModalSimMsg.addEventListener("submit", async (e) => {
  e.preventDefault();
  const sender = DOM.simMsgSender.value.trim() || "ServerJuan";
  const route = DOM.simMsgRoute.value;
  const message = DOM.simMsgText.value.trim();

  if (!message) return;

  try {
    let endpoint = "/messages";
    if (route === "send-message") {
      endpoint = `/send-message/${encodeURIComponent(sender)}`;
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender, message }),
    });

    if (!res.ok) throw new Error("Error transmitiendo mensaje simulado");

    showToast(`Mensaje recibido de '${sender}'`, "success");
    SoundFX.playMessage();
    triggerTopologyPacket(sender, "hub", "#38bdf8");
    DOM.modalSimMessage.classList.add("hidden");
    fetchMessages();
  } catch (err) {
    showToast("Error: " + err.message, "error");
  }
});

// Simulate Node Modal & Submission
DOM.btnSimulate.addEventListener("click", () => DOM.modalSimulate.classList.remove("hidden"));
DOM.btnEmptySimulate.addEventListener("click", () => DOM.modalSimulate.classList.remove("hidden"));

DOM.formSimulateNode.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = DOM.simNodeName.value.trim();
  const url = DOM.simNodeUrl.value.trim();
  const autoHeartbeat = DOM.simAutoHeartbeat.checked;

  if (!name || !url) return;

  try {
    const res = await fetch("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, url }),
    });

    if (!res.ok) throw new Error("Error en el registro");

    showToast(`Servidor '${name}' conectado con éxito`, "success");
    SoundFX.playSuccess();
    DOM.modalSimulate.classList.add("hidden");
    DOM.formSimulateNode.reset();

    // Auto Heartbeat Simulation from Browser
    if (autoHeartbeat) {
      if (state.simulatedIntervals[name]) clearInterval(state.simulatedIntervals[name]);
      state.simulatedIntervals[name] = setInterval(async () => {
        try {
          await fetch(`/heartbeat/${encodeURIComponent(name)}`, { method: "POST" });
          triggerTopologyPacket(name, "hub", "#10b981");
        } catch (e) {}
      }, 5000);
    }

    fetchClusterStats();
    fetchMessages();
  } catch (err) {
    showToast("Error al registrar servidor: " + err.message, "error");
  }
});

// Guide Modal
DOM.btnGuide.addEventListener("click", () => DOM.modalGuide.classList.remove("hidden"));

// Modal Close Triggers
document.querySelectorAll("[data-close-modal]").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    const modal = e.target.closest(".modal-backdrop");
    if (modal) modal.classList.add("hidden");
  });
});

// Quick copy triggers (in guide and empty state)
document.querySelectorAll("[data-copy]").forEach((el) => {
  el.addEventListener("click", () => {
    const text = el.getAttribute("data-copy");
    navigator.clipboard.writeText(text).then(() => {
      showToast("Comando copiado al portapapeles", "success");
    });
  });
});

// Sound Toggle
DOM.btnSoundToggle.addEventListener("click", () => {
  state.soundEnabled = !state.soundEnabled;
  DOM.btnSoundToggle.style.opacity = state.soundEnabled ? "1" : "0.4";
  showToast(state.soundEnabled ? "Sonido activado" : "Sonido desactivado", "info");
  if (state.soundEnabled) SoundFX.playSuccess();
});

// Live Clock
function updateClock() {
  const now = new Date();
  DOM.liveClock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ==========================================================================
// INITIALIZATION & POLLING LOOP
// ==========================================================================
function init() {
  updateClock();
  setInterval(updateClock, 1000);

  initTopology();

  // Initial fetch
  fetchClusterStats();
  fetchMessages();

  // Fast polling loop (1.5s) for real-time responsiveness
  setInterval(() => {
    fetchClusterStats();
    fetchMessages();
  }, 1500);
}

// Start app
document.addEventListener("DOMContentLoaded", init);
