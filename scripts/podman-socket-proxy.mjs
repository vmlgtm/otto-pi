#!/usr/bin/env node
// Local development only. workerd creates containers through the Docker API
// with HostConfig.MemorySwappiness set, which Podman's crun rejects on
// cgroup v2 ("cannot set memory swappiness with cgroupv2"). This proxy sits
// on a unix socket in front of Podman's, drops that one field from
// container-create requests, and passes everything else through, including
// the upgraded (hijacked) connections that exec and attach use.
//
//   node scripts/podman-socket-proxy.mjs /tmp/otto-docker.sock &
//   export DOCKER_HOST=unix:///tmp/otto-docker.sock
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

const listenPath = process.argv[2] ?? "/tmp/otto-docker.sock";
const podmanSocket =
  process.env.PODMAN_SOCKET ??
  execFileSync("podman", [
    "machine",
    "inspect",
    "--format",
    "{{.ConnectionInfo.PodmanSocket.Path}}"
  ])
    .toString()
    .trim();

function rewrite(path, body) {
  if (!/\/containers\/create(\?|$)/.test(path) || body.length === 0) return body;
  const spec = JSON.parse(body.toString());
  if (spec.HostConfig) delete spec.HostConfig.MemorySwappiness;
  return Buffer.from(JSON.stringify(spec));
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = rewrite(req.url, Buffer.concat(chunks));
    const headers = { ...req.headers };
    if (body.length > 0 || headers["content-length"]) headers["content-length"] = String(body.length);
    delete headers["transfer-encoding"];
    const upstream = http.request(
      { socketPath: podmanSocket, path: req.url, method: req.method, headers },
      (up) => {
        if (process.env.PROXY_DEBUG) console.log(req.method, req.url, up.statusCode, body.length ? body.toString().slice(0, 400) : "");
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on("error", (error) => {
      res.writeHead(502);
      res.end(String(error));
    });
    upstream.end(body);
  });
});

// exec start and attach upgrade the connection to a raw stream.
server.on("upgrade", (req, socket, head) => {
  if (process.env.PROXY_DEBUG) console.log("UPGRADE", req.method, req.url);
  const upstream = net.connect(podmanSocket, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

try {
  fs.unlinkSync(listenPath);
} catch {}
server.listen(listenPath, () => {
  console.log(`podman socket proxy: ${listenPath} -> ${podmanSocket}`);
});
