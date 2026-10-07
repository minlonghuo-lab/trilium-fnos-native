(() => {
  "use strict";
  if (window.__triliumFnosSyncLoaded) return;
  window.__triliumFnosSyncLoaded = true;
  const base = new URL("../", document.currentScript.src);
  const themeKey = `trilium-fnos-theme:${base.pathname}`;
  const themeTokens = ["--main-background-color", "--main-text-color", "--muted-text-color", "--card-background-color", "--input-background-color", "--input-text-color", "--main-border-color", "--cmd-button-background-color", "--cmd-button-text-color", "--cmd-button-hover-background-color", "--input-focus-outline-color", "--main-font-family"];

  function rememberTheme() {
    try {
      const style = getComputedStyle(document.body);
      const values = Object.fromEntries(themeTokens.map(name => [name, style.getPropertyValue(name).trim()]));
      values.colorScheme = style.colorScheme;
      sessionStorage.setItem(themeKey, JSON.stringify(values));
    } catch { /* Storage-disabled WebViews still work with the system theme. */ }
  }
  function restoreTheme() {
    try {
      const values = JSON.parse(sessionStorage.getItem(themeKey) || "{}");
      for (const name of themeTokens) {
        const value = values[name];
        if (typeof value !== "string" || !value || value.length > 300 || /url\s*\(|[{};]/i.test(value)) continue;
        document.body.style.setProperty(name, value);
      }
      if (["light", "dark", "light dark", "dark light"].includes(values.colorScheme)) document.body.style.colorScheme = values.colorScheme;
    } catch { /* Invalid or unavailable storage is non-fatal. */ }
  }

  function installMenu() {
    document.querySelectorAll(".global-menu > .dropdown-menu").forEach(menu => {
      if (menu.querySelector("[data-trilium-fnos-sync-menu]")) return;
      const about = menu.querySelector('[data-trigger-command="openAboutDialog"]');
      if (!about) return;
      const item = document.createElement("li");
      item.className = "dropdown-item";
      item.dataset.triliumFnosSyncMenu = "true";
      item.tabIndex = 0;
      item.setAttribute("role", "menuitem");
      item.innerHTML = '<span class="tn-icon bx bx-sync" aria-hidden="true"></span>&nbsp;<span>电脑端同步</span>';
      item.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        rememberTheme();
        window.location.assign(base.href);
      });
      item.addEventListener("keydown", event => {
        if (!["Enter", " "].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        item.click();
      });
      menu.insertBefore(item, about);
    });
  }

  function showAddresses(data) {
    const container = document.getElementById("fnos-addresses");
    container.replaceChildren();
    const urls = (Array.isArray(data.lanUrls) ? data.lanUrls : []).filter(value => {
      try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
    });
    if (!urls.length) {
      container.textContent = `未检测到局域网 IPv4 地址。请使用电脑可访问的 NAS 地址和端口 ${Number(data.directPort) || 8080}。`;
      return;
    }
    urls.forEach((url, index) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.id = `fnos-address-${index}`;
      label.htmlFor = input.id;
      label.textContent = urls.length === 1 ? "局域网同步地址" : `局域网同步地址 ${index + 1}`;
      input.type = "text"; input.readOnly = true; input.value = url;
      const row = document.createElement("div"); row.className = "fnos-address-row";
      const button = document.createElement("button"); button.type = "button"; button.textContent = "复制";
      button.setAttribute("aria-label", `复制同步地址 ${index + 1}`);
      button.addEventListener("click", async () => {
        const feedback = document.getElementById("fnos-feedback");
        try {
          if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
          await navigator.clipboard.writeText(url);
          feedback.textContent = "地址已复制。";
        } catch {
          input.focus(); input.select(); input.setSelectionRange(0, input.value.length);
          feedback.textContent = "浏览器不允许自动复制，地址已选中，请长按复制或按 Ctrl/Cmd+C。";
        }
      });
      row.append(input, button); container.append(label, row);
    });
  }

  async function loadAddresses() {
    const container = document.getElementById("fnos-addresses");
    const retry = document.getElementById("fnos-retry");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    retry.disabled = true; retry.hidden = true;
    container.setAttribute("aria-busy", "true");
    container.textContent = "正在读取局域网地址…";
    try {
      const response = await fetch(new URL("api/connections", base), { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 ? "登录已失效，请返回 Trilium 登录后重试。" : `读取失败（HTTP ${response.status}）。`);
      showAddresses(await response.json());
    } catch (error) {
      container.textContent = error.name === "AbortError" ? "连接超时，请检查应用是否正在运行。" : error.message;
      retry.hidden = false;
    } finally {
      clearTimeout(timer); retry.disabled = false; container.setAttribute("aria-busy", "false");
    }
  }
  function init() {
    if (document.body.hasAttribute("data-trilium-fnos-sync")) {
      restoreTheme();
      document.getElementById("fnos-retry").addEventListener("click", loadAddresses);
      void loadAddresses();
      return;
    }
    // No API/GitHub call on editor startup; only watch native menu remounts.
    installMenu();
    const observer = new MutationObserver(records => {
      if (records.some(record => record.target.closest?.(".global-menu") || [...record.addedNodes].some(node => node.nodeType === 1 && (node.matches?.(".global-menu") || node.querySelector?.(".global-menu"))))) installMenu();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("pagehide", () => observer.disconnect());
    window.addEventListener("pageshow", event => { if (event.persisted) { installMenu(); observer.observe(document.body, { childList: true, subtree: true }); } });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
