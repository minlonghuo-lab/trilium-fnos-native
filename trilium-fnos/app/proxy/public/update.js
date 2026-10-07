(() => {
  "use strict";

  if (window.__triliumFnosUpdaterLoaded) return;
  window.__triliumFnosUpdaterLoaded = true;
  const managerBase = new URL("../", document.currentScript.src);
  const storageKey = `trilium-fnos-progress:${managerBase.href}`;
  const terminalPhases = new Set(["idle", "complete", "failed", "failed-rolled-back"]);
  let snapshot = null;
  let activeModal = null;
  let pollTimer = null;
  let pollGeneration = 0;
  let progressToken = null;
  try { progressToken = sessionStorage.getItem(storageKey); } catch { /* Storage can be disabled. */ }

  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  async function api(endpoint, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(new URL(`api/${endpoint}`, managerBase), {
        credentials: "same-origin", cache: "no-store", ...options,
        signal: controller.signal,
        headers: { ...(options.headers || {}) }
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(body.error || (response.status === 401
          ? "请先登录 Trilium，再打开飞牛管理。" : `请求失败（HTTP ${response.status}）`));
        error.status = response.status;
        throw error;
      }
      return body;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("请求超时，请检查网络后重试。正在执行的更新不会因此取消。");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function saveToken(token) {
    progressToken = token || null;
    try {
      if (progressToken) sessionStorage.setItem(storageKey, progressToken);
      else sessionStorage.removeItem(storageKey);
    } catch { /* The in-memory token still permits progress during a backend restart. */ }
  }

  function busy(data) {
    return !!(data?.busy || (data?.state && !terminalPhases.has(data.state.phase)));
  }

  function isAvailable(data) {
    // The server performs the authoritative version comparison before updating.
    if (typeof data?.canUpdate === "boolean") return data.canUpdate;
    return !!(data?.current && data?.latest?.version && data.current !== data.latest.version);
  }

  function updateMenuLabels() {
    const label = busy(snapshot) ? "飞牛管理 / 正在更新" : "飞牛管理 / 更新";
    document.querySelectorAll("[data-trilium-fnos-menu] .trilium-fnos-menu-label").forEach((node) => {
      if (node.textContent !== label) node.textContent = label;
    });
  }

  function installMenuEntries() {
    // Verified against v0.105.0 and v0.106.0 GlobalMenu/Dropdown/FormList.
    // Preact mounts menu children only while open; observe remounts, never move native items.
    document.querySelectorAll(".global-menu > .dropdown-menu").forEach((menu) => {
      const about = menu.querySelector(':scope > [data-trigger-command="openAboutDialog"]');
      if (!about || menu.querySelector(":scope > [data-trilium-fnos-menu]")) return;
      const item = document.createElement("li");
      item.className = "dropdown-item";
      item.dataset.triliumFnosMenu = "true";
      item.tabIndex = 0;
      item.setAttribute("role", "menuitem");
      item.setAttribute("aria-haspopup", "dialog");
      item.innerHTML = '<span class="tn-icon bx bx-download" aria-hidden="true"></span>&nbsp;<span class="trilium-fnos-menu-label">飞牛管理 / 更新</span>';
      item.addEventListener("click", openModal);
      item.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        item.click();
      });
      menu.insertBefore(item, about);
    });
    updateMenuLabels();
  }

  function stopPolling() {
    pollGeneration += 1;
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  function closeModal(modal) {
    if (activeModal !== modal) return;
    stopPolling();
    activeModal = null;
    modal.close();
    modal.remove();
    const returnFocus = modal.returnFocus?.isConnected ? modal.returnFocus : document.querySelector(".global-menu > button");
    returnFocus?.focus();
  }

  function modalShell() {
    const modal = document.createElement("dialog");
    modal.id = "trilium-fnos-management";
    modal.className = "trilium-fnos-modal";
    modal.setAttribute("aria-labelledby", "trilium-fnos-management-title");
    modal.returnFocus = document.activeElement;
    modal.innerHTML = '<header><h2 id="trilium-fnos-management-title">飞牛管理 / 更新</h2><button class="trilium-fnos-close" type="button" aria-label="关闭">×</button></header><section aria-live="polite"><p>正在读取应用状态…</p></section><footer></footer>';
    modal.querySelector(".trilium-fnos-close").addEventListener("click", () => closeModal(modal));
    modal.addEventListener("cancel", (event) => { event.preventDefault(); closeModal(modal); });
    modal.addEventListener("click", (event) => {
      if (event.target !== modal) return;
      const rect = modal.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeModal(modal);
    });
    // Do not let Trilium's editor/global shortcuts receive dialog keystrokes.
    modal.addEventListener("keydown", (event) => event.stopPropagation());
    document.body.appendChild(modal);
    modal.showModal();
    activeModal = modal;
    return modal;
  }

  function actions(modal, items) {
    const footer = modal.querySelector("footer");
    footer.replaceChildren();
    for (const [label, handler, primary = false] of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = primary ? "btn btn-primary" : "btn";
      button.textContent = label;
      button.addEventListener("click", handler);
      footer.appendChild(button);
    }
    if (activeModal === modal && !modal.contains(document.activeElement)) {
      modal.querySelector(".trilium-fnos-close").focus();
    }
  }

  function connectionSection(connection) {
    if (!connection) return "";
    const urls = (connection.lanUrls || []).filter((value) => {
      try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
    });
    return `<div class="trilium-fnos-connection"><h3>电脑端同步</h3>
      <p>以下为检测到的局域网地址候选，请选用电脑可访问的地址，并为 NAS 设置固定 IP 或 DHCP 地址保留。</p>
      ${urls.length ? urls.map((url, index) => `<label>同步地址 ${index + 1}<input type="text" readonly value="${escapeHtml(url)}" aria-label="同步地址 ${index + 1}"></label>`).join("") : `<p>使用 NAS 的固定局域网 IP 和端口 ${escapeHtml(connection.directPort || 8080)}。未检测到可推荐的局域网地址。</p>`}
      <p class="trilium-fnos-muted">电脑端 Trilium 应与服务器版本兼容。飞牛网关地址依赖飞牛登录，不能作为电脑端同步地址。外网同步请使用独立 HTTPS 域名反向代理至上述应用端口；18888 仅供内部使用。</p></div>`;
  }

  function renderStatus(modal, data, errorMessage = "") {
    if (activeModal !== modal) return;
    snapshot = data;
    updateMenuLabels();
    const available = isAvailable(data);
    let releaseLink = "";
    try {
      const url = new URL(data?.latest?.url);
      if (url.protocol === "https:" && url.hostname === "github.com") releaseLink = `<p><a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">查看官方发布说明</a></p>`;
    } catch { /* No checked release yet. */ }
    modal.querySelector("section").innerHTML = `
      <dl class="trilium-fnos-versions"><div><dt>当前版本</dt><dd>${escapeHtml(data?.current || "未知")}</dd></div><div><dt>官方稳定版</dt><dd>${escapeHtml(data?.latest?.version || "尚未检查")}</dd></div></dl>
      ${errorMessage || data?.checkError ? `<p class="trilium-fnos-warning" role="alert">${escapeHtml(errorMessage || data.checkError)}</p>` : ""}
      <p>${available ? "更新会校验官方原生发行包、暂停后端并创建冷备份。健康检查失败时自动恢复备份；更新期间网页和同步会短暂中断。" : data?.latest ? "当前没有不同版本的稳定版可供安装。" : "点击“检查更新”获取官方稳定版信息。读取当前状态不会访问 GitHub。"}</p>
      ${releaseLink}${connectionSection(data?.connection)}`;
    actions(modal, [
      ["关闭", () => closeModal(modal)],
      ["检查更新", () => loadStatus(modal, true), !available],
      ...(available ? [["备份并更新", () => startUpdate(modal), true]] : [])
    ]);
  }

  function showError(modal, error, retry) {
    if (activeModal !== modal) return;
    modal.querySelector("section").innerHTML = `<p class="trilium-fnos-warning" role="alert">${escapeHtml(error.message)}</p>`;
    actions(modal, [["关闭", () => closeModal(modal)], ["重试", retry, true]]);
  }

  async function loadStatus(modal, check = false) {
    stopPolling();
    modal.querySelector("section").innerHTML = `<p>${check ? "正在检查官方稳定版…" : "正在读取应用状态…"}</p>`;
    actions(modal, [["关闭", () => closeModal(modal)]]);
    try {
      const data = await api(check ? "check" : "status");
      if (activeModal !== modal) return;
      snapshot = data;
      if (busy(data)) return showProgress(modal);
      renderStatus(modal, data);
    } catch (error) {
      if (snapshot) renderStatus(modal, snapshot, error.message);
      else showError(modal, error, () => loadStatus(modal, check));
    }
  }

  async function openModal() {
    if (activeModal) { activeModal.querySelector(".trilium-fnos-close").focus(); return; }
    const modal = modalShell();
    if (progressToken) return showProgress(modal);
    await loadStatus(modal);
  }

  async function startUpdate(modal) {
    actions(modal, [["关闭", () => closeModal(modal)]]);
    modal.querySelector("section").innerHTML = "<p>正在提交更新任务…关闭此窗口不会取消已提交的更新。</p>";
    try {
      const result = await api("update", { method: "POST", headers: { "x-trilium-fnos-action": "update" } });
      saveToken(result.progressToken);
      snapshot = { ...snapshot, busy: true, state: result.state };
      updateMenuLabels();
      if (activeModal === modal) showProgress(modal);
    } catch (error) {
      showError(modal, error, () => loadStatus(modal));
    }
  }

  function showProgress(modal) {
    stopPolling();
    const generation = pollGeneration;
    modal.querySelector("section").innerHTML = '<p class="progress-message">正在读取更新进度…</p><p class="progress-detail trilium-fnos-muted"></p><p class="trilium-fnos-muted">关闭此窗口不会中止更新。更新完成后重新加载 Trilium。</p>';
    actions(modal, [["关闭", () => closeModal(modal)]]);
    const poll = async () => {
      try {
        const progress = await api("progress", { headers: progressToken ? {
          "x-trilium-fnos-progress-token": progressToken,
          "x-trilium-fnos-action": "progress"
        } : {} });
        if (activeModal !== modal || generation !== pollGeneration) return;
        snapshot = { ...snapshot, state: progress, busy: !terminalPhases.has(progress.phase) };
        updateMenuLabels();
        modal.querySelector(".progress-message").textContent = progress.message || "正在更新…";
        modal.querySelector(".progress-detail").textContent = progress.detail || "";
        if (terminalPhases.has(progress.phase)) {
          saveToken(null);
          stopPolling();
          const failed = progress.phase.startsWith("failed");
          modal.querySelector("section").innerHTML = `<p class="${failed ? "trilium-fnos-warning" : ""}" ${failed ? 'role="alert"' : ""}>${escapeHtml(progress.message || "当前没有更新任务。")}</p>${progress.error ? `<p class="trilium-fnos-error-detail">${escapeHtml(progress.error)}</p>` : ""}`;
          actions(modal, [["关闭", () => closeModal(modal)], ["重新读取状态", () => loadStatus(modal)], ["重新加载 Trilium", () => window.location.reload(), true]]);
          return;
        }
        // Schedule only after completion: a slow request cannot create overlapping polls.
        pollTimer = setTimeout(poll, 2000);
      } catch (error) {
        if (activeModal !== modal || generation !== pollGeneration) return;
        stopPolling();
        modal.querySelector("section").innerHTML = `<p class="trilium-fnos-warning" role="alert">更新进度读取失败：${escapeHtml(error.message)}</p><p>这不代表更新已经停止，请勿重复提交更新。可重试读取进度；若凭据已失效，请重新登录 Trilium 后读取状态。</p>`;
        actions(modal, [["关闭", () => closeModal(modal)], ["重新读取状态", () => { saveToken(null); loadStatus(modal); }], ["重试读取进度", () => showProgress(modal), true]]);
      }
    };
    void poll();
  }

  async function initialize() {
    installMenuEntries();
    // Ignore editor/content changes: only scan again when a global menu is created or remounted.
    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.target.closest?.(".global-menu") || [...record.addedNodes].some((node) =>
        node.nodeType === 1 && (node.matches(".global-menu") || node.querySelector(".global-menu"))))) installMenuEntries();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("pagehide", () => { observer.disconnect(); stopPolling(); });
    window.addEventListener("pageshow", (event) => {
      if (!event.persisted) return;
      observer.observe(document.body, { childList: true, subtree: true });
      installMenuEntries();
      if (activeModal && progressToken) showProgress(activeModal);
    });
    if (document.body.hasAttribute("data-trilium-fnos-management")) {
      document.querySelector("[data-trilium-fnos-open]")?.addEventListener("click", openModal);
      return openModal();
    }
    try {
      snapshot = await api("status");
      updateMenuLabels();
    } catch { /* Login/setup pages have no global menu. The menu itself remains usable on errors. */ }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else void initialize();
})();
