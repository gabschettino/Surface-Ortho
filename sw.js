// Service Worker that serves a folder picked in the page under a virtual path, so CesiumJS can load a
// local 3D Tiles folder from a hosted page and resolve child tiles relative to tileset.json as usual.
//
//   <page dir>/__local__/<session>/<path inside the folder>
//
// The page keeps the picked files. This worker only asks the page for the file at a path and streams
// it back. No file content is stored here or sent anywhere else.
"use strict";

const PREFIX = "/__local__/";
const TYPES = {
  json: "application/json", glb: "model/gltf-binary", gltf: "model/gltf+json", bin: "application/octet-stream",
  b3dm: "application/octet-stream", i3dm: "application/octet-stream", pnts: "application/octet-stream",
  cmpt: "application/octet-stream", subtree: "application/octet-stream",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", ktx2: "image/ktx2",
};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const i = url.pathname.indexOf(PREFIX);
  if (i < 0) return;
  event.respondWith(serveLocal(url.pathname.slice(i + PREFIX.length)));
});

function ask(client, msg) {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve({ ok: false, error: "The page did not answer." }), 30000);
    ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data); };
    client.postMessage(msg, [ch.port2]);
  });
}

async function serveLocal(rest) {
  const slash = rest.indexOf("/");
  const session = rest.slice(0, slash);
  const path = rest.slice(slash + 1).split("/").map(decodeURIComponent).join("/");
  // Ask every open page of this site. Only the page that owns the session has the files.
  // (Requests made from a Web Worker carry the worker's client ID, so event.clientId is not enough.)
  const windows = await self.clients.matchAll({ type: "window" });
  let last = { ok: false, error: "No open page holds this folder. Pick the folder again." };
  for (const client of windows) {
    const reply = await ask(client, { type: "local-get", session, path });
    if (reply.ok) {
      const ext = path.split(".").pop().toLowerCase();
      return new Response(reply.file, { headers: { "Content-Type": TYPES[ext] || "application/octet-stream" } });
    }
    if (reply.error !== "unknown-session") last = reply;
  }
  return new Response(`Local file not available: ${path}. ${last.error}`, { status: 404 });
}
