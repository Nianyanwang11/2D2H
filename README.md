# Live Math Notebook

A handwriting math notebook for iPad and Apple Pencil, made for calculus classes.

- Write math by hand. Lines with "=" are read, and every number gets a slider.
- Sketch a curve on a 2D graph and it becomes the closest elementary function (y = x² − 2, y = 2 sin x, y = 2/x …).
- Draw on a 3D graph the way a textbook does. A circle becomes a sphere, z = ±√(r² − x² − y²). The app also knows cones, cylinders, paraboloids, hyperboloids, saddles, boxes and planes. Curves drawn along x and y become a surface z = f(x, y).
- Multivariable tools work on any surface: partial derivatives, level curves, gradient field, tangent plane, double integrals.
- Lock a graph to write over it. Pages, folders, PDF import and export.

## Putting it on your iPad

There are two versions. Both are built from the same page.

### 1. The web app (no computer needed)

1. On the iPad, open **https://nianyanwang11.github.io/2D2H/** in Safari. If you rename the repository, use the new name in the link.
2. Tap **Share → Add to Home Screen**.

It opens full screen with its own icon. After the first visit it works offline, and it updates itself when you're online.

### 2. The native iPad app

The native app adds what a web page can't do:

- **Apple Pencil double-tap and squeeze** switch between pen and eraser, following Settings → Apple Pencil.
- **Scribble** is kept from turning your ink into typed text.
- Exports open the **share sheet** (Save to Files, AirDrop, GoodNotes …).

Every push to `main` builds the app on a Mac in GitHub's cloud. The `LiveMath-unsigned.ipa` file is attached to the **latest** release (Releases on the right of the repository page). Apple only lets an app onto an iPad once it has been signed with an Apple ID. Without a Mac, the free way to do that is **Sideloadly** on Windows:

1. Install **iTunes** (from apple.com, not the Microsoft Store) and **Sideloadly** (sideloadly.io) on your PC.
2. Download `LiveMath-unsigned.ipa` from the latest release.
3. Connect the iPad with a cable and tap **Trust** on the iPad.
4. In Sideloadly, choose the .ipa, type your own Apple ID, and press **Start**. You sign in yourself; nothing is stored in this repository.
5. On the iPad, go to **Settings → General → VPN & Device Management** and trust your Apple ID.
6. On iPadOS 16 and later, also turn on **Settings → Privacy & Security → Developer Mode** and restart.

With a free Apple ID the app has to be signed again every 7 days. Your notebooks are kept when you reinstall over the old copy. With a paid Apple Developer account ($99/year) builds can go to TestFlight instead and last 90 days; that needs signing certificates added as repository secrets.

On a Mac with Xcode, you can also build it yourself: `python3 build.py`, then `cd ios && xcodegen generate`, open `LiveMath.xcodeproj`, pick your team and run it on the iPad.

## Handwriting reading

Inside Claude, handwriting is read through your Claude account. In the web app and the iPad app it's read with your own **Anthropic API key**:

1. Make a key at console.anthropic.com.
2. In the app, open **⋯ → Handwriting reading** and paste the key.

The key stays on that device and is sent only to Anthropic. Each line read costs a fraction of a cent on your API account. Everything else works without a key: writing, sketch → function, 3D drawing, sliders on drawn graphs, and the graph tools.

## Project layout

| Path | What it is |
|---|---|
| `src/` | The app: `app.js` (notebook, graphs, input), `math.js` (parser, derivatives), `sketchfit.js` (sketch → function), `solidfit.js` (drawing → 3D graph), `font.js` (handwriting font), `shell.html` (page and styles), `sw.js` (offline cache) |
| `build.py` | Builds `web/index.html` (iPad and web app) and `dist/claude.html` (the version for Claude) |
| `web/` | The web app as published: page, icons, manifest, offline cache |
| `ios/` | The native iPad app: Swift sources and the XcodeGen spec `project.yml` |
| `.github/workflows/` | `ios.yml` builds the .ipa, `pages.yml` publishes the web app |

After changing anything in `src/`, run `python3 build.py` and commit `web/`.

## One-time GitHub setup

- **Settings → Pages → Build and deployment → Source: GitHub Actions** turns on the web app.
- **Settings → Actions → General → Workflow permissions: Read and write** lets the build post the .ipa to Releases.
