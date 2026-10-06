# Slack

A Discord-style chat platform: communities with text channels, real-time messaging, images, profile photos, moderators and a moderation bot.

- **Desktop** — Electron + TypeScript for Windows, macOS and Linux.
- **Mobile** — the same TypeScript UI wrapped with [Capacitor](https://capacitorjs.com) for Android and iOS.
- **Server** — Node.js + TypeScript WebSocket server, no database required (JSON-file persistence).

> The name "Slack" is a trademark of Salesforce. It's fine for a personal project, but pick a different name before publishing the apps publicly or to an app store. To rename: `name`/`productName` in `package.json`, `appId`/`productName` in `electron-builder.yml`, `appId`/`appName` in `capacitor.config.json`, and the `<title>` in `src/renderer/index.html` (the Android/iOS projects pick the name up on `npx cap sync`).

## Quick start

Requires Node.js 22+.

```bash
npm install

# Terminal 1 – the server (ws://localhost:3001)
npm run server

# Terminal 2 – the desktop app
npm start
```

Create an account on the login screen. Every new user automatically joins the **Public Square** community. Use **+** in the left rail to create your own community or join one with an invite code (the copy button next to the community name copies it).

## Features

- Communities (guilds) with text channels, invite codes, unread markers and a member list with online status
- **Images** — attach up to 4 photos per message with the paperclip, by pasting, or by dragging them in. Big photos are downscaled in the app before upload (phone shots are often 10 MB+). Click an image to open it full size. PNG, JPEG, GIF and WebP; GIFs are sent untouched so they stay animated.
- **Profiles** — display name, "about me", a profile photo (cropped to a square) or a coloured initials avatar, and password change. Changes show up instantly for everyone who shares a community with you. Click any avatar, name or member to see their profile.
- **Better communities** — an icon and description, rename/delete channels, a regenerable invite code, leave or delete a community, and a settings dialog (the gear next to the community name).
- **Moderation** — three roles: *owner*, *moderator* and *member*. Moderators can create/rename/delete channels, delete any message, mute, kick and ban members, regenerate the invite and run the bot. Only the owner can promote moderators, edit the community or delete it. Nobody can act on the owner, and moderators can't act on each other.
- **Guardian, the moderation bot** — built into every community and managed from *Community settings → Bot*:
  - welcomes new members
  - auto-moderation: blocked words, link blocking and anti-spam (owners and moderators are exempt)
  - slash commands: `/help`, `/ping`, `/roll 2d6`, `/flip`, `/members`, plus moderator-only `/purge N`, `/mute @name [minutes]`, `/unmute @name`, `/kick @name`
- **App settings** (per device) — dark / light / system theme, font size, cozy or compact messages, 12/24-hour clock, and desktop notifications for messages that arrive while the app is in the background
- Responsive layout: on phones the channel list and member list become slide-in drawers and settings open full-screen

## Project layout

```text
src/
  main/        Electron main process (window, security, IPC)
  preload/     Sandboxed bridge exposed to the renderer as window.slack
  renderer/    UI shared by desktop and mobile (plain TypeScript + CSS, bundled with esbuild)
  shared/      Wire protocol types used by both client and server
server/src/    WebSocket server and data store
android/ ios/  Capacitor native projects (generated, safe to commit)
build/         Desktop icons (icon.svg is the source of truth)
assets/        Generated source art for the mobile icons and splash screens
scripts/       Build, icon generation and launcher scripts
.github/workflows/build.yml   CI: desktop installers, Android APK, iOS IPA, server bundle
```

## Scripts

| Command                 | What it does                                                    |
| ----------------------- | --------------------------------------------------------------- |
| `npm start`             | Build and launch the desktop app                                |
| `npm run server`        | Build and run the server                                        |
| `npm run server:dev`    | Run the server with auto-reload                                 |
| `npm run typecheck`     | Type-check main, renderer and server                            |
| `npm run icons`         | Regenerate every icon from `build/icon.svg`                     |
| `npm run icons:mobile`  | Also regenerate the Android and iOS icon/splash sets            |
| `npm run dist:win`      | Windows installer (NSIS) + portable `.exe`                      |
| `npm run dist:mac`      | macOS `.dmg` + `.zip` (Intel and Apple Silicon)                 |
| `npm run dist:linux`    | Linux `.AppImage` + `.deb`                                      |
| `npm run mobile:sync`   | Build the UI and copy it into the Android and iOS projects      |
| `npm run mobile:android`| Sync, then open the project in Android Studio                   |
| `npm run mobile:ios`    | Sync, then open the project in Xcode (macOS only)               |

Desktop installers are written to `release/`. Build each desktop target on its own OS (macOS builds need macOS); CI does this for you.

## Mobile

The renderer is the same code as the desktop app. After changing anything in `src/renderer`, run `npm run mobile:sync` to copy it into the native projects.

- **Android** — needs Android Studio (or JDK 21 + the Android SDK). Open it with `npm run mobile:android`, or build a debug APK with `cd android && ./gradlew assembleDebug`.
- **iOS** — needs a Mac with Xcode. Open it with `npm run mobile:ios`. To run on a real device or publish, set your Apple development team under *Signing & Capabilities*.

Connecting to the server from a phone:

- Enter the server as `host:port` — the app adds `ws://` for you. Use `wss://` for any server on the internet.
- **Android emulator:** `10.0.2.2:3001` (the default there). **iOS simulator:** `localhost:3001`.
- **A real phone** needs your computer's LAN address, e.g. `192.168.1.20:3001`, and the server must be reachable (allow port 3001 through the firewall).
- Picking photos uses the system picker on both platforms. Plain `ws://` is allowed on both platforms so you can develop against a local server. Use TLS (`wss://`) in production.

## CI

[`.github/workflows/build.yml`](.github/workflows/build.yml) runs on every push to `main`, every pull request and on demand, and uploads these workflow artifacts:

| Job     | Artifact       | Contents                                                       |
| ------- | -------------- | -------------------------------------------------------------- |
| Desktop | `slack-Linux`  | `.AppImage`, `.deb`                                            |
| Desktop | `slack-Windows`| NSIS installer and portable `.exe`                             |
| Desktop | `slack-macOS`  | `.dmg` and `.zip` (Intel + Apple Silicon)                      |
| Android | `slack-Android`| debug-signed `.apk` (installable on any device)                |
| iOS     | `slack-iOS`    | **unsigned** `.ipa`                                            |
| Server  | `slack-server` | self-contained `index.js`, run with `node`                     |

Nothing is code-signed yet:

- Windows SmartScreen and macOS Gatekeeper warn on first launch of the desktop builds.
- The Android APK is debug-signed. For Google Play you need a release keystore and an `.aab` (`./gradlew bundleRelease`).
- The iOS `.ipa` is unsigned: it must be re-signed (AltStore, Sideloadly, or your own certificate) before it installs. App Store / TestFlight needs an Apple Developer account, a signing certificate and a provisioning profile.

## Server

```bash
PORT=3001 DATA_FILE=data/slack.json ADMIN_USERNAMES=alice npm run server
```

| Variable          | Default                  | Description                                                                  |
| ----------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `PORT`            | `3001`                   | Listening port (`GET /health` for a health check)                            |
| `DATA_FILE`       | `data/slack.json`        | JSON persistence file; set to empty for in-memory                            |
| `UPLOAD_DIR`      | `<DATA_FILE dir>/uploads`| Where uploaded images are stored                                            |
| `ADMIN_USERNAMES` | *(none)*                 | Comma-separated usernames that moderate the Public Square (it has no owner)  |

Images are uploaded over HTTP (`POST /upload`, authorised with your session token) and served from `GET /files/<id>`; everything else uses the WebSocket. Uploads are identified by their bytes (never the `Content-Type`), SVG is rejected, files get random unguessable ids, and uploads that are never attached to anything are deleted after an hour. Limits: 2 MB for avatars and icons, 8 MB for message images. Anyone who has an image's link can open it, so don't treat images as private.

`npm run build:server` produces a self-contained `dist/server/index.js` that runs with just `node`. Put it behind a TLS reverse proxy and connect clients with `wss://your-host`.

Passwords are hashed with scrypt, sessions use random tokens (changing your password signs out your other devices), input is validated, and each connection is rate limited.

## Protocol

All frames are JSON objects with a `type` field. The full list of events lives in [`src/shared/protocol.ts`](src/shared/protocol.ts).

## Roadmap

Direct messages, message editing, custom roles and per-channel permissions, non-image file uploads, voice channels (WebRTC), push notifications on mobile, a real database or object storage for images, auto-update and code signing.

## License

MIT
