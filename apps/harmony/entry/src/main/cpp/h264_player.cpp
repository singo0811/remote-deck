#include "h264_player.h"

#include <atomic>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>

#include <multimedia/player_framework/native_avbuffer.h>
#include <multimedia/player_framework/native_avbuffer_info.h>
#include <multimedia/player_framework/native_avcodec_base.h>
#include <multimedia/player_framework/native_avcodec_videodecoder.h>
#include <multimedia/player_framework/native_avformat.h>
#include <native_window/external_window.h>

namespace remotedeck {
namespace {

struct EncodedPacket {
    std::vector<uint8_t> data;
    int64_t ptsUs = 0;
    bool isKey = false;
};

struct InputSlot {
    uint32_t index = 0;
    OH_AVBuffer* buffer = nullptr;
};

struct DecoderImpl {
    std::mutex apiMu;
    std::mutex queueMu;
    std::condition_variable queueCv;

    std::string surfaceIdStr;
    OHNativeWindow* window = nullptr;
    OH_AVCodec* codec = nullptr;
    int32_t width = 0;
    int32_t height = 0;
    uint64_t generation = 0;

    std::deque<InputSlot> inputSlots;
    std::deque<EncodedPacket> pendingPackets;
    std::thread feederThread;
    bool running = false;
    bool waitingForKeyFrame = true;
    std::atomic<bool> hasError{false};
};

DecoderImpl& State() {
    static DecoderImpl inst;
    return inst;
}

void OnCodecError(OH_AVCodec* /*codec*/, int32_t /*errorCode*/, void* /*userData*/) {
    DecoderImpl& s = State();
    s.hasError.store(true);
    std::lock_guard<std::mutex> lk(s.queueMu);
    s.waitingForKeyFrame = true;
    s.pendingPackets.clear();
    s.queueCv.notify_all();
}

void OnStreamChanged(OH_AVCodec* /*codec*/, OH_AVFormat* /*format*/, void* /*userData*/) {
    // Hardware surface adapts automatically when frames render onto OHNativeWindow.
}

void OnNeedInputBuffer(OH_AVCodec* codec, uint32_t index, OH_AVBuffer* buffer, void* userData) {
    auto gen = static_cast<uint64_t>(reinterpret_cast<uintptr_t>(userData));
    DecoderImpl& s = State();
    std::lock_guard<std::mutex> lk(s.queueMu);
    if (!s.running || s.codec != codec || s.generation != gen || buffer == nullptr) {
        return;
    }
    s.inputSlots.push_back(InputSlot{index, buffer});
    s.queueCv.notify_one();
}

void OnNewOutputBuffer(OH_AVCodec* codec, uint32_t index, OH_AVBuffer* /*buffer*/, void* /*userData*/) {
    if (codec != nullptr) {
        // Zero-copy render straight to the XComponent NativeWindow surface.
        OH_VideoDecoder_RenderOutputBuffer(codec, index);
    }
}

void FeederLoop(uint64_t expectedGen) {
    DecoderImpl& s = State();
    for (;;) {
        InputSlot slot{};
        EncodedPacket pkt{};
        OH_AVCodec* codec = nullptr;
        {
            std::unique_lock<std::mutex> lk(s.queueMu);
            s.queueCv.wait(lk, [&]() {
                return !s.running || s.generation != expectedGen ||
                       (!s.inputSlots.empty() && !s.pendingPackets.empty());
            });
            if (!s.running || s.generation != expectedGen || s.codec == nullptr) {
                break;
            }
            slot = s.inputSlots.front();
            s.inputSlots.pop_front();
            pkt = std::move(s.pendingPackets.front());
            s.pendingPackets.pop_front();
            codec = s.codec;
        }

        if (codec == nullptr || slot.buffer == nullptr || pkt.data.empty()) {
            continue;
        }
        uint8_t* dst = OH_AVBuffer_GetAddr(slot.buffer);
        int32_t cap = OH_AVBuffer_GetCapacity(slot.buffer);
        if (dst == nullptr || cap <= 0 || static_cast<int32_t>(pkt.data.size()) > cap) {
            continue;
        }
        std::memcpy(dst, pkt.data.data(), pkt.data.size());
        OH_AVCodecBufferAttr attr{};
        attr.pts = pkt.ptsUs;
        attr.size = static_cast<int32_t>(pkt.data.size());
        attr.offset = 0;
        attr.flags = pkt.isKey ? AVCODEC_BUFFER_FLAGS_SYNC_FRAME : AVCODEC_BUFFER_FLAGS_NONE;
        if (OH_AVBuffer_SetBufferAttr(slot.buffer, &attr) == AV_ERR_OK) {
            OH_VideoDecoder_PushInputBuffer(codec, slot.index);
        }
    }
}

void StopCodecOnlyLocked(DecoderImpl& s) {
    {
        std::lock_guard<std::mutex> lk(s.queueMu);
        s.running = false;
        s.generation += 1;
        s.inputSlots.clear();
        s.pendingPackets.clear();
        s.waitingForKeyFrame = true;
    }
    s.queueCv.notify_all();
    if (s.feederThread.joinable()) {
        s.feederThread.join();
    }
    if (s.codec != nullptr) {
        OH_VideoDecoder_Stop(s.codec);
        OH_VideoDecoder_Destroy(s.codec);
        s.codec = nullptr;
    }
    s.width = 0;
    s.height = 0;
    s.hasError.store(false);
}

bool ConfigureAndStartLocked(DecoderImpl& s, int32_t width, int32_t height) {
    if (s.window == nullptr || width <= 0 || height <= 0) {
        return false;
    }
    StopCodecOnlyLocked(s);

    OH_AVCodec* codec = OH_VideoDecoder_CreateByMime(OH_AVCODEC_MIMETYPE_VIDEO_AVC);
    if (codec == nullptr) {
        return false;
    }

    uint64_t nextGen = 0;
    {
        std::lock_guard<std::mutex> lk(s.queueMu);
        nextGen = s.generation + 1;
        s.generation = nextGen;
        s.codec = codec;
        s.waitingForKeyFrame = true;
        s.hasError.store(false);
    }

    OH_AVCodecCallback cb{};
    cb.onError = OnCodecError;
    cb.onStreamChanged = OnStreamChanged;
    cb.onNeedInputBuffer = OnNeedInputBuffer;
    cb.onNewOutputBuffer = OnNewOutputBuffer;
    if (OH_VideoDecoder_RegisterCallback(codec, cb, reinterpret_cast<void*>(static_cast<uintptr_t>(nextGen))) != AV_ERR_OK) {
        OH_VideoDecoder_Destroy(codec);
        s.codec = nullptr;
        return false;
    }

    auto tryConfigure = [&](bool lowLatency) -> bool {
        OH_AVFormat* fmt = OH_AVFormat_CreateVideoFormat(OH_AVCODEC_MIMETYPE_VIDEO_AVC, width, height);
        if (fmt == nullptr) {
            return false;
        }
        OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_PIXEL_FORMAT, AV_PIXEL_FORMAT_NV12);
        if (lowLatency) {
            OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_VIDEO_ENABLE_LOW_LATENCY, 1);
        }
        OH_AVErrCode err = OH_VideoDecoder_Configure(codec, fmt);
        OH_AVFormat_Destroy(fmt);
        return err == AV_ERR_OK;
    };

    if (!tryConfigure(true) && !tryConfigure(false)) {
        OH_VideoDecoder_Destroy(codec);
        s.codec = nullptr;
        return false;
    }
    if (OH_VideoDecoder_SetSurface(codec, s.window) != AV_ERR_OK) {
        OH_VideoDecoder_Destroy(codec);
        s.codec = nullptr;
        return false;
    }
    if (OH_VideoDecoder_Prepare(codec) != AV_ERR_OK) {
        OH_VideoDecoder_Destroy(codec);
        s.codec = nullptr;
        return false;
    }

    {
        std::lock_guard<std::mutex> lk(s.queueMu);
        s.running = true;
        s.width = width;
        s.height = height;
    }
    s.feederThread = std::thread(FeederLoop, nextGen);

    if (OH_VideoDecoder_Start(codec) != AV_ERR_OK) {
        StopCodecOnlyLocked(s);
        return false;
    }
    return true;
}

} // namespace

H264DecoderEngine::~H264DecoderEngine() {
    Destroy();
}

bool H264DecoderEngine::Init(const std::string& surfaceIdStr, int32_t width, int32_t height) {
    DecoderImpl& s = State();
    std::lock_guard<std::mutex> apiLock(s.apiMu);
    if (surfaceIdStr.empty()) {
        return false;
    }
    if (s.window != nullptr && s.surfaceIdStr == surfaceIdStr && s.codec != nullptr &&
        s.width == width && s.height == height && !s.hasError.load()) {
        return true;
    }

    if (s.surfaceIdStr != surfaceIdStr || s.window == nullptr) {
        StopCodecOnlyLocked(s);
        if (s.window != nullptr) {
            OH_NativeWindow_DestroyNativeWindow(s.window);
            s.window = nullptr;
        }
        uint64_t sid = 0;
        try {
            sid = std::stoull(surfaceIdStr);
        } catch (...) {
            return false;
        }
        OHNativeWindow* win = nullptr;
        if (OH_NativeWindow_CreateNativeWindowFromSurfaceId(sid, &win) != 0 || win == nullptr) {
            return false;
        }
        s.window = win;
        s.surfaceIdStr = surfaceIdStr;
    }

    if (width > 0 && height > 0) {
        return ConfigureAndStartLocked(s, width, height);
    }
    return true;
}

int32_t H264DecoderEngine::PushFrame(const uint8_t* data, size_t len, int64_t ptsUs, bool isKey, int32_t width, int32_t height) {
    if (data == nullptr || len == 0) {
        return 1;
    }
    DecoderImpl& s = State();
    std::lock_guard<std::mutex> apiLock(s.apiMu);
    if (s.window == nullptr) {
        return -1; // XComponent surface not bound yet
    }

    bool needReconfig = (s.codec == nullptr) || s.hasError.load() ||
                        (width > 0 && height > 0 && (width != s.width || height != s.height));
    if (needReconfig) {
        if (!isKey || width <= 0 || height <= 0) {
            // Wait safely for next IDR keyframe when resolution changed or recovering from error.
            return 1;
        }
        if (!ConfigureAndStartLocked(s, width, height)) {
            return 0;
        }
    }

    EncodedPacket pkt;
    pkt.data.assign(data, data + len);
    pkt.ptsUs = ptsUs;
    pkt.isKey = isKey;

    std::lock_guard<std::mutex> qLock(s.queueMu);
    if (!s.running) {
        return 0;
    }
    if (s.waitingForKeyFrame) {
        if (!isKey) {
            return 1;
        }
        s.waitingForKeyFrame = false;
    }
    if (isKey) {
        // Drop any unconsumed older P-frames so latency stays tight.
        s.pendingPackets.clear();
    } else if (s.pendingPackets.size() >= 6) {
        // Discard the broken prediction chain and resume at an IDR.
        s.pendingPackets.clear();
        s.waitingForKeyFrame = true;
        return 2;
    }
    s.pendingPackets.push_back(std::move(pkt));
    s.queueCv.notify_one();
    return 1;
}

void H264DecoderEngine::Reset() {
    DecoderImpl& s = State();
    std::lock_guard<std::mutex> apiLock(s.apiMu);
    StopCodecOnlyLocked(s);
}

void H264DecoderEngine::Destroy() {
    DecoderImpl& s = State();
    std::lock_guard<std::mutex> apiLock(s.apiMu);
    StopCodecOnlyLocked(s);
    if (s.window != nullptr) {
        OH_NativeWindow_DestroyNativeWindow(s.window);
        s.window = nullptr;
    }
    s.surfaceIdStr.clear();
}

H264DecoderEngine& GetGlobalH264Decoder() {
    static H264DecoderEngine engine;
    return engine;
}

} // namespace remotedeck
