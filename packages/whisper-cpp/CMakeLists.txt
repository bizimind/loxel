cmake_minimum_required(VERSION 3.15)
project(whisper_cpp_addon)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# N-API version
add_definitions(-DNAPI_VERSION=8)

# Include cmake-js headers
include_directories(${CMAKE_JS_INC})

# Build whisper.cpp library
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
# Required for Linux - static libs linked into shared lib need PIC
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
add_subdirectory(deps/whisper.cpp)

# Our addon
add_library(${PROJECT_NAME} SHARED ${CMAKE_JS_SRC} src/addon.cpp)
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

# Include N-API wrappers (node-addon-api)
execute_process(
    COMMAND node -p "require('node-addon-api').include"
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
    OUTPUT_VARIABLE NODE_ADDON_API_DIR
)
string(REPLACE "\n" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})

target_include_directories(${PROJECT_NAME} PRIVATE
    ${NODE_ADDON_API_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/deps/whisper.cpp/include
    ${CMAKE_CURRENT_SOURCE_DIR}/deps/whisper.cpp/ggml/include
)

target_link_libraries(${PROJECT_NAME}
    ${CMAKE_JS_LIB}
    whisper
)

# macOS specific
if(APPLE)
    target_link_libraries(${PROJECT_NAME}
        "-framework Accelerate"
        "-framework Metal"
        "-framework MetalKit"
    )
endif()

# Windows specific
if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
    execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET} ${CMAKE_STATIC_LINKER_FLAGS})
endif()
