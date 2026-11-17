cmake_minimum_required(VERSION 3.16)

project(craft)

FILE(GLOB SOURCE_FILES src/*.c)
FILE(GLOB SOURCE_WORLDGEN_FILES src/worldgen/*.c)
#FILE(GLOB SOURCE_AUDIO_FILES src/html5_mixer/src/*.c)

if (EMSCRIPTEN)
    add_executable(
        craft
        ${SOURCE_FILES}
        ${SOURCE_WORLDGEN_FILES}
        #${SOURCE_AUDIO_FILES}
        deps/lodepng/lodepng.c
        deps/miniz/miniz.c
        deps/noise/noise.c
        deps/tinycthread/tinycthread.c)
    # Generate HTML file wrapper in addition to .js
    set(CMAKE_EXECUTABLE_SUFFIX ".html")
else ()
    FILE(COPY textures DESTINATION .)
    FILE(COPY shaders DESTINATION .)
    add_executable(
        craft
        ${SOURCE_FILES}
        ${SOURCE_WORLDGEN_FILES}
        deps/glew/src/glew.c
        deps/lodepng/lodepng.c
        deps/miniz/miniz.c
        deps/noise/noise.c
        deps/sqlite/sqlite3.c
        deps/tinycthread/tinycthread.c)
endif ()

add_definitions(-std=gnu23)
if (EMSCRIPTEN)
    add_definitions(-msimd128)
endif ()
# add_definitions(-DLODEPNG_NO_COMPILE_ZLIB)

set_property(SOURCE ${SOURCE_FILES} PROPERTY COMPILE_FLAGS "-Wall -Wextra -pedantic -Wno-unused-parameter -Wno-missing-field-initializers -Wno-sign-compare")

if ($ENV{CIRCLECI})
    add_definitions(-DBUILD_NUM="$ENV{CIRCLE_BUILD_NUM}")
    string(SUBSTRING "$ENV{CIRCLE_SHA1}" 0 10 TRUNCATED_CIRCLE_SHA1)
    add_definitions(-DBUILD_COMMIT="${TRUNCATED_CIRCLE_SHA1}")
    add_definitions(-DBUILD_BRANCH="$ENV{CIRCLE_BRANCH}")
endif()

if (DEBUG)
    add_definitions("-fsanitize=address -fsanitize=undefined -g")
    set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS "-fsanitize=address -fsanitize=undefined -g")
endif ()

if (EMSCRIPTEN)
    add_definitions(-DNO_CRAFT_AUTH)

    # Emscripten default is GLFW 2.x but we use GLFW 3.x
    set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS "-s USE_GLFW=3")

    # Customize the shell file loader
    set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " --pre-js ${CMAKE_SOURCE_DIR}/src/pre.js --shell-file ${CMAKE_SOURCE_DIR}/src/shell.html")
    set_property(TARGET craft APPEND PROPERTY LINK_DEPENDS
        "${CMAKE_SOURCE_DIR}/src/pre.js" "${CMAKE_SOURCE_DIR}/src/shell.html")

    # Increase memory limit from 16 MB default
    set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -s TOTAL_MEMORY=33554432")
    set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -s STACK_SIZE=8388608")

    set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -s ALLOW_MEMORY_GROWTH -s MAXIMUM_MEMORY=536870912")
    #set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -s AUDIO_WORKLET=1")
    #set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -s WASM_WORKERS=1")
    # C functions callable from JavaScript
    set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -s EXPORTED_RUNTIME_METHODS=\"['cwrap','ccall','HEAP8']\"")
    #set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS "  -s USE_PTHREADS=1")

    set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -lwebsocket.js")
    set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -lidbfs.js")
    set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -s USE_WEBGL2=1")
    set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -s MIN_WEBGL_VERSION=2")
    set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -s MAX_WEBGL_VERSION=2")
    #set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -s USE_PTHREADS=1")
    #set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -sPROXY_POSIX_SOCKETS")
    #set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -pthread")
    #set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -sPROXY_TO_PTHREAD")

    #set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -s WEBSOCKET_URL=\"ws://127.0.0.1:4081/\"")

    #get_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -s WEBSOCKET_SUBPROTOCOL=\"['binary']\"")

    # C functions callable from JavaScript
    set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -s EXPORTED_FUNCTIONS=\"['_main','_is_typing']\"")

    #set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -s USE_SDL")

    #set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -s USE_SDL_MIXER=2")

    #set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " --memory-init-file=0")

    if (CMAKE_BUILD_TYPE MATCHES "Release")
        set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -O3")

        # Generate a .data file preloaded with shaders and textures
        set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " --preload-file ${CMAKE_SOURCE_DIR}/shaders@/shaders --preload-file ${CMAKE_SOURCE_DIR}/textures@/textures")
    else ()
        message("warning: embedding data files in .js, for a smaller build rerun cmake with -CMAKE_BUILD_TYPE=Release")
        # Embedding data files in the .js is less efficient, but allows running from a local file so is useful for testing
        set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " --embed-file ${CMAKE_SOURCE_DIR}/shaders@/shaders --embed-file ${CMAKE_SOURCE_DIR}/textures@/textures")
    endif ()

    if (WASM)
        add_definitions(-DBUILD_WASM)
        set_property(TARGET craft APPEND_STRING PROPERTY LINK_FLAGS " -s WASM=1")
        set_target_properties(craft PROPERTIES OUTPUT_NAME "craftw")
        include_directories(deps/uthash)
    endif ()
endif ()

if (NO_CRAFT_AUTH)
    add_definitions(-DNO_CRAFT_AUTH)
endif ()

# Emscripten includes its own GLFW and GLEW ports
if (NOT EMSCRIPTEN)
    set(GLFW_BUILD_EXAMPLES OFF CACHE BOOL "Build the GLFW example programs")
    set(GLFW_BUILD_TESTS OFF CACHE BOOL "Build the GLFW test programs")
    set(GLFW_BUILD_DOCS OFF CACHE BOOL "Build the GLFW documentation")
    add_subdirectory(deps/glfw)
    include_directories(deps/glew/include)
    include_directories(deps/glfw/include)
    include_directories(deps/sqlite)
    include_directories(deps/uthash)
endif ()

set(GLFW_BUILD_EXAMPLES OFF CACHE BOOL "Build the GLFW example programs")
set(GLFW_BUILD_TESTS OFF CACHE BOOL "Build the GLFW test programs")
set(GLFW_BUILD_DOCS OFF CACHE BOOL "Build the GLFW documentation")
include_directories(deps/lodepng)
include_directories(deps/miniz)
include_directories(deps/noise)
include_directories(deps/tinycthread)
include_directories(deps/uthash)

if(MINGW OR MSVC)
    set(CMAKE_LIBRARY_PATH ${CMAKE_LIBRARY_PATH}
        "C:/Program Files/CURL/lib" "C:/Program Files (x86)/CURL/lib")
    set(CMAKE_INCLUDE_PATH ${CMAKE_INCLUDE_PATH}
        "C:/Program Files/CURL/include" "C:/Program Files (x86)/CURL/include")
endif()

if (NOT EMSCRIPTEN)
    find_package(CURL REQUIRED)
    include_directories(${CURL_INCLUDE_DIR})
else ()
    set(CURL_LIBRARIES "")
endif ()

if(APPLE OR EMSCRIPTEN)
    target_link_libraries(craft glfw
        ${GLFW_LIBRARIES} ${CURL_LIBRARIES})
endif()

if(UNIX AND NOT EMSCRIPTEN)
    find_package(OpenGL REQUIRED)
    target_link_libraries(craft dl glfw
        ${OPENGL_gl_LIBRARY}
        ${GLFW_LIBRARIES} ${CURL_LIBRARIES})
endif()

if(MINGW OR MSVC)
    find_package(OpenGL REQUIRED)
    target_link_libraries(craft ws2_32.lib glfw
        ${OPENGL_gl_LIBRARY}
        ${GLFW_LIBRARIES} ${CURL_LIBRARIES})
endif()
