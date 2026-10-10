#!/usr/bin/env bash
set -euo pipefail

# Run from the pinned whisper.cpp checkout. Runtime CPU selection avoids
# requiring the runner's instruction set on the user's machine.
case "$ARCH:$CPU:$METAL" in
  arm64:arm64:ON|x64:x86_64:OFF) ;;
  *) echo "Unexpected build target: $ARCH:$CPU:$METAL" >&2; exit 1 ;;
esac

cmake -B build \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES="$CPU" \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.3 \
  -DCMAKE_INSTALL_RPATH='@loader_path' \
  -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
  -DBUILD_SHARED_LIBS=ON \
  -DGGML_BACKEND_DL=ON \
  -DGGML_CPU_ALL_VARIANTS=ON \
  -DGGML_NATIVE=OFF \
  -DGGML_METAL="$METAL" \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DGGML_OPENMP=OFF \
  -DWHISPER_BUILD_IS_DEV=OFF \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_SERVER=OFF
cmake --build build --config Release --parallel "$(sysctl -n hw.logicalcpu)" \
  --target whisper-cli

bundle="whisper-bin-macos-$ARCH"
mkdir -p "package/$bundle"
shopt -s nullglob
libraries=(build/bin/*.dylib build/bin/*.so build/bin/*.metallib)
((${#libraries[@]} > 0))
cp -a build/bin/whisper-cli "${libraries[@]}" "package/$bundle/"
cp LICENSE "package/$bundle/LICENSE"
lipo "package/$bundle/whisper-cli" -verify_arch "$CPU"
tar -czf "$bundle.tar.gz" -C package "$bundle"

# Exercise the distributed layout with the build tree unavailable.
# Upstream's small test model verifies execution, not recognition accuracy.
unpacked="$RUNNER_TEMP/whisper-unpacked"
mkdir -p "$unpacked"
tar -xzf "$bundle.tar.gz" -C "$unpacked" --strip-components 1
model="$PWD/models/for-tests-ggml-base.en.bin"
audio="$PWD/samples/jfk.wav"
mv build build-unused
cd "$RUNNER_TEMP"
env -u DYLD_LIBRARY_PATH -u DYLD_FALLBACK_LIBRARY_PATH \
  "$unpacked/whisper-cli" -m "$model" -f "$audio" -ojf -of "$unpacked/result"
python3 -c 'import json, pathlib; data = json.loads(pathlib.Path("whisper-unpacked/result.json").read_text()); assert isinstance(data["transcription"], list)'