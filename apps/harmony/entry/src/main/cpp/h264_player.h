#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace remotedeck {

// Hardware-accelerated Annex-B H.264 decoder rendering straight to an ArkUI XComponent Surface.
class H264DecoderEngine {
public:
    H264DecoderEngine() = default;
    ~H264DecoderEngine();

    H264DecoderEngine(const H264DecoderEngine&) = delete;
    H264DecoderEngine& operator=(const H264DecoderEngine&) = delete;

    // Bind (or rebind) to an XComponent surface ID and prepare the hardware AVC decoder.
    bool Init(const std::string& surfaceIdStr, int32_t width, int32_t height);

    // Enqueue one Annex-B H.264 access unit.
    // Return codes: 1 = accepted, 0 = decoder error (fallback to JPEG), -1 = surface not ready yet.
    int32_t PushFrame(const uint8_t* data, size_t len, int64_t ptsUs, bool isKey, int32_t width, int32_t height);

    void Reset();
    void Destroy();
};

H264DecoderEngine& GetGlobalH264Decoder();

} // namespace remotedeck
