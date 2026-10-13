# Surface Ortho Capture

Surface Ortho Capture is a browser tool for extracting orthographic images of flat surfaces from 3D Tiles models. It loads a tileset in CesiumJS and clips it to one surface. It then renders an orthographic raster of that surface at a set ground sample distance (GSD). Each raster comes with a JSON file that maps its pixels back to 3D coordinates.

The page is a static site with no backend. It holds no secrets. Access tokens stay in the browser tab's memory and are never written to disk, to the URL or to this repository.

## What it does

For each surface the page builds an oriented box around the face. You either pick points on the mesh or import boxes as JSON. The tileset is clipped to that box, so other parts of the model in front of the face cannot block it. This also works for faces that look at other geometry across a narrow gap. An orthographic camera then looks straight at the face. Image right runs along the face and image up follows the face. The page renders at the requested GSD in tiles and stitches them. It saves a PNG and a JSON sidecar that maps every pixel back to Earth-centred (ECEF) coordinates.

## Run it

You can use the hosted page or run it locally. To run it locally, serve the folder over HTTP. Opening `index.html` as a file does not work.

```
python -m http.server 8080 --bind 127.0.0.1
```

Then open `http://localhost:8080/`. The machine needs internet access because CesiumJS and the sign-in library load from public CDNs.

Keep the browser tab visible while a capture runs. Browsers pause rendering in hidden tabs, and the capture waits for rendered frames.

## Data sources

Step 1 of the page has four tabs. Each loads a 3D Tiles tileset in its own way.

### iTwin

This tab loads iTwin Capture output stored as reality data in Reality Management. Click "Sign in with Bentley" and sign in with your Bentley account. Then search for an iTwin and pick it. The page lists the reality data in that iTwin that CesiumJS can load as 3D Tiles. Pick one and click "Load model". Tick "Show all reality data types" to see every item, including ones the page cannot load.

Loading uses the iTwin integration built into CesiumJS (`ITwinData.createTilesetForRealityDataId`). It asks Reality Management for a read link to the storage container and opens the root document from there. The lists of iTwins and reality data come from the iTwins API and the Reality Management API.

For quick tests, open "Use a token instead". Paste an access token with the `itwin-platform` scope and the iTwin ID and reality data ID. When both IDs are filled in, the page uses them instead of the lists. A pasted token also works with the lists if you click "Find".

Your account needs access to the iTwin. Reading reality data needs the `realitydata_use` permission on the iTwin, or the Organization Administrator role.

### Cesium ion

Enter a Cesium ion asset ID and an access token that can read it. The `?ion=<assetId>` URL parameter fills in the asset ID.

### Local folder

Click "Choose folder" and pick the folder that contains `tileset.json`. The page lists JSON files found up to two folders deep, with `tileset.json` first. Pick the root document and click "Load model". The files are read in your browser and are not uploaded anywhere.

This works through a Service Worker (`sw.js`). The worker answers requests under a virtual path such as `./__local__/<session>/tileset.json` with the matching file from the picked folder. To CesiumJS these are ordinary URLs. Child tiles, external tilesets and textures therefore resolve the same way they would on a web server. We chose this over rewriting `tileset.json` to blob URLs. Blob URLs break relative references inside glTF files and implicit tiling templates. We also did not want to patch private CesiumJS internals.

### URL

Enter a URL to `tileset.json`. When the page runs from a local server, a relative path such as `./tiles/tileset.json` works for tiles stored next to the page. A full Reality Management read URL also works if it includes its SAS query string. The `?tileset=<url>` URL parameter loads a model on page open.

## Registering the app for iTwin sign-in

Sign-in needs an iTwin Platform app registration of type single page application. The client ID of such an app is public by design. It goes in `config.js`, or in the `?clientId=<id>` URL parameter, which overrides `config.js`. The parameter lets another organization use its own registration with the same hosted page.

To register, sign in at [developer.bentley.com](https://developer.bentley.com/) and open My Apps. Register a new app of type "Single page application". Give it access to the iTwin Platform APIs so that the `itwin-platform` scope is available. Add these redirect URIs exactly, including the trailing slash:

```
http://localhost:8080/
https://<github-user>.github.io/<repo-name>/
```

Use the same values as post logout redirect URIs. Copy the client ID into `config.js` as `itwinClientId`. If the registration lists a different scope name, set `itwinScope` in `config.js` to match. Screen and field names on the registration page may differ from this description.

The page uses OAuth 2.0 authorization code flow with PKCE (S256) through `oidc-client-ts`. The redirect target is the page itself. After sign-in the token lives in memory only. Reloading the page signs you out. There is no silent renewal. When the token expires, the page asks you to sign in again.

Two points still need confirmation from Bentley. The scope name `itwin-platform` comes from the API documentation and the CesiumJS source, but the public discovery document of ims.bentley.com does not list it. It is also unclear whether an app registered by one organization accepts sign-ins from users of another organization. If it does not, each organization can register its own app and pass its client ID with `?clientId=`.

## CORS findings

The page calls several Bentley services directly from the browser. Each one must send CORS headers for the page's origin. These results come from requests made on 13 October 2026 from `http://localhost:8080` and from a `github.io` origin.

| Service | localhost | github.io |
|---|---|---|
| api.bentley.com (iTwins, Reality Management) | allowed (`*`) | allowed (`*`) |
| Reality data blob storage (two Bentley accounts tested) | allowed | allowed |
| ims.bentley.com discovery document | allowed | no CORS header |
| ims.bentley.com token endpoint (tested with a fake client ID) | allowed | no CORS header |

The page does not need the discovery document because it ships the IMS endpoints in `sources.js`. The token endpoint is the open risk for the hosted page. Our guess is that IMS allows origins registered on the client, but this is unverified. It must be tested with the real client ID once the page is hosted. If sign-in fails there with a "token request blocked" message, the token paste option still works.

CesiumJS keeps the SAS query string on child tile requests. Its `Resource` class merges the parent's query parameters into every derived URL. The SAS link lifetime is not documented, and CesiumJS does not renew it. If tiles stop loading after a long session, load the model again.

## Browser support

| Feature | Chrome, Edge | Firefox | Safari |
|---|---|---|---|
| Viewing and capture (WebGL) | yes | expected, untested | expected, untested |
| iTwin sign-in | yes | expected, untested | expected, untested |
| Local folder with the folder dialog | yes | no | no |
| Local folder with the classic folder input | yes | expected, untested | expected, untested |

The folder dialog uses `showDirectoryPicker`, which only Chromium browsers support. Other browsers fall back to `<input webkitdirectory>`, which reads the whole folder listing first. Local folders need a Service Worker. Service Workers only run on https pages or on localhost. Firefox private windows disable them.

## Workflow in the page

Load a model in step 1. In step 2 click "Pick points" and click around the edge of one flat face in order. Click "Add surface". The plane is fitted through all points, and the normal faces the camera you picked from. "In front", "Behind" and "Margin" set the box size around the face.

In step 3, "View straight on" shows the orthographic framing. "Capture" downloads `<name>.png` and `<name>.json`. Empty pixels are transparent in the PNG. The status line turns red if any capture tile timed out or if CesiumJS reduced detail to save memory. The JSON sidecar records both cases in `complete`, `timedOutTiles` and `maxEffectiveScreenSpaceError`.

## Surface JSON

This format lets other tools supply surfaces, for example an automatic plane detector. Each surface uses this shape:

```json
{
  "name": "wall_north",
  "center": [1102345.12, -4342210.55, 4512345.67],
  "normal": [0.71, 0.70, 0.02],
  "width": 4.2,
  "height": 7.5,
  "depthFront": 0.3,
  "depthBack": 0.3
}
```

`center` is a point on the surface plane in ECEF metres. You can use `centerLonLatHeight` in degrees and metres instead. `normal` points out of the visible side of the face, toward the camera. If it points into the structure, the camera sits behind the face and the raster comes out blank. `u` is the optional image right direction. When it is omitted, image right is horizontal along the face. Paste a list into "Import or export surfaces as JSON" and click "Import". "Export list" shows the full form of boxes picked by hand.

## Pixel to 3D mapping

Every capture writes a sidecar with this mapping:

```
centre(x, y) = topLeft + u * (x + 0.5) * gsd - v * (y + 0.5) * gsd
```

It lets anything found on the raster be placed back on the 3D model.

## Headless batch (sketch, untested)

The page exposes `window.orthoCapture` so a script can drive it. `orthoCapture.loadTileset` accepts `{ url }`, `{ ionId, ionToken }` or `{ iTwinId, realityDataId, token }`. This Puppeteer example has not been run as written.

```js
const puppeteer = require("puppeteer");
const fs = require("fs");
const surfaces = JSON.parse(fs.readFileSync("surfaces.json", "utf8"));

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ["--enable-gpu", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1200 });
  await page.goto("http://localhost:8080/");
  await page.waitForFunction(() => window.orthoCapture);
  await page.evaluate((url) => orthoCapture.loadTileset({ url }), "./tiles/tileset.json");
  for (const s of surfaces) {
    const r = await page.evaluate((spec) => orthoCapture.captureSurface(spec, { gsd: 0.002 }), s);
    fs.writeFileSync(`${s.name}.png`, Buffer.from(r.pngDataUrl.split(",")[1], "base64"));
    fs.writeFileSync(`${s.name}.json`, JSON.stringify(r.meta, null, 2));
  }
  await browser.close();
})();
```

Headless Chrome on Windows used the GPU through ANGLE and Direct3D 11 in our tests. A cloud machine without a GPU would need a software renderer. We have not measured that case.

## Test status

These points were tested on 13 October 2026 with CesiumJS 1.145 in headless Chrome 154 on an NVIDIA GPU. They used a public sample tileset from the CesiumGS 3d-tiles-samples repository. Loading by relative URL and with `?tileset=` works. Loading a local folder through the Service Worker works with the classic folder input. The test supplied real files to that input path, and the folder dialog itself was not automated. Capture keeps the orthographic width at tile size times GSD. Raster size matches width and height divided by GSD, and two captures in a row render without errors. Error messages for a missing file, a rejected token, a missing root document and a missing client ID read as intended. The sign-in request uses the authorization code flow with PKCE S256 and the expected redirect URI.

These points are untested. Sign-in has not been tried with a real client ID. Loading real iTwin Capture reality data has not been tried. We do not yet know which reality data type iTwin Capture assigns to its 3D Tiles output. The token endpoint's CORS behaviour on the hosted page and the SAS link lifetime are unknown. Capture quality on CesiumJS 1.145 with textured photogrammetry still needs a check for seams, colour and detail. Firefox and Safari have not been tested.

## Known limits

Each surface is one plane. Curved faces need several narrower surfaces. Rasters above 16384 pixels on a side are refused, so raise the GSD or split the surface. Browsers may ask before allowing "Capture all" to download many files. The tool does not detect surfaces automatically or analyse the rasters.

## Dependencies

CesiumJS 1.145 (Apache-2.0) loads from cesium.com. oidc-client-ts 3.5.0 (Apache-2.0) loads from jsDelivr. The Inter font (SIL Open Font License) loads from Google Fonts. There is no build step.

The interface uses the design tokens of Bentley's StrataKit design system (MIT). `vendor/stratakit-tokens.css` holds the CSS custom properties from `@stratakit/foundations` 1.0.3 with its licence notice. The StrataKit components themselves are React components, so this page styles its own plain HTML controls with those tokens instead.
"# Surface-Ortho" 
