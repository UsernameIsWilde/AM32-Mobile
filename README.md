# AM32 Offline – the AM32 configurator for Android

The [am32.ca](https://am32.ca) configurator packaged as an Android app. The user interface
is inside the APK, so ESC settings can be read and changed with no internet connection at
all. Firmware is not bundled: the app downloads it from am32.ca when a connection is
available and keeps it on the phone.

## How it works

| Part | What it is |
| --- | --- |
| `android/app/src/main/assets/www` | The original configurator ([am32-firmware/am32-configurator](https://github.com/am32-firmware/am32-configurator)) built into a static site. Generated, not kept in git. |
| `LocalContent.kt` | Stands in for the am32.ca server: every request the WebView makes ends up here. Page files come from the APK, `/api/...` goes through `RemoteCache`. |
| `RemoteCache.kt` | The only place that talks to the internet (`https://am32.ca` only). Everything it downloads stays on the phone. `.hex` files are verified (Intel HEX checksums) before they are stored. |
| `UsbSerialBridge.kt` + `assets/bridge/bridge.js` | Android's WebView has no Web Serial API. `bridge.js` gives the page `navigator.serial`; the USB work is done by [usb-serial-for-android](https://github.com/mik3y/usb-serial-for-android) (CDC-ACM flight controllers, CH340, FTDI, CP210x, Prolific). |
| `FileBridge.kt` | "Downloads" from the page (an ESC configuration, a `.hex`) go to `Download/AM32`. |
| `assets/bridge/mobile.css` | Phone layout corrections, applied on top of the unmodified web app. |

### With and without internet

- **Online:** the firmware list is refreshed from am32.ca (at most every 5 minutes), so
  new releases show up right away. A file that is selected is downloaded and kept.
- **Offline:** only the firmware files that are already on the phone are listed. To flash
  in the field without a connection, download the file at least once beforehand: tap the
  `.hex` for your ESC on the **Downloads** page (or flash it once).
- Reading and changing ESC settings, saving / applying a configuration file and flashing
  from a local `.hex` file never need internet.

Downloaded files live in the app's internal storage and can be removed with
*Settings → Apps → AM32 Offline → Storage → Clear data*.

## Using it on the phone

1. Install `dist\AM32-Offline-<version>.apk` (installing from unknown sources has to be allowed).
2. Connect the flight controller or the USB serial adapter with a **USB OTG** cable or
   adapter. Android offers to open *AM32 Offline*; accept, which also grants USB access.
3. In the app: **Port select** → pick the device → **Connect** → **Read**.
   For a direct connection to a single ESC through an adapter, tick **Direct**.

The screen stays on while the app is open so that flashing is not interrupted. Do not
unplug the cable or close the app while flashing.

The strip under the logo is the log: it shows what a connection attempt is doing. The
first Connect can take a few seconds when the flight controller was left in 4-way mode.

## Building (Windows)

```powershell
powershell -ExecutionPolicy RemoteSigned -File scripts\build.ps1
```

The script builds the configurator and assembles a signed APK. Missing tools (Node 20,
JDK 17, Gradle) are downloaded into `tools\`; nothing is installed system-wide.

Settings for one computer go into `scripts\env.local.ps1` (not under version control):

```powershell
$env:AM32_ANDROID_SDK = 'D:\path\to\android-sdk'   # reuse an Android SDK that is already installed
$env:AM32_BUILD_ROOT  = 'D:\am32-android-build'    # where caches and build output go
```

- Without `AM32_ANDROID_SDK` the SDK is downloaded into `tools\android-sdk` and Google's
  licence agreements have to be accepted.
- `AM32_BUILD_ROOT` matters when the project sits on a slow or non-NTFS drive (exFAT, USB):
  `node_modules` and Gradle are unusably slow there. The folder can be deleted at any
  time; the next build recreates it.

| Command | What it does |
| --- | --- |
| `scripts\build.ps1` | Everything from scratch. |
| `scripts\build.ps1 -SkipWeb` | Android part only, keeps the web app that is already in the assets. |
| `scripts\build.ps1 -WebRef master` | Builds the newest configurator code instead of the pinned version. |

The configurator version is pinned in `scripts\build-web.ps1` (`$Ref`). When a new AM32
firmware changes the settings (EEPROM) layout, a newer configurator may be needed too:
raise `$Ref` (or use `-WebRef master`), increase `versionCode` / `versionName` in
`android\app\build.gradle.kts` and rebuild. What exactly is changed in the upstream code is
described at the top of `scripts\patch-web.mjs`; every patch asserts that the code it
replaces is still there, so an upstream change fails the build instead of going unnoticed.

### Signing key

The first build creates `android\signing\` (key and password). Android only installs an
update over an existing app when both are signed with the same key, so **keep a backup of
that folder**. Without it a new version can only be installed after removing the old one.

## Tests

Both run in a desktop browser (headless Chrome or Edge); no phone is needed.

```powershell
tools\node\node.exe tests\bridge-test.mjs <build root>\web-src
tools\node\node.exe tests\e2e-test.mjs
```

- `bridge-test` checks `bridge.js` (the `navigator.serial` replacement) with the same
  serial libraries the configurator uses and a fake USB layer.
- `e2e-test` runs the real configurator that goes into the APK on a phone sized screen
  (412 px) against a simulated flight controller with four ESCs (`tests\mock-native.js`):
  *Port select → Connect → Read → Disconnect*, icons, the firmware list from am32.ca, and
  the layout (nothing wider than the screen, ESC status dots not covering labels, fields
  not running into each other). As in the app, the page cannot reach any other host.
  Given a folder (`tests\e2e-test.mjs C:\some\folder`) it also saves phone sized
  screenshots: home, downloads, settings, Tune and Flash firmware.

`tools\node\node.exe tests\preview-server.mjs` serves the same thing for a look in a
desktop browser (`http://127.0.0.1:5173/`, or `/__android/phone?src=/configurator` for a
phone sized frame).

Not covered by the tests: the Kotlin side (real USB, flashing). That needs a phone with an
OTG cable and a device.

## Notes

- The configurator source is downloaded as an archive instead of being cloned: git refuses
  to work in a repository on an exFAT drive without a `safe.directory` exception.
- The app contains no analytics; the Matomo script of the original site is removed. The
  only host it contacts is `https://am32.ca`.
