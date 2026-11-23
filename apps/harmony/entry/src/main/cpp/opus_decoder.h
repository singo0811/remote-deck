#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace remotedeck {

class OpusAudioDecoder {
public:
    OpusAudioDecoder() = default;
    ~OpusAudioDecoder();

    OpusAudioDecoder(const OpusAudioDecoder&) = delete;
    OpusAudioDecoder& operator=(const OpusAudioDecoder&) = delete;

    bool Init(int32_t sampleRate, int32_t channels, const uint8_t* codecConfig = nullptr, size_t configLen = 0);
    std::vector<uint8_t> Decode(const uint8_t* data, size_t len, int32_t sampleRate, int32_t channels,
                                const uint8_t* codecConfig = nullptr, size_t configLen = 0);
    void Destroy();
};

OpusAudioDecoder& GetGlobalOpusDecoder();

} // namespace remotedeck
