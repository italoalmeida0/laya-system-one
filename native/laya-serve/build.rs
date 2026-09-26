// Build script: on Apple targets, compile stub definitions for the
// Foundation/CoreML symbols that ORT's static lib references (CoreML EP,
// which laya-serve never calls — CPU only). This lets us link macOS
// binaries WITHOUT the Xcode SDK (zig cc + plain libSystem), the same
// way Go projects cross-compile to darwin with zig cc.
//
// The stub source (apple-stubs/stubs.c) is auto-generated from the
// undefined ObjC symbols in libonnxruntime.a. Regenerate with:
//   llvm-nm <libonnxruntime.a> | grep " U _OBJC\| U _NS\| U _ML\| U _CF..." 
use std::env;

fn main() {
    let target = env::var("TARGET").unwrap_or_default();
    // Only for Apple targets: compile stubs.c into the binary.
    if target.contains("apple") {
        cc::Build::new()
            .file("apple-stubs/stubs.c")
            .compile("apple_stubs");
        // NOTE: we intentionally do NOT pass -framework Foundation/CoreML.
        // The stubs satisfy the linker; at runtime the CoreML EP code path
        // is never reached (CPU ExecutionProvider only).
        println!("cargo:rustc-link-arg=-Wl,-dead_strip");
    }
}
