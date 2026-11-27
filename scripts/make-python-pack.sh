#!/usr/bin/env bash
# Assembles the native Python pack (Android arm64) from a finished CPython cross build.
# Usage: make-python-pack.sh <minor e.g. 3.14> <full e.g. 3.14.10>
set -euo pipefail
VER="$1"; FULL="$2"
P=cpython/cross-build/aarch64-linux-android/prefix
test -x "$P/bin/python$VER" || { echo "missing $P/bin/python$VER"; ls -R "$P/bin" | head -20; exit 1; }
rm -rf pack wheels && mkdir -p pack/python/bin pack/python/lib wheels
cp "$P/bin/python$VER" pack/python/bin/
ln -s "python$VER" pack/python/bin/python3
ln -s python3 pack/python/bin/python
cp -a "$P"/lib/lib*.so* pack/python/lib/          # libpython + bundled openssl/sqlite/xz/bzip2/ffi shared libraries
[ -d "$P/lib/ossl-modules" ] && cp -a "$P/lib/ossl-modules" pack/python/lib/ || true
cp -a "$P/lib/python$VER" pack/python/lib/
# trim what a phone does not need
S="pack/python/lib/python$VER"
rm -rf "$S"/test "$S"/idlelib "$S"/tkinter "$S"/turtledemo "$S"/turtle.py "$S"/ensurepip "$S"/config-* "$S"/lib2to3 || true
find "$S" -type d \( -name test -o -name tests \) -prune -exec rm -rf {} + || true
find pack/python -type d -name __pycache__ -prune -exec rm -rf {} + || true
rm -rf "$S"/site-packages && mkdir -p "$S/site-packages"
# pip (pure Python wheel): ensurepip is disabled in the Android build, so unpack it ourselves
python3 -m pip download pip --no-deps --only-binary=:all: -d wheels -q
python3 -c "import glob,zipfile;zipfile.ZipFile(glob.glob('wheels/pip-*.whl')[0]).extractall('$S/site-packages')"
printf '#!/system/bin/sh\nexec "$(dirname "$0")/python3" -m pip "$@"\n' > pack/python/bin/pip
chmod 755 pack/python/bin/pip
STRIP="$(find "${ANDROID_HOME:-/nonexistent}/ndk" -name llvm-strip -type f 2>/dev/null | head -1 || true)"
if [ -n "$STRIP" ]; then
  find pack/python -type f \( -name '*.so' -o -name '*.so.*' -o -name "python$VER" \) -exec "$STRIP" --strip-unneeded {} + 2>/dev/null || true
fi
NAME="python-$FULL-android-arm64.tar.gz"
tar --format=gnu -czf "$NAME" -C pack python
sha256sum "$NAME" > "$NAME.sha256"
ls -lh "$NAME"; du -sh pack/python; cat "$NAME.sha256"
