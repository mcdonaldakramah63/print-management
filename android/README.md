# Receipt Admin (Android)

The admin's phone app for the Receipt System: a summary of each shop that
works even when the shop PC is off, alerts, and the shop's full admin web app.
Plain Java on the Android framework, no libraries. Android 8.0 or newer.

## Get the APK

GitHub Actions builds it on every change under `android/`: open the latest
**Android app** run and download the `ReceiptAdmin-android` artifact
(`ReceiptAdmin.apk`). Copy it to the phone and open it; Android asks to
allow installing apps from that source once.

Put a copy beside `ReceiptSystem.exe` on the shop PC and the pairing page
offers it as a download (`/download/ReceiptAdmin.apk`).

## Build it yourself

Needs JDK 17 and the Android SDK (Android Studio has both):

```bash
cd android
gradle assembleRelease          # Gradle 8.7+, or open the folder in Android Studio
# app/build/outputs/apk/release/app-release.apk
```

## Signing

APKs are signed with `sideload.keystore` (password `receiptadmin`), committed
here so every build can update the last one. It is public, so for a shop
that matters, use your own key:

```bash
keytool -genkeypair -keystore my.keystore -alias admin -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 my.keystore   # paste into the ANDROID_KEYSTORE_BASE64 secret
```

Add the repository secrets `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`
(locally: `RELEASE_KEYSTORE`, `RELEASE_KEYSTORE_PASSWORD`,
`RELEASE_KEY_ALIAS`, `RELEASE_KEY_PASSWORD`). Android won't install an APK
signed with a different key over an existing one: uninstall the sideload
build once when switching.

## Inside

| File | |
|---|---|
| `MainActivity.java` | Two web views: the bundled shell, and the shop's web app (cookies, printing, uploads, downloads, back button, pairing links) |
| `Shops.java` | Paired shops; reads QR links, connection codes and plain addresses |
| `Pulse.java` | Fetches `__status` and the encrypted `__pulse`, decrypts it (AES-256-GCM) |
| `Alerts.java`, `PulseJobService.java` | Checks every 15 minutes and notifies once per new problem |
| `assets/shell/` | Shops, pairing and the offline summary, in the Receipt System design system |

The shell is the only page with the app bridge (`Shell`). The shop's pages
get just `ReceiptApp.print()` and `ReceiptApp.home()`.
