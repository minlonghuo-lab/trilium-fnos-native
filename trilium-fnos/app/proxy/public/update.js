(() => {
  "use strict";

  if (window.__triliumFnosUpdaterLoaded) return;
  window.__triliumFnosUpdaterLoaded = true;
  // Resolve alongside this script, for both the direct port and fnOS gateway.
  const managerBase = new URL("../", document.currentScript.src);

  const terminalPhases = new Set(["idle", "complete", "failed", "failed-rolled-back"]);
  let snapshot = null;
  let pollTimer = null;

  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  async function api(path, options = {}) {
    const response = await fetch(new URL(path.replace(/^\/__fnos\//, ""), managerBase), {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: { ...(options.headers || {}) }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  }

  function isAvailable(data) {
    return data?.current && data?.latest?.version && data.current !== data.latest.version;
  }

  function ensureRoot() {
    let root = document.getElementById("trilium-fnos-update-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "trilium-fnos-update-root";
      document.body.appendChild(root);
    }
    return root;
  }

  function renderButton(data) {
    const root = ensureRoot();
    const busy = data?.busy || (data?.state && !terminalPhases.has(data.state.phase));
    const available = isAvailable(data);
    let slot = root.querySelector(":scope > .trilium-fnos-button-slot");
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "trilium-fnos-button-slot";
      root.prepend(slot);
    }
    slot.innerHTML = `
      <button class="trilium-fnos-update-button" type="button" aria-label="Trilium 更新">
        <span class="trilium-fnos-update-dot ${busy ? "busy" : available ? "available" : ""}"></span>
        <span class="label">${busy ? "正在更新" : available ? `可更新至 ${escapeHtml(data.latest.version)}` : "检查更新"}</span>
        <span aria-hidden="true">⇧</span>
      </button>`;
    slot.querySelector("button").addEventListener("click", openModal);
  }

  function modalShell(content, actions = "") {
    const root = ensureRoot();
    const backdrop = document.createElement("div");
    backdrop.className = "trilium-fnos-modal-backdrop";
    backdrop.innerHTML = `
      <div class="trilium-fnos-modal" role="dialog" aria-modal="true" aria-label="Trilium 更新">
        <header><h2>Trilium Notes 更新</h2><button class="trilium-fnos-close" type="button" aria-label="关闭">×</button></header>
        <section>${content}</section>
        <footer>${actions}</footer>
      </div>`;
    backdrop.querySelector(".trilium-fnos-close").addEventListener("click", () => {
      if (!backdrop.dataset.locked) backdrop.remove();
    });
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop && !backdrop.dataset.locked) backdrop.remove();
    });
    root.appendChild(backdrop);
    return backdrop;
  }

  async function openModal() {
    const modal = modalShell("<p>正在查询官方最新稳定版…</p>");
    try {
      snapshot = await api("/__fnos/api/status");
      if (snapshot.busy) return showProgress(modal);
      const available = isAvailable(snapshot);
      modal.querySelector("section").innerHTML = `
        <div class="versions">
          <div class="version-card"><small>当前版本</small><strong>${escapeHtml(snapshot.current)}</strong></div>
          <span aria-hidden="true">→</span>
          <div class="version-card"><small>官方稳定版</small><strong>${escapeHtml(snapshot.latest.version)}</strong></div>
        </div>
        ${available ? `<p class="warning">更新会先下载并校验官方原生发行包，再短暂停止 Trilium 创建冷备份。新版数据库迁移后无法直接由旧版读取；健康检查失败时本应用会自动恢复备份。</p>` : "<p>当前已是最新稳定版。</p>"}
        <p><a href="${escapeHtml(snapshot.latest.url)}" target="_blank" rel="noreferrer">查看官方发布说明</a></p>`;
      modal.querySelector("footer").innerHTML = available
        ? '<button type="button" class="cancel">取消</button><button type="button" class="primary update">备份并更新</button>'
        : '<button type="button" class="cancel">关闭</button>';
      modal.querySelector(".cancel").addEventListener("click", () => modal.remove());
      modal.querySelector(".update")?.addEventListener("click", () => startUpdate(modal));
    } catch (error) {
      modal.querySelector("section").innerHTML = `<p class="warning">${escapeHtml(error.message)}</p>`;
      modal.querySelector("footer").innerHTML = '<button type="button" class="cancel">关闭</button>';
      modal.querySelector(".cancel").addEventListener("click", () => modal.remove());
    }
  }

  async function startUpdate(modal) {
    modal.dataset.locked = "true";
    modal.querySelector(".trilium-fnos-close").disabled = true;
    modal.querySelectorAll("footer button").forEach((button) => { button.disabled = true; });
    try {
      await api("/__fnos/api/update", {
        method: "POST",
        headers: { "x-trilium-fnos-action": "update" }
      });
      showProgress(modal);
    } catch (error) {
      delete modal.dataset.locked;
      modal.querySelector(".trilium-fnos-close").disabled = false;
      modal.querySelector("section").innerHTML = `<p class="warning">${escapeHtml(error.message)}</p>`;
      modal.querySelector("footer").innerHTML = '<button type="button" class="cancel">关闭</button>';
      modal.querySelector(".cancel").addEventListener("click", () => modal.remove());
    }
  }

  async function showProgress(modal) {
    modal.dataset.locked = "true";
    modal.querySelector(".trilium-fnos-close").disabled = true;
    modal.querySelector("section").innerHTML = `
      <p class="progress-message">正在准备更新…</p>
      <div class="trilium-fnos-progress"><span></span></div>
      <p class="progress-detail" style="color:var(--fnos-muted);margin-top:12px"></p>`;
    modal.querySelector("footer").innerHTML = "";

    const poll = async () => {
      try {
        const progress = await api("/__fnos/api/progress");
        modal.querySelector(".progress-message").textContent = progress.message || "正在更新…";
        modal.querySelector(".progress-detail").textContent = progress.detail || "";
        renderButton({ state: progress, busy: !terminalPhases.has(progress.phase) });
        if (terminalPhases.has(progress.phase) && progress.phase !== "idle") {
          clearInterval(pollTimer);
          pollTimer = null;
          delete modal.dataset.locked;
          modal.querySelector(".trilium-fnos-close").disabled = false;
          const failed = progress.phase.startsWith("failed");
          modal.querySelector("section").innerHTML = `
            <p class="${failed ? "warning" : ""}">${escapeHtml(progress.message)}</p>
            ${progress.error ? `<p style="white-space:pre-wrap;color:var(--fnos-muted)">${escapeHtml(progress.error)}</p>` : ""}`;
          modal.querySelector("footer").innerHTML = '<button type="button" class="primary reload">\u91cd新加载 Trilium</button>';
          modal.querySelector(".reload").addEventListener("click", () => window.location.reload());
        }
      } catch {
        // The Trilium backend is intentionally unavailable during recreation.
      }
    };
    await poll();
    if (!pollTimer) pollTimer = setInterval(poll, 2000);
  }

  async function initialize() {
    try {
      snapshot = await api("/__fnos/api/status");
      renderButton(snapshot);
    } catch (error) {
      // A 401 is expected on setup/login pages. The injected control stays hidden.
      console.debug("Trilium fnOS updater unavailable:", error.message);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
