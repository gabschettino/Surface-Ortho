// Data sources other than plain URLs and Cesium ion: iTwin reality data (with Bentley sign-in) and
// local folders (served through sw.js). Plain script; exposes window.OrthoSources.
(() => {
  "use strict";
  const cfg = window.APP_CONFIG || {};
  const qp = new URLSearchParams(location.search);

  // An error that says what failed and how to fix it. message = what + " " + fix.
  class SourceError extends Error {
    constructor(what, fix, cause) { super(fix ? `${what} ${fix}` : what); this.what = what; this.fix = fix; this.cause = cause; }
  }

  // ======================= iTwin sign-in =======================
  // OAuth 2.0 authorization code with PKCE through oidc-client-ts. The endpoints are given directly
  // instead of fetched from the discovery document, because ims.bentley.com did not send CORS headers
  // for a github.io origin on that document when tested (2026-10-13).
  const IMS = {
    issuer: "https://ims.bentley.com",
    authorization_endpoint: "https://ims.bentley.com/connect/authorize",
    token_endpoint: "https://ims.bentley.com/connect/token",
    end_session_endpoint: "https://ims.bentley.com/connect/endsession",
  };
  const clientId = qp.get("clientId") || cfg.itwinClientId || "";
  const scope = cfg.itwinScope || "itwin-platform";
  // The page itself is the redirect target. Register exactly this value on developer.bentley.com.
  const redirectUri = location.origin + location.pathname.replace(/index\.html$/, "");
  let mgr = null;
  let user = null;          // signed-in user, kept in memory only
  let pastedToken = null;   // token pasted under "Use a token instead", kept in memory only

  function manager() {
    if (!clientId) {
      throw new SourceError("Sign-in is not configured: no iTwin client ID.",
        "Set itwinClientId in config.js or add ?clientId=<your SPA client ID> to the URL. You can also paste a token under \"Use a token instead\".");
    }
    if (!window.oidc) throw new SourceError("The sign-in library did not load.", "Check the network connection and reload the page.");
    if (!mgr) {
      mgr = new oidc.UserManager({
        authority: IMS.issuer, metadata: IMS, client_id: clientId, redirect_uri: redirectUri,
        post_logout_redirect_uri: redirectUri, response_type: "code", scope,
        // PKCE state must survive the redirect, so it goes to sessionStorage (cleared when the tab closes).
        // Tokens stay in memory. Reloading the page signs you out.
        stateStore: new oidc.WebStorageStateStore({ store: window.sessionStorage }),
        userStore: new oidc.WebStorageStateStore({ store: new oidc.InMemoryWebStorage() }),
        automaticSilentRenew: false, loadUserInfo: false,
      });
    }
    return mgr;
  }

  function describeSignInError(e) {
    const code = e?.error || "", desc = e?.error_description || e?.message || String(e);
    if (/redirect/i.test(code + desc)) {
      return new SourceError("Sign-in failed: redirect URI not registered.",
        `Add ${redirectUri} to the redirect URIs of client ${clientId} on developer.bentley.com.`, e);
    }
    if (code === "invalid_scope" || /scope/i.test(desc)) {
      return new SourceError(`Sign-in failed: scope "${scope}" is not allowed for this client.`,
        "Add the iTwin Platform API access to the app registration, or set itwinScope in config.js to the scope it lists.", e);
    }
    if (code === "access_denied") return new SourceError("Sign-in was cancelled or denied.", "Click Sign in to try again.", e);
    if (code === "invalid_client" || code === "unauthorized_client") {
      return new SourceError(`Sign-in failed: client ID ${clientId} was not accepted.`,
        "Check that it is a Single page application registration and copy the client ID again.", e);
    }
    if (e instanceof TypeError || /failed to fetch|network/i.test(desc)) {
      return new SourceError("Sign-in failed: the token request to ims.bentley.com was blocked.",
        `This is usually CORS. Check that ${location.origin} matches a registered redirect URI. As a workaround, paste a token under "Use a token instead".`, e);
    }
    return new SourceError(`Sign-in failed: ${code ? code + ", " : ""}${desc}.`, "Try again. If it keeps failing, use \"Use a token instead\".", e);
  }

  // Call once at startup. Finishes a sign-in redirect if the URL carries one.
  async function handleRedirect() {
    const isCallback = qp.has("state") && (qp.has("code") || qp.has("error"));
    if (!isCallback) return { handled: false };
    let error = null;
    let search = "";
    try {
      if (qp.has("error")) throw { error: qp.get("error"), error_description: qp.get("error_description") || "" };
      user = await manager().signinRedirectCallback();
      search = user?.state?.search || "";
    } catch (e) {
      error = e instanceof SourceError ? e : describeSignInError(e);
    }
    history.replaceState(null, "", redirectUri + search); // drop code and state from the address bar
    return { handled: true, error };
  }

  async function signIn() {
    try { await manager().signinRedirect({ state: { search: location.search } }); }
    catch (e) { throw e instanceof SourceError ? e : describeSignInError(e); }
  }
  function signOut() { user = null; pastedToken = null; mgr?.removeUser(); }
  function setPastedToken(t) { pastedToken = (t || "").trim().replace(/^Bearer\s+/i, "") || null; }

  function getToken() {
    if (pastedToken) return pastedToken;
    if (user && !user.expired) return user.access_token;
    if (user && user.expired) throw new SourceError("Your sign-in has expired.", "Click Sign in again.");
    throw new SourceError("Not signed in to iTwin.", "Click Sign in, or paste a token under \"Use a token instead\".");
  }
  function sessionInfo() {
    if (pastedToken) return { signedIn: true, how: "pasted token" };
    if (user && !user.expired) return { signedIn: true, how: "Bentley account", expiresAt: user.expires_at ? new Date(user.expires_at * 1000) : null };
    return { signedIn: false, configured: !!clientId };
  }

  // ======================= iTwin Platform REST =======================
  const API = "https://api.bentley.com";
  const ACCEPT = "application/vnd.bentley.itwin-platform.v1+json";

  async function httpError(res, what) {
    let body = {};
    try { body = await res.json(); } catch { /* not JSON */ }
    const code = body?.error?.code ? `, ${body.error.code}` : "";
    switch (res.status) {
      case 401: return new SourceError(`${what}: token rejected (401${code}).`,
        "Sign in again. A pasted token may have expired or may lack the itwin-platform scope.");
      case 403: return new SourceError(`${what}: access denied (403${code}).`,
        "Your account needs to be a member of this iTwin with the realitydata_use permission, or an Organization Administrator.");
      case 404: return new SourceError(`${what}: not found (404${code}).`, "Check the iTwin ID and reality data ID.");
      case 422: return new SourceError(`${what}: request rejected (422${code}). ${body?.error?.message || ""}`.trim(), "Check the IDs you entered.");
      case 429: return new SourceError(`${what}: too many requests (429).`, `Wait ${res.headers.get("retry-after") || "a few"} seconds and try again.`);
      default: return new SourceError(`${what}: HTTP ${res.status}${code}.`, "Try again later. If it persists, note the time and contact Bentley support.");
    }
  }

  async function api(path, params, what, prefer) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== "") url.searchParams.set(k, v);
    const headers = { Authorization: `Bearer ${getToken()}`, Accept: ACCEPT };
    if (prefer) headers.Prefer = prefer;
    let res;
    try { res = await fetch(url, { headers }); }
    catch (e) { throw new SourceError(`${what}: could not reach api.bentley.com.`, "Check the network connection. A proxy or browser extension may be blocking it.", e); }
    if (!res.ok) throw await httpError(res, what);
    return res.json();
  }

  async function listITwins(search) {
    const r = await api("/itwins/", { $search: search || undefined, $top: 100 }, "Listing iTwins");
    return (r.iTwins || []).map((t) => ({ id: t.id, displayName: t.displayName, number: t.number, subClass: t.subClass }));
  }

  // Reality data types CesiumJS can load as a 3D Tiles tileset (from ITwinData.createTilesetForRealityDataId, 1.145).
  const TILES_TYPES = ["Cesium3DTiles", "RealityMesh3DTiles", "Terrain3DTiles", "PNTS", "GS_3DT"];

  async function listRealityData(iTwinId, showAll) {
    const out = [];
    let r = await api("/reality-management/reality-data/",
      { iTwinId, $top: 500, types: showAll ? undefined : TILES_TYPES.join(",") }, "Listing reality data", "return=representation");
    for (let page = 0; ; page++) {
      out.push(...(r.realityData || []));
      const next = r._links?.next?.href;
      if (!next || page >= 9) break; // up to 5000 items is plenty for a picker
      const u = new URL(next);
      r = await api(u.pathname, Object.fromEntries(u.searchParams), "Listing reality data", "return=representation");
    }
    return out.map((d) => ({ id: d.id, displayName: d.displayName, type: d.type, rootDocument: d.rootDocument,
                             loadable: TILES_TYPES.includes(d.type), modifiedDateTime: d.modifiedDateTime }));
  }

  // Map the generic errors thrown by ITwinData/ITwinPlatform (CesiumJS 1.145) to cause and fix.
  function describeITwinDataError(e) {
    const m = e?.message || String(e);
    if (/Unauthorized/i.test(m)) return new SourceError("Loading reality data: token rejected (401).", "Sign in again, or paste a fresh token with the itwin-platform scope.", e);
    if (/forbidden/i.test(m)) return new SourceError("Loading reality data: access denied (403).", "You need the realitydata_use permission on this iTwin.", e);
    if (/not found/i.test(m)) return new SourceError("Loading reality data: not found (404).", "Check the iTwin ID and reality data ID.", e);
    if (/not a mesh type/i.test(m)) return new SourceError(`This reality data is not a 3D Tiles model (${m.split(": ").pop()}).`, "Pick an item of type Cesium3DTiles or RealityMesh3DTiles.", e);
    if (/Too many requests/i.test(m)) return new SourceError("Loading reality data: too many requests (429).", "Wait a minute and try again.", e);
    return null;
  }

  // Load through CesiumJS's own iTwin integration. rd may carry type and rootDocument from the list,
  // which saves one metadata request. Without them ITwinData fetches the metadata itself.
  async function createTileset({ iTwinId, realityDataId, type, rootDocument, tilesetOptions }) {
    if (!iTwinId || !realityDataId) throw new SourceError("iTwin ID and reality data ID are both required.", "Pick a reality data item, or fill in both IDs.");
    if (type && !rootDocument) {
      throw new SourceError("Reality data has no 3D Tiles root document.",
        "Check that the iTwin Capture job finished and produced a 3D Tiles output, or pick another item.");
    }
    Cesium.ITwinPlatform.defaultAccessToken = getToken();
    try {
      return await Cesium.ITwinData.createTilesetForRealityDataId({ iTwinId, realityDataId, type, rootDocument, tilesetOptions });
    } catch (e) {
      throw describeITwinDataError(e) || e; // tileset.json fetch errors are described by the page
    }
  }

  // ======================= Local folder =======================
  const local = { session: null, root: null, files: null, name: "" };
  const LOCAL_PREFIX = "__local__";

  async function ensureServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      throw new SourceError("This browser cannot serve local folders (no Service Worker support).",
        "Use a current Chrome, Edge or Firefox in a normal window, over https or localhost. Firefox private windows disable Service Workers.");
    }
    if (!window.isSecureContext) throw new SourceError("Local folders need a secure page.", "Open the page over https or http://localhost.");
    await navigator.serviceWorker.register("./sw.js");
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 3000);
        navigator.serviceWorker.addEventListener("controllerchange", () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
    if (!navigator.serviceWorker.controller) {
      throw new SourceError("The local file server is not active in this tab yet.",
        "Reload the page normally (a hard refresh bypasses it) and pick the folder again.");
    }
  }

  async function resolveFile(path) {
    if (local.files) return local.files.get(path) || null;
    // Directory handle: walk the path lazily, so huge tilesets do not need a full scan first.
    let dir = local.root;
    const parts = path.split("/").filter((p) => p && p !== ".");
    try {
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      return await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
    } catch { return null; }
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", async (e) => {
      const msg = e.data, port = e.ports[0];
      if (!port || msg?.type !== "local-get") return;
      if (msg.session !== local.session) { port.postMessage({ ok: false, error: "unknown-session" }); return; }
      const file = await resolveFile(msg.path);
      port.postMessage(file ? { ok: true, file } : { ok: false, error: `${msg.path} is not in the picked folder.` });
    });
  }

  // Find candidate root documents (*.json) up to two folders deep, tileset.json first.
  async function findRootCandidates() {
    const found = [];
    if (local.files) {
      for (const p of local.files.keys()) if (p.toLowerCase().endsWith(".json") && p.split("/").length <= 3) found.push(p);
    } else {
      async function walk(dir, prefix, depth) {
        for await (const [name, h] of dir.entries()) {
          if (h.kind === "file" && name.toLowerCase().endsWith(".json")) found.push(prefix + name);
          else if (h.kind === "directory" && depth < 2) await walk(h, prefix + name + "/", depth + 1);
          if (found.length > 200) return;
        }
      }
      await walk(local.root, "", 0);
    }
    const score = (p) => (p.toLowerCase().endsWith("tileset.json") ? 0 : 1) * 10 + p.split("/").length;
    return found.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
  }

  function newSession(name) {
    local.session = Math.random().toString(36).slice(2, 10);
    local.name = name;
  }

  // Folder picker through showDirectoryPicker (Chrome, Edge). Callers check hasDirectoryPicker first and
  // otherwise use <input type="file" webkitdirectory>. The picker opens before any other await, because
  // browsers only allow it during the click's user activation.
  const hasDirectoryPicker = typeof window.showDirectoryPicker === "function";
  async function pickFolder() {
    let handle;
    try { handle = await window.showDirectoryPicker({ id: "tileset", mode: "read" }); }
    catch (e) {
      if (e.name === "AbortError") throw new SourceError("No folder was picked.", "Click Choose folder and pick the folder that contains tileset.json.");
      throw e;
    }
    await ensureServiceWorker();
    local.root = handle; local.files = null; newSession(handle.name);
  }

  // Fallback: a FileList from <input webkitdirectory>. Paths are relative to the picked folder.
  async function useFileList(fileList) {
    await ensureServiceWorker();
    if (!fileList?.length) throw new SourceError("The picked folder is empty.", "Pick the folder that contains tileset.json.");
    const files = new Map();
    let name = "";
    for (const f of fileList) {
      const rel = f.webkitRelativePath || f.name;
      const cut = rel.indexOf("/");
      if (!name) name = cut > 0 ? rel.slice(0, cut) : "";
      files.set(cut > 0 ? rel.slice(cut + 1) : rel, f);
    }
    local.root = null; local.files = files; newSession(name);
  }

  function localUrl(rootDocument) {
    if (!local.session) throw new SourceError("No local folder picked.", "Click Choose folder first.");
    const base = new URL(`./${LOCAL_PREFIX}/${local.session}/`, location.href);
    return new URL(rootDocument.split("/").map(encodeURIComponent).join("/"), base).href;
  }

  window.OrthoSources = {
    SourceError,
    itwin: { clientId, redirectUri, scope, handleRedirect, signIn, signOut, setPastedToken, sessionInfo,
             listITwins, listRealityData, createTileset },
    local: { hasDirectoryPicker, pickFolder, useFileList, ensureServiceWorker, findRootCandidates, localUrl, get name() { return local.name; },
             get picked() { return !!local.session; } },
  };
})();
