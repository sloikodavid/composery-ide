# Persistent emulator Chrome

The live-test helper starts emulators with `-read-only -no-snapshot-save`. This is
the right default for disposable test runs, but every guest-disk change from such a
run is discarded on exit. Update a writable base AVD, stop it cleanly, and then boot
read-only test instances from that updated base.

On the current Windows development machine the base is
`Medium_Phone_API_36.1`, backed by the Google Play x86_64 API 36.1 system image.
Use the same procedure with an explicitly named Google Play AVD elsewhere.

Google account credentials and tokens live in the AVD user-data image under
`%USERPROFILE%\.android\avd`, outside this repository. Never copy or export that AVD,
print `dumpsys account`, or retain post-login screenshots/UI dumps. Keep the test
account out of documentation and Git.

## Update the persistent base

1. Check attached devices and stop every instance of the target AVD:

   ```powershell
   node .agents/skills/android-live-test/scripts/android.mjs status
   ```

2. In Android Studio's SDK Manager, update Android Emulator, Android SDK
   Platform-Tools, and the target AVD's Google Play system image when updates exist.
   Updating the system image alone does not guarantee a current Play-distributed
   Chrome.

3. Start the target AVD normally from Android Studio's Device Manager. Do not use
   `android.mjs boot`, `-read-only`, or `-wipe-data`. Only one writable instance of
   that AVD may run.

   The equivalent Windows command for the current base is:

   ```powershell
   & "$env:USERPROFILE\AppData\Local\Android\Sdk\emulator\emulator.exe" `
     -avd Medium_Phone_API_36.1 -no-snapshot-save
   ```

4. The persistent base may already be signed in to Google Play. Reuse that session
   without printing its account identifier or capturing account/Store UI. Ask the
   user to authenticate only if Google requires it. In
   **Play Store > profile > Manage apps & device**, update all apps; check the store
   page for **Google Chrome**.

5. Find the emulator serial, reboot, and wait for Android to finish:

   ```powershell
   $adb = "$env:USERPROFILE\AppData\Local\Android\Sdk\platform-tools\adb.exe"
   & $adb devices -l
   & $adb -s emulator-5554 reboot
   & $adb -s emulator-5554 wait-for-device
   ```

   Replace `emulator-5554` with the serial actually reported on this run.

6. Check the active artifacts, not the system image or store UI:

   ```powershell
   & $adb -s emulator-5554 shell dumpsys package com.android.chrome |
     Select-String "versionName="
   ```

7. Stop the writable emulator cleanly from Device Manager or its window. Wait for
   its process to exit before starting a test instance. Do not wipe its data.

## Use the updated base for testing

Start a disposable read-only instance and use the printed serial on every command:

```powershell
node .agents/skills/android-live-test/scripts/android.mjs boot Medium_Phone_API_36.1
node .agents/skills/android-live-test/scripts/android.mjs status --serial emulator-5556
```

At the start of browser-sensitive work, record:

```powershell
$adb = "$env:USERPROFILE\AppData\Local\Android\Sdk\platform-tools\adb.exe"
& $adb -s emulator-5556 shell dumpsys package com.android.chrome |
  Select-String "versionName="
```

The base remains updated across emulator runs. Updates installed inside a read-only
test instance do not. Repeat the writable maintenance launch before Chromium-sensitive
investigations or when Play offers a newer stable release.
