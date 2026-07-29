fn main() {
    println!("cargo:rerun-if-env-changed=OCODE_FORGE_URL");
    tauri_build::build();
}
