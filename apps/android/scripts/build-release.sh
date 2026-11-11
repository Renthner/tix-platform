#!/usr/bin/env bash
# Builds the signed, minified (R8) release APK of the check-in app.
#
# Usage:   scripts/build-release.sh <versionName> <versionCode>
# Example: TIX_KEYSTORE_FILE=/secure/tix.jks TIX_KEYSTORE_PASSWORD=... TIX_KEY_ALIAS=tix \
#          TIX_KEY_PASSWORD=... scripts/build-release.sh 1.2.0 12
#
# Requires JAVA_HOME (JDK 17+, e.g. Android Studio's jbr) and ANDROID_HOME. The signing data comes
# from the TIX_KEYSTORE_* environment variables (never from the repository). versionCode must be a
# positive integer higher than the previous release.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <versionName> <versionCode>" >&2
  exit 2
fi
VERSION_NAME="$1"
VERSION_CODE="$2"
if ! [[ "$VERSION_NAME" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "versionName must look like 1.2.0" >&2; exit 2
fi
if ! [[ "$VERSION_CODE" =~ ^[1-9][0-9]*$ ]]; then
  echo "versionCode must be a positive integer" >&2; exit 2
fi
for v in TIX_KEYSTORE_FILE TIX_KEYSTORE_PASSWORD TIX_KEY_ALIAS TIX_KEY_PASSWORD; do
  if [ -z "${!v:-}" ]; then echo "missing environment variable $v (release signing)" >&2; exit 2; fi
done
if [ ! -f "$TIX_KEYSTORE_FILE" ]; then echo "keystore not found: $TIX_KEYSTORE_FILE" >&2; exit 2; fi

cd "$(dirname "$0")/.."
# Gradle resolves a relative store path against apps/android: hand it an absolute one.
TIX_KEYSTORE_FILE="$(cd "$(dirname "$TIX_KEYSTORE_FILE")" && pwd)/$(basename "$TIX_KEYSTORE_FILE")"
export TIX_KEYSTORE_FILE

./gradlew --console=plain :core:test :app:testDebugUnitTest :app:assembleRelease \
  "-Ptix.versionName=$VERSION_NAME" "-Ptix.versionCode=$VERSION_CODE"

APK="app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || { echo "release APK was not produced" >&2; exit 1; }

# Verify the signature when the SDK build-tools are available (ANDROID_HOME or the sdk.dir that the
# Gradle build detected and wrote to local.properties).
if [ -z "${ANDROID_HOME:-}" ] && [ -f local.properties ]; then
  ANDROID_HOME="$(sed -n 's/^sdk\.dir=//p' local.properties | sed -e 's/\\\\/\//g' -e 's/\\:/:/g')"
fi
if [ -n "${ANDROID_HOME:-}" ] && [ -d "$ANDROID_HOME/build-tools" ]; then
  BT="$(ls -1 "$ANDROID_HOME/build-tools" | sort -V | tail -n 1)"
  SIGNER="$ANDROID_HOME/build-tools/$BT/apksigner"
  [ -x "$SIGNER" ] || SIGNER="$SIGNER.bat"
  "$SIGNER" verify --print-certs "$APK" 2>/dev/null | grep -E "certificate (DN|SHA-256)" || true
  "$SIGNER" verify "$APK" >/dev/null 2>&1 && echo "signature: OK" || { echo "signature: INVALID" >&2; exit 1; }
fi

echo
echo "APK:      $(pwd)/$APK"
echo "version:  $VERSION_NAME ($VERSION_CODE)"
echo "size:     $(wc -c < "$APK") bytes"
if command -v sha256sum >/dev/null 2>&1; then
  echo "sha256:   $(sha256sum "$APK" | cut -d' ' -f1)"
else
  echo "sha256:   $(shasum -a 256 "$APK" | cut -d' ' -f1)"
fi
echo
echo "Next: Admin -> Check-in devices -> Scanner app -> Upload a new version (enter the same version name and code)."
