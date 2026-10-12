#!/usr/bin/env node
/**
 * 局域网 HTTPS 开发服务器（pnpm dev:lan）。
 *
 * 手机等设备经局域网 IP 访问时，浏览器只在安全上下文（HTTPS 或 localhost）下开放麦克风（getUserMedia）
 * 与 AudioWorklet；用 http://<IP>:3001 打开只能"仅收听"。本脚本：
 * 1. 用 openssl 生成包含 localhost 与本机全部局域网 IPv4 的自签名证书（存放于 .certificates/，IP 变化时自动重签）；
 * 2. 以 HTTPS 启动 next dev（监听 0.0.0.0）。/api 与 /ws 仍由 next.config.ts 的同源代理转发到 API_PROXY_TARGET。
 *
 * 首次在手机上打开会提示证书不受信任，选择"高级 → 继续访问"即可（自签名证书仅用于本地开发）。
 * 用法：pnpm dev:lan [--port 3001]；也可用环境变量 PORT。需要 openssl（Git for Windows 自带）。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";

const argIndex = process.argv.indexOf("--port");
const port = (argIndex > 0 && process.argv[argIndex + 1]) || process.env.PORT || "3001";
const dir = path.resolve(".certificates");
const keyFile = path.join(dir, "lan-key.pem");
const certFile = path.join(dir, "lan-cert.pem");
const hostsFile = path.join(dir, "lan-hosts.txt");

const lanIps = Object.values(networkInterfaces())
  .flatMap((list) => list ?? [])
  .filter((e) => e.family === "IPv4" && !e.internal && !e.address.startsWith("169.254."))
  .map((e) => e.address);
const hosts = ["localhost", "127.0.0.1", ...new Set(lanIps)];

function findOpenssl() {
  const candidates = [
    "openssl",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
  ];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["version"], { stdio: "ignore" });
      return bin;
    } catch {
      // 试下一个
    }
  }
  console.error("没有找到 openssl：请安装 Git for Windows 或 OpenSSL，并确保 openssl 在 PATH 中。");
  process.exit(1);
}

function ensureCertificate() {
  const wanted = hosts.join(",");
  const current = existsSync(hostsFile) ? readFileSync(hostsFile, "utf8") : "";
  if (existsSync(keyFile) && existsSync(certFile) && current === wanted) return;
  mkdirSync(dir, { recursive: true });
  const san = hosts.map((h, i) => (/^\d+(\.\d+){3}$/.test(h) ? `IP.${i + 1} = ${h}` : `DNS.${i + 1} = ${h}`));
  // 用配置文件而不是 -subj "/CN=..."：避免 MSYS 版 openssl 把以 / 开头的参数当成路径转换
  const configFile = path.join(dir, "lan-openssl.cnf");
  writeFileSync(
    configFile,
    [
      "[req]",
      "prompt = no",
      "distinguished_name = dn",
      "x509_extensions = v3",
      "[dn]",
      "CN = LinguaBridge LAN Dev",
      "[v3]",
      "basicConstraints = critical, CA:FALSE",
      "keyUsage = critical, digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth",
      "subjectAltName = @alt",
      "[alt]",
      ...san,
      "",
    ].join("\n"),
  );
  execFileSync(
    findOpenssl(),
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "825", "-keyout", keyFile, "-out", certFile, "-config", configFile],
    { stdio: "ignore" },
  );
  writeFileSync(hostsFile, wanted);
  console.log(`已生成自签名证书（${hosts.join("、")}）：${certFile}`);
}

ensureCertificate();
console.log("局域网访问地址（手机首次打开需在证书警告页选择继续访问）：");
for (const ip of lanIps) console.log(`  https://${ip}:${port}`);

const nextBin = path.resolve("node_modules", "next", "dist", "bin", "next");
const child = spawn(
  process.execPath,
  [nextBin, "dev", "--experimental-https", "--experimental-https-key", keyFile, "--experimental-https-cert", certFile, "-H", "0.0.0.0", "-p", String(port)],
  { stdio: "inherit", env: process.env },
);
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
