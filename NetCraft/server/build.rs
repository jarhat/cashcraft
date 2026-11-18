fn main() {
    let mut build = cc::Build::new();
    build.include("../deps/noise").include("../src");
    build.file("../deps/noise/noise.c");
    for file in [
        "world.c",
        "base_terrain.c",
        "biome_desert.c",
        "biome_rainforest.c",
        "biome_taiga.c",
        "biome_temperate.c",
    ] {
        build.file(format!("../src/worldgen/{file}"));
    }
    build.flag_if_supported("-std=c99").compile("terrain");
    println!("cargo:rerun-if-changed=../src/worldgen");
    println!("cargo:rerun-if-changed=../deps/noise");
}
