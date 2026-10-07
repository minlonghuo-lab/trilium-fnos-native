"use strict";

const os = require("node:os");
const net = require("node:net");
const { GATEWAY_PREFIX } = require("./gateway");

function isPrivateIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

// These are candidates, not a network reachability probe. A NAS with multiple
// interfaces can have addresses which are not reachable from this computer.
// Never derive a sync URL from the fnOS gateway Host: its NAS login cookies
// are not available to the desktop Trilium client.
function getConnectionInfo(publicPort, interfaces = os.networkInterfaces()) {
  const addresses = new Set();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry.internal && isPrivateIPv4(entry.address)) addresses.add(entry.address);
    }
  }
  return {
    directPort: publicPort,
    lanUrls: [...addresses].sort().map(address => `http://${address}:${publicPort}/`),
    gatewayPath: `${GATEWAY_PREFIX}/`,
    note: "局域网地址为检测到的候选地址，请固定 NAS IP 并从电脑测试连接。外网同步请使用独立 HTTPS 域名反向代理到此端口；飞牛网关登录地址不能用于桌面同步。"
  };
}

module.exports = { getConnectionInfo };
