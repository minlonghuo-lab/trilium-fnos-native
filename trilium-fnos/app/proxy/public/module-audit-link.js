(() => {
  "use strict";
  const owner = document.currentScript;
  if (!owner) return;
  const base = new URL("../../", owner.src);
  let observer, timer;
  function init() {
    const splash = document.getElementById("splash");
    if (!splash || splash.querySelector('[data-module-audit-link]')) return;
    const row = document.createElement("p"), link = document.createElement("a");
    row.dataset.moduleAuditLink = "true";
    link.textContent = "资源诊断（临时）";
    // Stay in the SAME fnOS WebView and NAS gateway, not a new Safari window.
    link.href = new URL("__fnos/module-audit/", base).href;
    row.append(link); (splash.querySelector(".splash-content") || splash).append(row);
    observer?.disconnect(); clearTimeout(timer);
  }
  // Do not wait for DOMContentLoaded: a rejected/hung parser module can hold
  // that event indefinitely. This observer only adds a link, never retries.
  observer = new MutationObserver(init);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  timer = setTimeout(() => observer.disconnect(), 20000);
  window.addEventListener("pagehide", () => { observer.disconnect(); clearTimeout(timer); }, { once: true });
  init();
})();
