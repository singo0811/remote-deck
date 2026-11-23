cmake_minimum_required(VERSION 3.5.0)
project(remotedeck_ts)

set(NATIVERENDER_ROOT_PATH ${CMAKE_CURRENT_SOURCE_DIR})

add_library(remotedeck_ts SHARED tsnet_napi.cpp h264_player.cpp screen_share.cpp opus_decoder.cpp)
target_include_directories(remotedeck_ts PRIVATE ${NATIVERENDER_ROOT_PATH})
target_link_libraries(remotedeck_ts PUBLIC
    libace_napi.z.so
    libnative_media_codecbase.so
    libnative_media_acodec.so
    libnative_media_vdec.so
    libnative_media_venc.so
    libnative_avscreen_capture.so
    libnative_media_core.so
    libnative_window.so
    libhilog_ndk.z.so
    dl
)
