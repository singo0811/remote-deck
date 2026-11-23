#include "opus_decoder.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <mutex>
#include <vector>

#include <multimedia/player_framework/native_avbuffer.h>
#include <multimedia/player_framework/native_avbuffer_info.h>
#include <multimedia/player_framework/native_avcodec_audiocodec.h>
#include <multimedia/player_framework/native_avcodec_base.h>
#include <multimedia/player_framework/native_avformat.h>

namespace remotedeck {
namespace {

struct AudioInputSlot {
    uint32_t index = 0;
    OH_AVBuffer* buffer = nullptr;
};

struct OpusImpl {
    std::mutex apiMu;
    std::mutex queueMu;
    std::condition_variable queueCv;

    OH_AVCodec* codec = nullptr;
    int32_t sampleRate = 48000;
    int32_t channels = 2;
    uint64_t generation = 0;
    int64_t nextPtsUs = 0;
    bool running = false;
    std::atomic<bool> hasError{false};

    std::deque<AudioInputSlot> inputSlots;
    std::deque<std::vector<uint8_t>> outputPcm;
};

OpusImpl& S() {
    static OpusImpl inst;
    return inst;
}

std::vector<uint8_t> BuildDefaultOpusHead(int32_t channels, int32_t origSampleRate) {
    std::vector<uint8_t> head(19, 0);
    const char magic[] = "OpusHead";
    std::memcpy(head.data(), magic, 8);
    head[8] = 1;
    head[9] = static_cast<uint8_t>(channels == 1 ? 1 : 2);
    head[10] = 0x38; // 312 pre-skip LE
    head[11] = 0x01;
    uint32_t sr = static_cast<uint32_t>(origSampleRate > 0 ? origSampleRate : 48000);
    head[12] = static_cast<uint8_t>(sr & 0xff);
    head[13] = static_cast<uint8_t>((sr >> 8) & 0xff);
    head[14] = static_cast<uint8_t>((sr >> 16) & 0xff);
    head[15] = static_cast<uint8_t>((sr >> 24) & 0xff);
    return head;
}

void OnAudioError(OH_AVCodec* /*codec*/, int32_t /*errorCode*/, void* userData) {
    auto gen = static_cast<uint64_t>(reinterpret_cast<uintptr_t>(userData));
    OpusImpl& st = S();
    if (st.generation != gen) return;
    st.hasError.store(true);
    std::lock_guard<std::mutex> lk(st.queueMu);
    st.queueCv.notify_all();
}

void OnAudioStreamChanged(OH_AVCodec* /*codec*/, OH_AVFormat* /*format*/, void* /*userData*/) {}

void OnAudioNeedInput(OH_AVCodec* codec, uint32_t index, OH_AVBuffer* buffer, void* userData) {
    auto gen = static_cast<uint64_t>(reinterpret_cast<uintptr_t>(userData));
    OpusImpl& st = S();
    std::lock_guard<std::mutex> lk(st.queueMu);
    if (!st.running || st.codec != codec || st.generation != gen || buffer == nullptr) {
        return;
    }
    st.inputSlots.push_back(AudioInputSlot{index, buffer});
    st.queueCv.notify_all();
}

void OnAudioNewOutput(OH_AVCodec* codec, uint32_t index, OH_AVBuffer* buffer, void* userData) {
    auto gen = static_cast<uint64_t>(reinterpret_cast<uintptr_t>(userData));
    OpusImpl& st = S();
    if (codec == nullptr || buffer == nullptr || !st.running || st.generation != gen) {
        if (codec != nullptr) {
            OH_AudioCodec_FreeOutputBuffer(codec, index);
        }
        return;
    }
    OH_AVCodecBufferAttr attr{};
    if (OH_AVBuffer_GetBufferAttr(buffer, &attr) == AV_ERR_OK && attr.size > 0) {
        uint8_t* addr = OH_AVBuffer_GetAddr(buffer);
        if (addr != nullptr) {
            const uint8_t* ptr = addr + std::max<int32_t>(0, attr.offset);
            std::vector<uint8_t> pcm(ptr, ptr + attr.size);
            {
                std::lock_guard<std::mutex> lk(st.queueMu);
                if (st.outputPcm.size() > 16) {
                    st.outputPcm.pop_front();
                }
                st.outputPcm.push_back(std::move(pcm));
            }
            st.queueCv.notify_all();
        }
    }
    OH_AudioCodec_FreeOutputBuffer(codec, index);
}

void DestroyLocked() {
    OpusImpl& st = S();
    {
        std::lock_guard<std::mutex> lk(st.queueMu);
        st.generation += 1;
        st.running = false;
        st.inputSlots.clear();
        st.outputPcm.clear();
        st.queueCv.notify_all();
    }
    if (st.codec != nullptr) {
        OH_AudioCodec_Stop(st.codec);
        OH_AudioCodec_Destroy(st.codec);
        st.codec = nullptr;
    }
    st.hasError.store(false);
    st.nextPtsUs = 0;
}

} // namespace

OpusAudioDecoder::~OpusAudioDecoder() {
    Destroy();
}

bool OpusAudioDecoder::Init(int32_t sampleRate, int32_t channels, const uint8_t* codecConfig, size_t configLen) {
    OpusImpl& st = S();
    std::lock_guard<std::mutex> lk(st.apiMu);

    int32_t sr = sampleRate > 0 ? sampleRate : 48000;
    int32_t ch = channels == 1 ? 1 : 2;
    if (st.codec != nullptr && st.running && !st.hasError.load() && st.sampleRate == sr && st.channels == ch) {
        return true;
    }

    DestroyLocked();

    OH_AVCodec* codec = OH_AudioCodec_CreateByMime(OH_AVCODEC_MIMETYPE_AUDIO_OPUS, false);
    if (codec == nullptr) {
        return false;
    }
    st.codec = codec;
    st.sampleRate = sr;
    st.channels = ch;
    st.hasError.store(false);
    const uint64_t gen = st.generation;

    OH_AVCodecCallback cb{};
    cb.onError = &OnAudioError;
    cb.onStreamChanged = &OnAudioStreamChanged;
    cb.onNeedInputBuffer = &OnAudioNeedInput;
    cb.onNewOutputBuffer = &OnAudioNewOutput;
    if (OH_AudioCodec_RegisterCallback(codec, cb, reinterpret_cast<void*>(static_cast<uintptr_t>(gen))) != AV_ERR_OK) {
        DestroyLocked();
        return false;
    }

    OH_AVFormat* fmt = OH_AVFormat_Create();
    if (fmt == nullptr) {
        DestroyLocked();
        return false;
    }
    OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_AUD_SAMPLE_RATE, sr);
    OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_AUD_CHANNEL_COUNT, ch);
    OH_AVFormat_SetIntValue(fmt, OH_MD_KEY_AUDIO_SAMPLE_FORMAT, SAMPLE_S16LE);

    std::vector<uint8_t> headBuf;
    if (codecConfig != nullptr && configLen >= 19) {
        headBuf.assign(codecConfig, codecConfig + configLen);
    } else {
        headBuf = BuildDefaultOpusHead(ch, sr);
    }
    OH_AVFormat_SetBuffer(fmt, OH_MD_KEY_CODEC_CONFIG, headBuf.data(), headBuf.size());

    OH_AVErrCode cfgRc = OH_AudioCodec_Configure(codec, fmt);
    OH_AVFormat_Destroy(fmt);
    if (cfgRc != AV_ERR_OK) {
        DestroyLocked();
        return false;
    }

    {
        std::lock_guard<std::mutex> qlk(st.queueMu);
        st.running = true;
    }
    if (OH_AudioCodec_Prepare(codec) != AV_ERR_OK || OH_AudioCodec_Start(codec) != AV_ERR_OK) {
        DestroyLocked();
        return false;
    }
    return true;
}

std::vector<uint8_t> OpusAudioDecoder::Decode(const uint8_t* data, size_t len, int32_t sampleRate, int32_t channels,
                                              const uint8_t* codecConfig, size_t configLen) {
    if (data == nullptr || len == 0) return {};
    int32_t sr = sampleRate > 0 ? sampleRate : 48000;
    int32_t ch = channels == 1 ? 1 : 2;
    if (!Init(sr, ch, codecConfig, configLen)) {
        return {};
    }

    OpusImpl& st = S();
    std::lock_guard<std::mutex> lk(st.apiMu);
    if (!st.running || st.codec == nullptr || st.hasError.load()) {
        return {};
    }

    AudioInputSlot slot{};
    {
        std::unique_lock<std::mutex> qlk(st.queueMu);
        st.queueCv.wait_for(qlk, std::chrono::milliseconds(15), [&]() {
            return !st.running || st.hasError.load() || !st.inputSlots.empty();
        });
        if (!st.running || st.hasError.load() || st.inputSlots.empty()) {
            return {};
        }
        slot = st.inputSlots.front();
        st.inputSlots.pop_front();
    }

    if (slot.buffer == nullptr) return {};
    uint8_t* dst = OH_AVBuffer_GetAddr(slot.buffer);
    int32_t cap = OH_AVBuffer_GetCapacity(slot.buffer);
    if (dst == nullptr || cap <= 0 || static_cast<int32_t>(len) > cap) {
        return {};
    }
    std::memcpy(dst, data, len);
    OH_AVCodecBufferAttr attr{};
    attr.pts = st.nextPtsUs;
    attr.size = static_cast<int32_t>(len);
    attr.offset = 0;
    attr.flags = AVCODEC_BUFFER_FLAGS_NONE;
    st.nextPtsUs += 20000;
    OH_AVBuffer_SetBufferAttr(slot.buffer, &attr);
    if (OH_AudioCodec_PushInputBuffer(st.codec, slot.index) != AV_ERR_OK) {
        return {};
    }

    std::vector<uint8_t> merged;
    std::unique_lock<std::mutex> qlk(st.queueMu);
    if (st.outputPcm.empty()) {
        st.queueCv.wait_for(qlk, std::chrono::milliseconds(15), [&]() {
            return !st.running || st.hasError.load() || !st.outputPcm.empty();
        });
    }
    while (!st.outputPcm.empty()) {
        const auto& chunk = st.outputPcm.front();
        merged.insert(merged.end(), chunk.begin(), chunk.end());
        st.outputPcm.pop_front();
    }
    return merged;
}

void OpusAudioDecoder::Destroy() {
    OpusImpl& st = S();
    std::lock_guard<std::mutex> lk(st.apiMu);
    DestroyLocked();
}

OpusAudioDecoder& GetGlobalOpusDecoder() {
    static OpusAudioDecoder inst;
    return inst;
}

} // namespace remotedeck
