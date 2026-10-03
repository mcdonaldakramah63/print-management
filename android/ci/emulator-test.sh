#!/usr/bin/env bash
# CI: installs Receipt Admin on an emulator and walks through it: the empty
# shell, pairing by deep link (through a real relay), signing in to the
# shop's web app, back to the shop list (encrypted snapshot decrypted on the
# device), then the shop PC going offline. Screenshots go to shots/.
set -uo pipefail
APK=$1
PKG=com.receiptsystem.admin
mkdir -p shots
fail() { echo "::error::$1"; adb logcat -d -t 400 > shots/logcat.txt 2>&1; exit 1; }
ui() { adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1; adb shell cat /sdcard/ui.xml; }
texts() { ui | grep -o 'text="[^"]*"\|content-desc="[^"]*"' | sed 's/^[a-z-]*="//;s/"$//' | grep -v '^$'; }
shot() { adb exec-out screencap -p > "shots/$1.png"; }
expect() { # expect <label> <pattern> [tries]
  for i in $(seq 1 "${3:-20}"); do
    if texts | grep -qiE "$2"; then echo "OK: $1"; return 0; fi
    sleep 2
  done
  echo "--- screen text ---"; texts | head -60
  shot "fail-$1"; fail "$1: '$2' not on screen"
}
tap_text() { # tap the centre of the first node whose text matches
  local b
  b=$(ui | grep -o "text=\"$1\"[^>]*bounds=\"[^\"]*\"" | head -1 | grep -o 'bounds="[^"]*"' | grep -o '[0-9]\+')
  [ -n "$b" ] || fail "no '$1' to tap"
  set -- $b
  adb shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))
}
crashed() { adb logcat -d | grep -q "FATAL EXCEPTION" && { adb logcat -d | grep -A 30 "FATAL EXCEPTION" | head -50; return 0; }; return 1; }

adb install -r "$APK" || fail "install failed"
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null || true
adb logcat -c

adb shell am start -W -n $PKG/.MainActivity
expect "shell opens" "Connect your shop"
shot 01-empty
crashed && fail "crashed on start"

ENC_URL=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$SHOP_URL")
adb shell "am start -W -a android.intent.action.VIEW -d 'receiptadmin://connect?u=$ENC_URL&k=$SHOP_KEY&n=CI%20Shop' $PKG"
expect "web app sign-in through the relay" "Sign in"
shot 02-login

# Sign in: username has autofocus; TAB to the password; Enter submits.
adb shell input text admin
adb shell input keyevent 61
adb shell input text 'Str0ng-pass'
adb shell input keyevent 66
expect "dashboard after sign-in" "Dashboard" 25
sleep 3
shot 03-dashboard

adb shell input keyevent 4   # back: out of the web app to the shops
expect "shop list with the decrypted summary" "CI Shop" 15
expect "shop online" "Online" 15
expect "today's sales from the snapshot" "50\.00" 15
shot 04-shops
crashed && fail "crashed"

# Shop PC goes off: the summary still shows its last update.
kill "$SHOP_PID" 2>/dev/null || true
sleep 8
tap_text "CI Shop"
expect "offline summary" "offline" 20
shot 05-offline
crashed && fail "crashed"

adb shell input keyevent 4
adb shell input keyevent 4
sleep 1
adb logcat -d -t 400 > shots/logcat.txt 2>&1
echo "Emulator walkthrough passed"
