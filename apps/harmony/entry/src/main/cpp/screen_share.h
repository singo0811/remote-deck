#pragma once

#include <cstdint>
#include <string>

struct OH_AVCodec;
struct OH_AVFormat;
struct OH_AVBuffer;
struct OH_AVScreenCapture;

namespace remotedeck {

class ScreenShareServer {
public:
    ScreenShareServer() = default;
    ~ScreenShareServer();

    ScreenShareServer(const ScreenShareServer&) = delete;
    ScreenShareServer& operator=(const ScreenShareServer&) = delete;

    bool Start(int32_t port, int32_t width, int32_t height, int32_t fps);
    void Stop();
    bool Resize(int32_t width, int32_t height);
    void RequestKeyFrame();
    std::string GetStatusJson();

private:
    void AcceptLoop(uint64_t expectedGen);
    void ReleaseHardwareLocked();
    void CloseAllClientsLocked();
    void BroadcastPacket(uint8_t flags, int64_t ptsUs, const uint8_t* data, size_t size);

    static void OnEncoderError(OH_AVCodec* codec, int32_t errorCode, void* userData);
    static void OnEncoderStreamChanged(OH_AVCodec* codec, OH_AVFormat* format, void* userData);
    static void OnEncoderNeedInput(OH_AVCodec* codec, uint32_t index, OH_AVBuffer* buffer, void* userData);
    static void OnEncoderNewOutput(OH_AVCodec* codec, uint32_t index, OH_AVBuffer* buffer, void* userData);

    static void OnCaptureState(OH_AVScreenCapture* capture, int stateCode, void* userData);
    static void OnCaptureError(OH_AVScreenCapture* capture, int32_t errorCode, void* userData);
};

ScreenShareServer& GetGlobalScreenShare();

} // namespace remotedeck
