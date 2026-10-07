"use strict";
// Development-only browser fixture; never copied into the FPK. No real updates.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const publicDir = path.resolve(__dirname, "../../trilium-fnos/app/proxy/public");
let checks = 0;
let polls = 0;
let updates = 0;
let scenario = "success";
let checkingError = true;
let progressError = true;
let busy = false;
let latest = null;
const token = "t".repeat(43);
function snapshot() {
  return { current: "v0.105.0", latest, busy, state: { phase: busy ? "downloading" : "idle" }, connection: { directPort:8080, lanUrls:["http://192.168.1.10:8080/"] } };
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = url.pathname.replace(/^\/app\/trilium-fnos(?=\/)/, "");
  const json = (status, body) => { res.writeHead(status, { "content-type":"application/json" }); res.end(JSON.stringify(body)); };
  if (route === "/favicon.ico") { res.writeHead(204); return res.end(); }
  if (route === "/") {
    scenario = url.searchParams.get("scenario") || "success";
    checks = polls = updates = 0; latest = null; busy = false; checkingError = progressError = true;
    res.writeHead(200, { "content-type":"text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname,"updater-ui.html"), "utf8").replaceAll("__PREFIX__", url.pathname.startsWith("/app/") ? "/app/trilium-fnos" : ""));
  }
  if (route === "/__fixture/metrics") return json(200, { checks, polls, updates });
  const files = {
    "/__fixture/style.css": [path.join(__dirname,"updater-ui.css"), "text/css"],
    "/__fixture/ui.js": [path.join(__dirname,"updater-ui.js"), "application/javascript"],
    "/__fnos/assets/update.js": [path.join(publicDir,"update.js"), "application/javascript"],
    "/__fnos/assets/update.css": [path.join(publicDir,"update.css"), "text/css"]
  };
  if (files[route]) { res.writeHead(200,{ "content-type":files[route][1] }); return res.end(fs.readFileSync(files[route][0])); }
  if (route === "/__fnos/api/status") return json(200,snapshot());
  if (route === "/__fnos/api/check") {
    checks++;
    if (scenario === "check-failure" && checkingError) { checkingError = false; return json(502,{ error:"模拟 GitHub 连接失败，请重试" }); }
    latest = { version:"v0.106.0", url:"https://github.com/TriliumNext/Trilium/releases/tag/v0.106.0" };
    return json(200,snapshot());
  }
  if (route === "/__fnos/api/update" && req.method === "POST") {
    if (req.headers["x-trilium-fnos-action"] !== "update") return json(403,{error:"action header"});
    updates++; busy = true; polls = 0;
    return json(202,{ state:{phase:"queued"}, progressToken:token });
  }
  if (route === "/__fnos/api/progress") {
    if (req.headers["x-trilium-fnos-action"] !== "progress" || req.headers["x-trilium-fnos-progress-token"] !== token) return json(401,{error:"missing progress token"});
    if (scenario === "progress-failure" && progressError) { progressError = false; return json(503,{error:"模拟进度连接中断"}); }
    polls++;
    busy = polls < 3;
    return json(200,{phase:busy ? "backing-up" : "complete",message:busy ? "模拟后端已停止，正在创建冷备份" : "模拟更新完成",detail:"仅用于浏览器回归测试"});
  }
  json(404,{error:"fixture not found"});
});
server.listen(19190,"127.0.0.1",()=>console.log("Updater UI fixture: http://127.0.0.1:19190"));
