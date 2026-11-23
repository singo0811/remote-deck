#include "screen_share.h"

#include <arpa/inet.h>
#include <dlfcn.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <sstream>
#include <thread>
#include <vector>

#include <multimedia/player_framework/native_avbuffer.h>
#include <multimedia/player_framework/native_avbuffer_info.h>
#include <multimedia/player_framework/native_avcodec_base.h>
#include <multimedia/player_framework/native_avcodec_videoencoder.h>
#include <multimedia/player_framework/native_avformat.h>
#include <multimedia/player_framework/native_avscreen_capture.h>
#include <native_window/external_window.h>

namespace remotedeck {
namespace {

struct ShareImpl {
    std::mutex apiMu;
    std::mutex netMu;

    int listenFd = -1;
    std::vector<int> clientFds;
    std::vector<uint8_t> spsPps;

    OH_AVCodec* encoder = nullptr;
    OHNativeWindow* encWindow = nullptr;
    OH_AVScreenCapture* capture = nullptr;

    std::thread acceptThread;
    uint64_t generation = 0;

    std::atomic<bool> running{false};
    std::atomic<bool> capturing{false};
    std::atomic<bool> stopRequested{false};
    std::atomic<bool> inPrivateScene{false};
    std::atomic<bool> keyFrameRequested{false};
    std::atomic<uint64_t> frameCount{0};
    std::atomic<uint64_t> bytesSent{0};

    int32_t port = 9603;
    int32_t width = 720;
    int32_t height = 1156;
    int32_t fps = 30;
    std::string state = "idle";
    std::string lastError;
};

ShareImpl& S() {
    static ShareImpl inst;
    return inst;
}

std::vector<uint8_t> FramePacket(uint8_t flags, uint16_t w, uint16_t h, int64_t ptsUs,
                                 const uint8_t* data, size_t len) {
    const uint32_t bodyLen = static_cast<uint32_t>(13 + len);
    std::vector<uint8_t> out(4 + bodyLen);
    out[0] = static_cast<uint8_t>((bodyLen >> 24) & 0xff);
    out[1] = static_cast<uint8_t>((bodyLen >> 16) & 0xff);
    out[2] = static_cast<uint8_t>((bodyLen >> 8) & 0xff);
    out[3] = static_cast<uint8_t>(bodyLen & 0xff);
    out[4] = flags;
    out[5] = static_cast<uint8_t>((w >> 8) & 0xff);
    out[6] = static_cast<uint8_t>(w & 0xff);
    out[7] = static_cast<uint8_t>((h >> 8) & 0xff);
    out[8] = static_cast<uint8_t>(h & 0xff);
    const uint64_t uPts = static_cast<uint64_t>(ptsUs);
    for (int i = 0; i < 8; i++) {
        out[9 + i] = static_cast<uint8_t>((uPts >> ((7 - i) * 8)) & 0xff);
    }
    if (len > 0 && data != nullptr) {
        std::memcpy(out.data() + 17, data, len);
    }
    return out;
}

bool SendAllNonFatal(int fd, const uint8_t* data, size_t len) {
    size_t sent = 0;
    while (sent < len) {
        ssize_t n = ::send(fd, data + sent, len - sent, MSG_NOSIGNAL);
        if (n > 0) {
            sent += static_cast<size_t>(n);
            continue;
        }
        if (n < 0 && errno == EINTR) {
            continue;
        }
        return false;
    }
    return true;
}

void OnCaptureStateBridge(OH_AVScreenCapture* /*capture*/, OH_AVScreenCaptureStateCode stateCode, void* userData) {
    auto gen = static_cast<uint64_t>(reinterpret_cast<uintptr_t>(userData));
    ShareImpl& st = S();
    if (st.generation != gen) return;
    switch (stateCode) {
        case OH_SCREEN_CAPTURE_STATE_STARTED:
            st.capturing.store(true);
            st.inPrivateScene.store(false);
            st.keyFrameRequested.store(true);
            {
                std::lock_guard<std::mutex> lk(st.netMu);
                st.state = "streaming";
                st.lastError.clear();
            }
            break;
        case OH_SCREEN_CAPTURE_STATE_ENTER_PRIVATE_SCENE:
            st.inPrivateScene.store(true);
            {
                std::lock_guard<std::mutex> lk(st.netMu);
                st.state = "private";
            }
            break;
        case OH_SCREEN_CAPTURE_STATE_EXIT_PRIVATE_SCENE:
            st.inPrivateScene.store(false);
            st.keyFrameRequested.store(true);
            {
                std::lock_guard<std::mutex> lk(st.netMu);
                st.state = "streaming";
                st.lastError.clear();
            }
            break;
        case OH_SCREEN_CAPTURE_STATE_CANCELED:
            st.capturing.store(false);
            st.stopRequested.store(true);
            {
                std::lock_guard<std::mutex> lk(st.netMu);
                st.state = "canceled";
                st.lastError = "用户取消了屏幕共享授权";
            }
            break;
        case OH_SCREEN_CAPTURE_STATE_STOPPED_BY_USER:
        case OH_SCREEN_CAPTURE_STATE_INTERRUPTED_BY_OTHER:
        case OH_SCREEN_CAPTURE_STATE_STOPPED_BY_CALL:
        case OH_SCREEN_CAPTURE_STATE_STOPPED_BY_USER_SWITCHES:
            st.capturing.store(false);
            st.stopRequested.store(true);
            {
                std::lock_guard<std::mutex> lk(st.netMu);
                st.state = "stopped";
                st.lastError = "系统中断了屏幕共享 (code=" + std::to_string(static_cast<int>(stateCode)) + ")";
            }
            break;
        default:
            break;
    }
}

void OnCaptureErrorBridge(OH_AVScreenCapture* /*capture*/, int32_t errorCode, void* userData) {
    auto gen = static_cast<uint64_t>(reinterpret_cast<uintptr_t>(userData));
    ShareImpl& st = S();
    if (st.generation != gen) return;
    st.capturing.store(false);
    st.stopRequested.store(true);
    std::lock_guard<std::mutex> lk(st.netMu);
    st.state = "error";
    st.lastError = "screen capture error " + std::to_string(errorCode);
}

constexpr int kImaIndexTable[16] = {-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8};
constexpr int kImaStepTable[89] = {
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
    337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
};

uint8_t EncodeImaNibble(int sample, int& pred, int& index) {
    int step = kImaStepTable[index];
    int diff = sample - pred;
    uint8_t nibble = 0;
    if (diff < 0) {
        nibble = 8;
        diff = -diff;
    }
    int delta = step >> 3;
    if (diff >= step) { nibble |= 4; diff -= step; delta += step; }
    if (diff >= (step >> 1)) { nibble |= 2; diff -= (step >> 1); delta += (step >> 1); }
    if (diff >= (step >> 2)) { nibble |= 1; delta += (step >> 2); }
    pred += (nibble & 8) ? -delta : delta;
    if (pred > 32767) pred = 32767;
    if (pred < -32768) pred = -32768;
    index += kImaIndexTable[nibble & 0x0f];
    if (index < 0) index = 0;
    if (index > 88) index = 88;
    return nibble;
}

std::vector<uint8_t> EncodeStereoImaAdpcm(const uint8_t* pcm, size_t byteLen, int& outFrames) {
    outFrames = static_cast<int>(byteLen / 4);
    if (outFrames < 2) {
        outFrames = 0;
        return {};
    }
    auto readS16 = [&](int f, int ch) -> int {
        size_t off = static_cast<size_t>(f * 4 + ch * 2);
        int16_t v = static_cast<int16_t>(static_cast<uint16_t>(pcm[off]) | (static_cast<uint16_t>(pcm[off + 1]) << 8));
        return static_cast<int>(v);
    };
    int predL = readS16(0, 0), idxL = 0;
    int predR = readS16(0, 1), idxR = 0;
    std::vector<uint8_t> out(8 + (outFrames - 1), 0);
    out[0] = static_cast<uint8_t>(predL & 0xff);
    out[1] = static_cast<uint8_t>((predL >> 8) & 0xff);
    out[2] = 0;
    out[4] = static_cast<uint8_t>(predR & 0xff);
    out[5] = static_cast<uint8_t>((predR >> 8) & 0xff);
    out[6] = 0;
    for (int f = 1; f < outFrames; f++) {
        uint8_t nL = EncodeImaNibble(readS16(f, 0), predL, idxL);
        uint8_t nR = EncodeImaNibble(readS16(f, 1), predR, idxR);
        out[8 + f - 1] = static_cast<uint8_t>((nL & 0x0f) | ((nR & 0x0f) << 4));
    }
    return out;
}

void OnCaptureDataBridge(OH_AVScreenCapture* /*capture*/, OH_AVBuffer* buffer,
                         OH_AVScreenCaptureBufferType bufferType, int64_t timestamp, void* userData) {
    if (bufferType != OH_SCREEN_CAPTURE_BUFFERTYPE_AUDIO_INNER || buffer == nullptr) return;
    auto gen = static_cast<uint64_t>(reinterpret_cast<uintptr_t>(userData));
    ShareImpl& st = S();
    if (!st.running.load() || st.generation != gen) return;

    OH_AVCodecBufferAttr attr{};
    if (OH_AVBuffer_GetBufferAttr(buffer, &attr) != AV_ERR_OK || attr.size < 8) return;
    uint8_t* addr = OH_AVBuffer_GetAddr(buffer);
    if (addr == nullptr) return;
    const uint8_t* pcm = addr + std::max<int32_t>(0, attr.offset);
    const size_t sz = static_cast<size_t>(attr.size);

    bool nonZero = false;
    for (size_t i = 0; i + 1 < sz; i += 2) {
        int16_t s = static_cast<int16_t>(static_cast<uint16_t>(pcm[i]) | (static_cast<uint16_t>(pcm[i + 1]) << 8));
        if (s > 8 || s < -8) {
            nonZero = true;
            break;
        }
    }
    if (!nonZero) return;

    int frames = 0;
    std::vector<uint8_t> adpcm = EncodeStereoImaAdpcm(pcm, sz, frames);
    if (adpcm.empty() || frames <= 0 || frames > 65535) return;

    std::vector<uint8_t> pkt = FramePacket(
        0x04,
        48000,
        static_cast<uint16_t>(frames),
        timestamp,
        adpcm.data(),
        adpcm.size()
    );

    std::lock_guard<std::mutex> lk(st.netMu);
    if (st.clientFds.empty()) return;
    std::vector<int> alive;
    alive.reserve(st.clientFds.size());
    for (int fd : st.clientFds) {
        if (SendAllNonFatal(fd, pkt.data(), pkt.size())) {
            alive.push_back(fd);
            st.bytesSent.fetch_add(pkt.size());
        } else {
            ::close(fd);
        }
    }
    st.clientFds.swap(alive);
}

std::string JsonEscape(const std::string& src) {
    std::string out;
    out.reserve(src.size() + 8);
    for (char c : src) {
        if (c == '"' || c == '\\') {
            out.push_back('\\');
        }
        if (c == '\n' || c == '\r') {
            out.push_back(' ');
        } else {
            out.push_back(c);
        }
    }
    return out;
}

} // namespace

ScreenShareServer::~ScreenShareServer() {
    Stop();
}

void ScreenShareServer::OnEncoderError(OH_AVCodec* /*codec*/, int32_t errorCode, void* userData) {
    auto gen = static_cast<uint64_t>(reinterpret_cast<uintptr_t>(userData));
    ShareImpl& st = S();
    if (st.generation != gen) return;
    st.stopRequested.store(true);
    std::lock_guard<std::mutex> lk(st.netMu);
    st.state = "error";
    st.lastError = "video encoder error " + std::to_string(errorCode);
}

void ScreenShareServer::OnEncoderStreamChanged(OH_AVCodec* /*codec*/, OH_AVFormat* format, void* userData) {
    if (format == nullptr) return;
    auto gen = static_cast<uint64_t>(reinterpret_cast<uintptr_t>(userData));
    ShareImpl& st = S();
    if (st.generation != gen) return;
    int32_t nw = 0;
    int32_t nh = 0;
    OH_AVFormat_GetIntValue(format, OH_MD_KEY_WIDTH, &nw);
    OH_AVFormat_GetIntValue(format, OH_MD_KEY_HEIGHT, &nh);
    if (nw > 0 && nh > 0) {
        std::lock_guard<std::mutex> lk(st.netMu);
        st.width = nw;
        st.height = nh;
    }
}

void ScreenShareServer::OnEncoderNeedInput(OH_AVCodec* /*codec*/, uint32_t /*index*/,
                                           OH_AVBuffer* /*buffer*/, void* /*userData*/) {}

void ScreenShareServer::OnEncoderNewOutput(OH_AVCodec* codec, uint32_t index, OH_AVBuffer* buffer, void* userData) {
    auto gen = static_cast<uint64_t>(reinterpret_cast<uintptr_t>(userData));
    ShareImpl& st = S();
    if (codec == nullptr || buffer == nullptr || !st.running.load() || st.generation != gen) {
        if (codec != nullptr) {
            OH_VideoEncoder_FreeOutputBuffer(codec, index);
        }
        return;
    }

    OH_AVCodecBufferAttr attr{};
    if (OH_AVBuffer_GetBufferAttr(buffer, &attr) != AV_ERR_OK || attr.size <= 0) {
        OH_VideoEncoder_FreeOutputBuffer(codec, index);
        return;
    }

    uint8_t* addr = OH_AVBuffer_GetAddr(buffer);
    if (addr == nullptr) {
        OH_VideoEncoder_FreeOutputBuffer(codec, index);
        return;
    }

    const uint8_t* ptr = addr + std::max<int32_t>(0, attr.offset);
    const size_t sz = static_cast<size_t>(attr.size);
    const bool isCodecData = (attr.flags & AVCODEC_BUFFER_FLAGS_CODEC_DATA) != 0;
    const bool isSync = (attr.flags & AVCODEC_BUFFER_FLAGS_SYNC_FRAME) != 0;

    std::vector<uint8_t> payload(ptr, ptr + sz);
    OH_VideoEncoder_FreeOutputBuffer(codec, index);

    if (isCodecData) {
        {
            std::lock_guard<std::mutex> lk(st.netMu);
            st.spsPps = payload;
        }
        GetGlobalScreenShare().BroadcastPacket(0x02, attr.pts, payload.data(), payload.size());
        return;
    }

    std::vector<uint8_t> combined;
    if (isSync) {
        std::lock_guard<std::mutex> lk(st.netMu);
        if (!st.spsPps.empty()) {
            combined.reserve(st.spsPps.size() + payload.size());
            combined.insert(combined.end(), st.spsPps.begin(), st.spsPps.end());
            combined.insert(combined.end(), payload.begin(), payload.end());
        }
    }
    const std::vector<uint8_t>& outPayload = combined.empty() ? payload : combined;
    const uint8_t pktFlags = isSync ? 0x01 : 0x00;
    st.frameCount.fetch_add(1);
    GetGlobalScreenShare().BroadcastPacket(pktFlags, attr.pts, outPayload.data(), outPayload.size());
}

void ScreenShareServer::OnCaptureState(OH_AVScreenCapture* capture, int stateCode, void* userData) {
    OnCaptureStateBridge(capture, static_cast<OH_AVScreenCaptureStateCode>(stateCode), userData);
}

void ScreenShareServer::OnCaptureError(OH_AVScreenCapture* capture, int32_t errorCode, void* userData) {
    OnCaptureErrorBridge(capture, errorCode, userData);
}

void ScreenShareServer::BroadcastPacket(uint8_t flags, int64_t ptsUs, const uint8_t* data, size_t size) {
    ShareImpl& st = S();
    std::vector<uint8_t> pkt = FramePacket(
        flags,
        static_cast<uint16_t>(st.width),
        static_cast<uint16_t>(st.height),
        ptsUs,
        data,
        size
    );

    std::lock_guard<std::mutex> lk(st.netMu);
    if (st.clientFds.empty()) return;
    std::vector<int> alive;
    alive.reserve(st.clientFds.size());
    for (int fd : st.clientFds) {
        if (SendAllNonFatal(fd, pkt.data(), pkt.size())) {
            alive.push_back(fd);
            st.bytesSent.fetch_add(pkt.size());
        } else {
            ::close(fd);
        }
    }
    st.clientFds.swap(alive);
}

void ScreenShareServer::RequestKeyFrame() {
    ShareImpl& st = S();
    std::lock_guard<std::mutex> lk(st.apiMu);
    if (st.encoder == nullptr || !st.running.load()) return;
    OH_AVFormat* fmt = OH_AVFormat_Create();
    if (fmt != nullptr) {
        OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_REQUEST_I_FRAME, 1);
        OH_VideoEncoder_SetParameter(st.encoder, fmt);
        OH_AVFormat_Destroy(fmt);
    }
}

void ScreenShareServer::AcceptLoop(uint64_t expectedGen) {
    ShareImpl& st = S();
    while (st.running.load() && !st.stopRequested.load() && st.generation == expectedGen) {
        if (st.keyFrameRequested.exchange(false)) {
            RequestKeyFrame();
        }
        int lfd = st.listenFd;
        if (lfd < 0) break;

        struct pollfd pfd{};
        pfd.fd = lfd;
        pfd.events = POLLIN;
        int rc = ::poll(&pfd, 1, 100);
        if (rc < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (rc == 0 || (pfd.revents & POLLIN) == 0) {
            continue;
        }

        struct sockaddr_in peer{};
        socklen_t peerLen = sizeof(peer);
        int cfd = ::accept(lfd, reinterpret_cast<struct sockaddr*>(&peer), &peerLen);
        if (cfd < 0) {
            continue;
        }
        int one = 1;
        ::setsockopt(cfd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

        std::vector<uint8_t> initPkt;
        {
            std::lock_guard<std::mutex> lk(st.netMu);
            if (!st.spsPps.empty()) {
                initPkt = FramePacket(
                    0x02,
                    static_cast<uint16_t>(st.width),
                    static_cast<uint16_t>(st.height),
                    0,
                    st.spsPps.data(),
                    st.spsPps.size()
                );
            }
            st.clientFds.push_back(cfd);
        }
        if (!initPkt.empty()) {
            (void)SendAllNonFatal(cfd, initPkt.data(), initPkt.size());
        }
        RequestKeyFrame();
    }

    if (st.stopRequested.load() && st.running.load() && st.generation == expectedGen) {
        std::lock_guard<std::mutex> lk(st.apiMu);
        if (st.generation == expectedGen) {
            st.running.store(false);
            st.capturing.store(false);
            ReleaseHardwareLocked();
            CloseAllClientsLocked();
        }
    }
}

bool ScreenShareServer::Start(int32_t port, int32_t width, int32_t height, int32_t fps) {
    Stop();
    ShareImpl& st = S();
    std::lock_guard<std::mutex> lk(st.apiMu);

    st.generation += 1;
    const uint64_t gen = st.generation;

    int32_t w = std::max(128, std::min(1920, width));
    int32_t h = std::max(128, std::min(2560, height));
    w &= ~1;
    h &= ~1;
    int32_t targetFps = std::max(15, std::min(60, fps));
    int32_t targetPort = port > 0 ? port : 9603;

    st.port = targetPort;
    st.width = w;
    st.height = h;
    st.fps = targetFps;
    st.frameCount.store(0);
    st.bytesSent.store(0);
    st.stopRequested.store(false);
    st.capturing.store(false);
    {
        std::lock_guard<std::mutex> nlk(st.netMu);
        st.spsPps.clear();
        st.state = "starting";
        st.lastError.clear();
    }

    int lfd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (lfd < 0) {
        std::lock_guard<std::mutex> nlk(st.netMu);
        st.state = "error";
        st.lastError = "failed to create tcp socket";
        return false;
    }
    int reuse = 1;
    ::setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    struct sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(static_cast<uint16_t>(targetPort));
    if (::bind(lfd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) != 0 || ::listen(lfd, 4) != 0) {
        ::close(lfd);
        std::lock_guard<std::mutex> nlk(st.netMu);
        st.state = "error";
        st.lastError = "failed to bind/listen port " + std::to_string(targetPort);
        return false;
    }
    st.listenFd = lfd;

    OH_AVCodec* enc = OH_VideoEncoder_CreateByMime(OH_AVCODEC_MIMETYPE_VIDEO_AVC);
    if (enc == nullptr) {
        ReleaseHardwareLocked();
        CloseAllClientsLocked();
        std::lock_guard<std::mutex> nlk(st.netMu);
        st.state = "error";
        st.lastError = "OH_VideoEncoder_CreateByMime failed";
        return false;
    }
    st.encoder = enc;

    OH_AVCodecCallback cb{};
    cb.onError = &ScreenShareServer::OnEncoderError;
    cb.onStreamChanged = &ScreenShareServer::OnEncoderStreamChanged;
    cb.onNeedInputBuffer = &ScreenShareServer::OnEncoderNeedInput;
    cb.onNewOutputBuffer = &ScreenShareServer::OnEncoderNewOutput;
    if (OH_VideoEncoder_RegisterCallback(enc, cb, reinterpret_cast<void*>(static_cast<uintptr_t>(gen))) != AV_ERR_OK) {
        ReleaseHardwareLocked();
        CloseAllClientsLocked();
        std::lock_guard<std::mutex> nlk(st.netMu);
        st.state = "error";
        st.lastError = "OH_VideoEncoder_RegisterCallback failed";
        return false;
    }

    OH_AVFormat* fmt = OH_AVFormat_Create();
    if (fmt == nullptr) {
        ReleaseHardwareLocked();
        CloseAllClientsLocked();
        std::lock_guard<std::mutex> nlk(st.netMu);
        st.state = "error";
        st.lastError = "OH_AVFormat_Create failed";
        return false;
    }
    OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_WIDTH, w);
    OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_HEIGHT, h);
    OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_PIXEL_FORMAT, AV_PIXEL_FORMAT_SURFACE_FORMAT);
    OH_AVFormat_SetDoubleValue(fmt, OH_MD_KEY_FRAME_RATE, static_cast<double>(targetFps));
    OH_AVFormat_SetLongValue(fmt, OH_MD_KEY_BITRATE, 4500000L);
    OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_I_FRAME_INTERVAL, 1000);
    OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_PROFILE, AVC_PROFILE_BASELINE);
    OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_VIDEO_ENCODE_BITRATE_MODE, BITRATE_MODE_CBR);
    OH_AVErrCode cfgRc = OH_VideoEncoder_Configure(enc, fmt);
    OH_AVFormat_Destroy(fmt);
    if (cfgRc != AV_ERR_OK) {
        ReleaseHardwareLocked();
        CloseAllClientsLocked();
        std::lock_guard<std::mutex> nlk(st.netMu);
        st.state = "error";
        st.lastError = "OH_VideoEncoder_Configure failed (" + std::to_string(cfgRc) + ")";
        return false;
    }

    OHNativeWindow* win = nullptr;
    if (OH_VideoEncoder_GetSurface(enc, &win) != AV_ERR_OK || win == nullptr) {
        ReleaseHardwareLocked();
        CloseAllClientsLocked();
        std::lock_guard<std::mutex> nlk(st.netMu);
        st.state = "error";
        st.lastError = "OH_VideoEncoder_GetSurface failed";
        return false;
    }
    st.encWindow = win;

    if (OH_VideoEncoder_Prepare(enc) != AV_ERR_OK || OH_VideoEncoder_Start(enc) != AV_ERR_OK) {
        ReleaseHardwareLocked();
        CloseAllClientsLocked();
        std::lock_guard<std::mutex> nlk(st.netMu);
        st.state = "error";
        st.lastError = "OH_VideoEncoder_Prepare/Start failed";
        return false;
    }

    OH_AVScreenCapture* cap = OH_AVScreenCapture_Create();
    if (cap == nullptr) {
        ReleaseHardwareLocked();
        CloseAllClientsLocked();
        std::lock_guard<std::mutex> nlk(st.netMu);
        st.state = "error";
        st.lastError = "OH_AVScreenCapture_Create failed";
        return false;
    }
    st.capture = cap;

    OH_AVScreenCapture_SetStateCallback(cap, &OnCaptureStateBridge, reinterpret_cast<void*>(static_cast<uintptr_t>(gen)));
    OH_AVScreenCapture_SetErrorCallback(cap, &OnCaptureErrorBridge, reinterpret_cast<void*>(static_cast<uintptr_t>(gen)));
    OH_AVScreenCapture_SetDataCallback(cap, &OnCaptureDataBridge, reinterpret_cast<void*>(static_cast<uintptr_t>(gen)));

    OH_AVScreenCaptureConfig capCfg{};
    capCfg.captureMode = OH_CAPTURE_HOME_SCREEN;
    capCfg.dataType = OH_ORIGINAL_STREAM;
    capCfg.audioInfo.innerCapInfo.audioSampleRate = 48000;
    capCfg.audioInfo.innerCapInfo.audioChannels = 2;
    capCfg.audioInfo.innerCapInfo.audioSource = OH_ALL_PLAYBACK;
    capCfg.videoInfo.videoCapInfo.videoFrameWidth = w;
    capCfg.videoInfo.videoCapInfo.videoFrameHeight = h;
    capCfg.videoInfo.videoCapInfo.videoSource = OH_VIDEO_SOURCE_SURFACE_RGBA;

    if (OH_AVScreenCapture_Init(cap, capCfg) != AV_SCREEN_CAPTURE_ERR_OK) {
        // Fallback to video-only capture if inner playback audio isn't permitted on this device.
        capCfg.audioInfo.innerCapInfo.audioSampleRate = 0;
        capCfg.audioInfo.innerCapInfo.audioChannels = 0;
        capCfg.audioInfo.innerCapInfo.audioSource = OH_SOURCE_INVALID;
        if (OH_AVScreenCapture_Init(cap, capCfg) != AV_SCREEN_CAPTURE_ERR_OK) {
            ReleaseHardwareLocked();
            CloseAllClientsLocked();
            std::lock_guard<std::mutex> nlk(st.netMu);
            st.state = "error";
            st.lastError = "OH_AVScreenCapture_Init failed";
            return false;
        }
    }
    (void)OH_AVScreenCapture_SetCanvasRotation(cap, true);

    using FnCreateStrategy = OH_AVScreenCapture_CaptureStrategy* (*)();
    using FnReleaseStrategy = OH_AVSCREEN_CAPTURE_ErrCode (*)(OH_AVScreenCapture_CaptureStrategy*);
    using FnSetStrategy = OH_AVSCREEN_CAPTURE_ErrCode (*)(OH_AVScreenCapture*, OH_AVScreenCapture_CaptureStrategy*);
    using FnStrategyBool = OH_AVSCREEN_CAPTURE_ErrCode (*)(OH_AVScreenCapture_CaptureStrategy*, bool);
    using FnStrategyInt = OH_AVSCREEN_CAPTURE_ErrCode (*)(OH_AVScreenCapture_CaptureStrategy*, int32_t);
    auto fnCreate = reinterpret_cast<FnCreateStrategy>(dlsym(RTLD_DEFAULT, "OH_AVScreenCapture_CreateCaptureStrategy"));
    auto fnRelease = reinterpret_cast<FnReleaseStrategy>(dlsym(RTLD_DEFAULT, "OH_AVScreenCapture_ReleaseCaptureStrategy"));
    auto fnSet = reinterpret_cast<FnSetStrategy>(dlsym(RTLD_DEFAULT, "OH_AVScreenCapture_SetCaptureStrategy"));
    auto fnKeepCall = reinterpret_cast<FnStrategyBool>(dlsym(RTLD_DEFAULT, "OH_AVScreenCapture_StrategyForKeepCaptureDuringCall"));
    auto fnFollowRot = reinterpret_cast<FnStrategyBool>(dlsym(RTLD_DEFAULT, "OH_AVScreenCapture_StrategyForCanvasFollowRotation"));
    auto fnPrivacyMode = reinterpret_cast<FnStrategyInt>(dlsym(RTLD_DEFAULT, "OH_AVScreenCapture_StrategyForPrivacyMaskMode"));
    if (fnCreate && fnRelease && fnSet) {
        if (OH_AVScreenCapture_CaptureStrategy* strat = fnCreate()) {
            if (fnKeepCall) (void)fnKeepCall(strat, true);
            if (fnFollowRot) (void)fnFollowRot(strat, true);
            if (fnPrivacyMode) (void)fnPrivacyMode(strat, 1);
            (void)fnSet(cap, strat);
            (void)fnRelease(strat);
        }
    }

    st.inPrivateScene.store(false);
    st.keyFrameRequested.store(false);
    st.running.store(true);
    OH_AVSCREEN_CAPTURE_ErrCode startRc = OH_AVScreenCapture_StartScreenCaptureWithSurface(cap, win);
    if (startRc != AV_SCREEN_CAPTURE_ERR_OK) {
        st.running.store(false);
        ReleaseHardwareLocked();
        CloseAllClientsLocked();
        std::lock_guard<std::mutex> nlk(st.netMu);
        st.state = "error";
        st.lastError = "StartScreenCaptureWithSurface failed (" + std::to_string(startRc) + ")";
        return false;
    }

    st.acceptThread = std::thread([this, gen]() { AcceptLoop(gen); });
    return true;
}

void ScreenShareServer::ReleaseHardwareLocked() {
    ShareImpl& st = S();
    if (st.capture != nullptr) {
        OH_AVScreenCapture_StopScreenCapture(st.capture);
        OH_AVScreenCapture_Release(st.capture);
        st.capture = nullptr;
    }
    if (st.encoder != nullptr) {
        OH_VideoEncoder_Stop(st.encoder);
        OH_VideoEncoder_Destroy(st.encoder);
        st.encoder = nullptr;
    }
    if (st.encWindow != nullptr) {
        OH_NativeWindow_DestroyNativeWindow(st.encWindow);
        st.encWindow = nullptr;
    }
    if (st.listenFd >= 0) {
        ::close(st.listenFd);
        st.listenFd = -1;
    }
}

void ScreenShareServer::CloseAllClientsLocked() {
    ShareImpl& st = S();
    std::lock_guard<std::mutex> nlk(st.netMu);
    for (int fd : st.clientFds) {
        ::close(fd);
    }
    st.clientFds.clear();
    st.spsPps.clear();
}

bool ScreenShareServer::Resize(int32_t width, int32_t height) {
    ShareImpl& st = S();
    int32_t w = std::max(128, std::min(2560, width)) & ~1;
    int32_t h = std::max(128, std::min(2560, height)) & ~1;
    {
        std::lock_guard<std::mutex> lk(st.apiMu);
        if (!st.running.load() || st.capture == nullptr) return false;
        if (OH_AVScreenCapture_ResizeCanvas(st.capture, w, h) != AV_SCREEN_CAPTURE_ERR_OK) {
            return false;
        }
        {
            std::lock_guard<std::mutex> nlk(st.netMu);
            st.width = w;
            st.height = h;
        }
    }
    RequestKeyFrame();
    return true;
}

void ScreenShareServer::Stop() {
    ShareImpl& st = S();
    std::thread toJoin;
    {
        std::lock_guard<std::mutex> lk(st.apiMu);
        st.generation += 1;
        st.running.store(false);
        st.capturing.store(false);
        st.stopRequested.store(true);
        if (st.listenFd >= 0) {
            ::shutdown(st.listenFd, SHUT_RDWR);
            ::close(st.listenFd);
            st.listenFd = -1;
        }
        if (st.acceptThread.joinable()) {
            toJoin = std::move(st.acceptThread);
        }
    }
    if (toJoin.joinable() && toJoin.get_id() != std::this_thread::get_id()) {
        toJoin.join();
    }
    std::lock_guard<std::mutex> lk(st.apiMu);
    ReleaseHardwareLocked();
    CloseAllClientsLocked();
    std::lock_guard<std::mutex> nlk(st.netMu);
    if (st.state == "starting" || st.state == "streaming") {
        st.state = "stopped";
    }
}

std::string ScreenShareServer::GetStatusJson() {
    ShareImpl& st = S();
    std::lock_guard<std::mutex> nlk(st.netMu);
    std::ostringstream oss;
    oss << "{\"running\":" << (st.running.load() ? "true" : "false")
        << ",\"capturing\":" << (st.capturing.load() ? "true" : "false")
        << ",\"state\":\"" << JsonEscape(st.state) << "\""
        << ",\"port\":" << st.port
        << ",\"width\":" << st.width
        << ",\"height\":" << st.height
        << ",\"fps\":" << st.fps
        << ",\"clients\":" << st.clientFds.size()
        << ",\"frames\":" << st.frameCount.load()
        << ",\"bytesSent\":" << st.bytesSent.load()
        << ",\"lastError\":\"" << JsonEscape(st.lastError) << "\"}";
    return oss.str();
}

ScreenShareServer& GetGlobalScreenShare() {
    static ScreenShareServer inst;
    return inst;
}

} // namespace remotedeck
