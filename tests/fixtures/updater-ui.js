"use strict";
const menu = document.querySelector(".dropdown-menu");
document.querySelector(".global-menu > button").addEventListener("click", () => {
  menu.classList.toggle("show");
  menu.innerHTML = menu.classList.contains("show") ? '<li class="dropdown-item" data-trigger-command="showOptions">设置</li><li class="dropdown-item" data-trigger-command="openAboutDialog">关于 Trilium</li>' : "";
});
menu.addEventListener("click", () => { menu.classList.remove("show"); menu.replaceChildren(); });
document.getElementById("theme").addEventListener("click", () => document.body.classList.toggle("dark"));
document.getElementById("original").addEventListener("click", event => { event.target.textContent = "原有按键可正常点击"; });
