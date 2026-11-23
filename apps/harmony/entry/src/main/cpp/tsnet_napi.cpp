#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "napi/native_api.h"
#include "h264_player.h"
#include "opus_decoder.h"
#include "screen_share.h"
#include <hilog/log.h>
#include <dlfcn.h>
#include <signal.h>
#include <ucontext.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

typedef char* (*FnTsnetStart)(char*, char*, char*);
typedef char* (*FnTsnetNoArg)(void);
typedef int (*FnTsnetOpenTunnel)(char*, int);
typedef void (*FnTsnetVoid)(void);
typedef void (*FnTsnetFreeString)(char*);

namespace {
void* g_lib = nullptr;
std::string g_lastDlError;
FnTsnetStart g_start = nullptr;
FnTsnetNoArg g_stop = nullptr;
FnTsnetNoArg g_logout = nullptr;
FnTsnetNoArg g_getStatus = nullptr;
FnTsnetOpenTunnel g_openTunnel = nullptr;
FnTsnetVoid g_closeAllTunnels = nullptr;
FnTsnetFreeString g_freeString = nullptr;

std::string EscapeJson(const std::string& input) {
    std::string out;
    out.reserve(input.size() + 8);
    for (char c : input) {
        if (c == '"' || c == '\\') {
            out.push_back('\\');
            out.push_back(c);
        } else if (c == '\n') {
            out += "\\n";
        } else if (c == '\r') {
            out += "\\r";
        } else {
            out.push_back(c);
        }
    }
    return out;
}

static struct sigaction g_prevSegv {};
static void TempSegvHandler(int sig, siginfo_t* info, void* uctx) {
    auto* uc = static_cast<ucontext_t*>(uctx);
    uintptr_t pc = uc ? static_cast<uintptr_t>(uc->uc_mcontext.pc) : 0;
    uintptr_t lr = uc ? static_cast<uintptr_t>(uc->uc_mcontext.regs[30]) : 0;
    uintptr_t x0 = uc ? static_cast<uintptr_t>(uc->uc_mcontext.regs[0]) : 0;
    uintptr_t x27 = uc ? static_cast<uintptr_t>(uc->uc_mcontext.regs[27]) : 0;
    uintptr_t x28 = uc ? static_cast<uintptr_t>(uc->uc_mcontext.regs[28]) : 0;
    Dl_info dpc {};
    dladdr(reinterpret_cast<void*>(pc), &dpc);
    uintptr_t pcOff = dpc.dli_fbase ? (pc - reinterpret_cast<uintptr_t>(dpc.dli_fbase)) : 0;
    Dl_info dlr {};
    dladdr(reinterpret_cast<void*>(lr), &dlr);
    uintptr_t lrOff = dlr.dli_fbase ? (lr - reinterpret_cast<uintptr_t>(dlr.dli_fbase)) : 0;
    OH_LOG_Print(LOG_APP, LOG_ERROR, 0x0000, "RemoteDeckTs",
        "SEGV addr=%{public}p pc=%{public}p(%{public}s+0x%{public}lx) lr=%{public}p(%{public}s+0x%{public}lx) x0=0x%{public}lx x27=0x%{public}lx x28=0x%{public}lx",
        info ? info->si_addr : nullptr,
        reinterpret_cast<void*>(pc), dpc.dli_fname ? dpc.dli_fname : "?", static_cast<unsigned long>(pcOff),
        reinterpret_cast<void*>(lr), dlr.dli_fname ? dlr.dli_fname : "?", static_cast<unsigned long>(lrOff),
        static_cast<unsigned long>(x0), static_cast<unsigned long>(x27), static_cast<unsigned long>(x28));
    if (g_prevSegv.sa_flags & SA_SIGINFO) {
        if (g_prevSegv.sa_sigaction) g_prevSegv.sa_sigaction(sig, info, uctx);
    } else if (g_prevSegv.sa_handler && g_prevSegv.sa_handler != SIG_DFL && g_prevSegv.sa_handler != SIG_IGN) {
        g_prevSegv.sa_handler(sig);
    }
    std::_Exit(1);
}

void* TryDlopen(const std::string& path, std::string& errors) {
    static bool segvInstalled = false;
    if (!segvInstalled) {
        segvInstalled = true;
        struct sigaction sa {};
        sa.sa_sigaction = TempSegvHandler;
        sa.sa_flags = SA_SIGINFO;
        sigaction(SIGSEGV, &sa, &g_prevSegv);
    }
    dlerror();
    void* h = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!h) {
        const char* err = dlerror();
        if (!errors.empty()) errors += " | ";
        errors += path + ": " + (err ? err : "failed");
    }
    return h;
}

bool EnsureBridgeLoaded() {
    if (g_lib != nullptr) {
        return g_start != nullptr;
    }
    std::string errors;
    Dl_info dli {};
    if (dladdr(reinterpret_cast<void*>(&EnsureBridgeLoaded), &dli) != 0 && dli.dli_fname) {
        std::string selfPath(dli.dli_fname);
        size_t slash = selfPath.find_last_of('/');
        if (slash != std::string::npos) {
            std::string sibling = selfPath.substr(0, slash + 1) + "libtsnet_bridge.so";
            g_lib = TryDlopen(sibling, errors);
        }
    }
    if (!g_lib) {
        g_lib = TryDlopen("libtsnet_bridge.so", errors);
    }
    if (!g_lib) {
        g_lib = TryDlopen("/data/storage/el1/bundle/libs/arm64/libtsnet_bridge.so", errors);
    }
    if (!g_lib) {
        g_lastDlError = errors.empty() ? "dlopen failed" : errors;
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x0000, "RemoteDeckTs", "EnsureBridgeLoaded dlopen failed: %{public}s", g_lastDlError.c_str());
        return false;
    }
    g_start = reinterpret_cast<FnTsnetStart>(dlsym(g_lib, "TsnetStart"));
    g_stop = reinterpret_cast<FnTsnetNoArg>(dlsym(g_lib, "TsnetStop"));
    g_logout = reinterpret_cast<FnTsnetNoArg>(dlsym(g_lib, "TsnetLogout"));
    g_getStatus = reinterpret_cast<FnTsnetNoArg>(dlsym(g_lib, "TsnetGetStatus"));
    g_openTunnel = reinterpret_cast<FnTsnetOpenTunnel>(dlsym(g_lib, "TsnetOpenTunnel"));
    g_closeAllTunnels = reinterpret_cast<FnTsnetVoid>(dlsym(g_lib, "TsnetCloseAllTunnels"));
    g_freeString = reinterpret_cast<FnTsnetFreeString>(dlsym(g_lib, "TsnetFreeString"));
    if (!g_start || !g_getStatus || !g_openTunnel) {
        g_lastDlError = "dlsym missing TsnetStart/TsnetGetStatus/TsnetOpenTunnel";
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x0000, "RemoteDeckTs", "EnsureBridgeLoaded dlsym failed: %{public}s", g_lastDlError.c_str());
        return false;
    }
    g_lastDlError.clear();
    return true;
}

std::string ReadStringArg(napi_env env, napi_value val) {
    size_t len = 0;
    if (napi_get_value_string_utf8(env, val, nullptr, 0, &len) != napi_ok) {
        return "";
    }
    std::string out(len, '\0');
    if (len > 0) {
        size_t copied = 0;
        napi_get_value_string_utf8(env, val, &out[0], len + 1, &copied);
        out.resize(copied);
    }
    return out;
}

napi_value MakeString(napi_env env, const char* s) {
    napi_value res = nullptr;
    napi_create_string_utf8(env, s ? s : "", NAPI_AUTO_LENGTH, &res);
    return res;
}

napi_value ConsumeGoJson(napi_env env, char* raw) {
    if (!raw) {
        return MakeString(env, "{\"ok\":false,\"error\":\"null result\"}");
    }
    napi_value res = MakeString(env, raw);
    if (g_freeString) {
        g_freeString(raw);
    } else {
        std::free(raw);
    }
    return res;
}

napi_value JsStart(napi_env env, napi_callback_info info) {
    if (!EnsureBridgeLoaded()) {
        std::string json = std::string("{\"ok\":false,\"error\":\"") + EscapeJson(g_lastDlError) + "\"}";
        return MakeString(env, json.c_str());
    }
    size_t argc = 3;
    napi_value args[3] = {nullptr, nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    std::string stateDir = argc >= 1 ? ReadStringArg(env, args[0]) : "";
    std::string hostname = argc >= 2 ? ReadStringArg(env, args[1]) : "remotedeck-ohos";
    std::string authKey = argc >= 3 ? ReadStringArg(env, args[2]) : "";
    char* raw = g_start(const_cast<char*>(stateDir.c_str()),
                        const_cast<char*>(hostname.c_str()),
                        const_cast<char*>(authKey.c_str()));
    return ConsumeGoJson(env, raw);
}

napi_value JsStop(napi_env env, napi_callback_info /*info*/) {
    if (!EnsureBridgeLoaded() || !g_stop) {
        return MakeString(env, "{\"ok\":false}");
    }
    return ConsumeGoJson(env, g_stop());
}

napi_value JsLogout(napi_env env, napi_callback_info /*info*/) {
    if (!EnsureBridgeLoaded() || !g_logout) {
        return MakeString(env, "{\"ok\":false}");
    }
    return ConsumeGoJson(env, g_logout());
}

napi_value JsGetStatus(napi_env env, napi_callback_info /*info*/) {
    if (!EnsureBridgeLoaded() || !g_getStatus) {
        std::string json = std::string("{\"enabled\":false,\"state\":\"Unavailable\",\"tailscaleIp\":\"\",\"hostname\":\"\",\"authUrl\":\"\",\"lastError\":\"") +
            EscapeJson(g_lastDlError) + "\",\"peers\":[]}";
        return MakeString(env, json.c_str());
    }
    return ConsumeGoJson(env, g_getStatus());
}

napi_value JsOpenTunnel(napi_env env, napi_callback_info info) {
    napi_value zero = nullptr;
    napi_create_int32(env, 0, &zero);
    if (!EnsureBridgeLoaded() || !g_openTunnel) {
        return zero;
    }
    size_t argc = 2;
    napi_value args[2] = {nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc < 2) {
        return zero;
    }
    std::string targetIp = ReadStringArg(env, args[0]);
    int32_t targetPort = 9601;
    napi_get_value_int32(env, args[1], &targetPort);
    int localPort = g_openTunnel(const_cast<char*>(targetIp.c_str()), targetPort);
    napi_value out = nullptr;
    napi_create_int32(env, localPort, &out);
    return out;
}

napi_value JsCloseAllTunnels(napi_env env, napi_callback_info /*info*/) {
    if (EnsureBridgeLoaded() && g_closeAllTunnels) {
        g_closeAllTunnels();
    }
    napi_value undef = nullptr;
    napi_get_undefined(env, &undef);
    return undef;
}

napi_value JsVideoInit(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3] = {nullptr, nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    std::string surfaceId = argc >= 1 ? ReadStringArg(env, args[0]) : "";
    int32_t width = 0;
    int32_t height = 0;
    if (argc >= 2 && args[1] != nullptr) napi_get_value_int32(env, args[1], &width);
    if (argc >= 3 && args[2] != nullptr) napi_get_value_int32(env, args[2], &height);
    bool ok = remotedeck::GetGlobalH264Decoder().Init(surfaceId, width, height);
    napi_value out = nullptr;
    napi_get_boolean(env, ok, &out);
    return out;
}

napi_value JsVideoPush(napi_env env, napi_callback_info info) {
    size_t argc = 5;
    napi_value args[5] = {nullptr, nullptr, nullptr, nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    int32_t resCode = 0;
    if (argc >= 1 && args[0] != nullptr) {
        bool isAb = false;
        napi_is_arraybuffer(env, args[0], &isAb);
        void* bufData = nullptr;
        size_t bufLen = 0;
        if (isAb) {
            napi_get_arraybuffer_info(env, args[0], &bufData, &bufLen);
        } else {
            bool isTa = false;
            napi_is_typedarray(env, args[0], &isTa);
            if (isTa) {
                napi_typedarray_type tt;
                napi_value ab = nullptr;
                size_t byteOffset = 0;
                napi_get_typedarray_info(env, args[0], &tt, &bufLen, &bufData, &ab, &byteOffset);
            }
        }
        int64_t ptsUs = 0;
        bool isKey = false;
        int32_t width = 0;
        int32_t height = 0;
        if (argc >= 2 && args[1] != nullptr) napi_get_value_int64(env, args[1], &ptsUs);
        if (argc >= 3 && args[2] != nullptr) napi_get_value_bool(env, args[2], &isKey);
        if (argc >= 4 && args[3] != nullptr) napi_get_value_int32(env, args[3], &width);
        if (argc >= 5 && args[4] != nullptr) napi_get_value_int32(env, args[4], &height);
        resCode = remotedeck::GetGlobalH264Decoder().PushFrame(
            static_cast<const uint8_t*>(bufData), bufLen, ptsUs, isKey, width, height);
    }
    napi_value out = nullptr;
    napi_create_int32(env, resCode, &out);
    return out;
}

napi_value JsVideoReset(napi_env env, napi_callback_info /*info*/) {
    remotedeck::GetGlobalH264Decoder().Reset();
    napi_value undef = nullptr;
    napi_get_undefined(env, &undef);
    return undef;
}

napi_value JsVideoDestroy(napi_env env, napi_callback_info /*info*/) {
    remotedeck::GetGlobalH264Decoder().Destroy();
    napi_value undef = nullptr;
    napi_get_undefined(env, &undef);
    return undef;
}

napi_value JsShareStart(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value args[4] = {nullptr, nullptr, nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    int32_t port = 9603;
    int32_t width = 720;
    int32_t height = 1156;
    int32_t fps = 30;
    if (argc >= 1 && args[0] != nullptr) napi_get_value_int32(env, args[0], &port);
    if (argc >= 2 && args[1] != nullptr) napi_get_value_int32(env, args[1], &width);
    if (argc >= 3 && args[2] != nullptr) napi_get_value_int32(env, args[2], &height);
    if (argc >= 4 && args[3] != nullptr) napi_get_value_int32(env, args[3], &fps);
    bool ok = remotedeck::GetGlobalScreenShare().Start(port, width, height, fps);
    napi_value out = nullptr;
    napi_get_boolean(env, ok, &out);
    return out;
}

napi_value JsShareStop(napi_env env, napi_callback_info /*info*/) {
    remotedeck::GetGlobalScreenShare().Stop();
    napi_value undef = nullptr;
    napi_get_undefined(env, &undef);
    return undef;
}

napi_value JsShareStatus(napi_env env, napi_callback_info /*info*/) {
    std::string json = remotedeck::GetGlobalScreenShare().GetStatusJson();
    napi_value out = nullptr;
    napi_create_string_utf8(env, json.c_str(), json.size(), &out);
    return out;
}

napi_value JsShareKeyFrame(napi_env env, napi_callback_info /*info*/) {
    remotedeck::GetGlobalScreenShare().RequestKeyFrame();
    napi_value undef = nullptr;
    napi_get_undefined(env, &undef);
    return undef;
}

napi_value JsShareResize(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2] = {nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    int32_t w = 720;
    int32_t h = 1156;
    if (argc >= 1 && args[0] != nullptr) napi_get_value_int32(env, args[0], &w);
    if (argc >= 2 && args[1] != nullptr) napi_get_value_int32(env, args[1], &h);
    bool ok = remotedeck::GetGlobalScreenShare().Resize(w, h);
    napi_value out = nullptr;
    napi_get_boolean(env, ok, &out);
    return out;
}

bool ReadBytesArg(napi_env env, napi_value val, const uint8_t** outPtr, size_t* outLen) {
    if (val == nullptr) return false;
    bool isAb = false;
    napi_is_arraybuffer(env, val, &isAb);
    if (isAb) {
        void* data = nullptr;
        size_t len = 0;
        if (napi_get_arraybuffer_info(env, val, &data, &len) == napi_ok && data != nullptr) {
            *outPtr = static_cast<const uint8_t*>(data);
            *outLen = len;
            return true;
        }
    }
    bool isTa = false;
    napi_is_typedarray(env, val, &isTa);
    if (isTa) {
        napi_typedarray_type tt;
        void* data = nullptr;
        size_t len = 0;
        napi_value ab = nullptr;
        size_t byteOffset = 0;
        if (napi_get_typedarray_info(env, val, &tt, &len, &data, &ab, &byteOffset) == napi_ok && data != nullptr) {
            *outPtr = static_cast<const uint8_t*>(data);
            *outLen = len;
            return true;
        }
    }
    return false;
}

napi_value JsAudioOpusInit(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3] = {nullptr, nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    int32_t sampleRate = 48000;
    int32_t channels = 2;
    if (argc >= 1 && args[0] != nullptr) napi_get_value_int32(env, args[0], &sampleRate);
    if (argc >= 2 && args[1] != nullptr) napi_get_value_int32(env, args[1], &channels);
    const uint8_t* headPtr = nullptr;
    size_t headLen = 0;
    if (argc >= 3 && args[2] != nullptr) {
        ReadBytesArg(env, args[2], &headPtr, &headLen);
    }
    bool ok = remotedeck::GetGlobalOpusDecoder().Init(sampleRate, channels, headPtr, headLen);
    napi_value out = nullptr;
    napi_get_boolean(env, ok, &out);
    return out;
}

napi_value JsAudioOpusDecode(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value args[4] = {nullptr, nullptr, nullptr, nullptr};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    const uint8_t* pktPtr = nullptr;
    size_t pktLen = 0;
    int32_t sampleRate = 48000;
    int32_t channels = 2;
    const uint8_t* headPtr = nullptr;
    size_t headLen = 0;
    if (argc >= 1 && args[0] != nullptr) ReadBytesArg(env, args[0], &pktPtr, &pktLen);
    if (argc >= 2 && args[1] != nullptr) napi_get_value_int32(env, args[1], &sampleRate);
    if (argc >= 3 && args[2] != nullptr) napi_get_value_int32(env, args[2], &channels);
    if (argc >= 4 && args[3] != nullptr) ReadBytesArg(env, args[3], &headPtr, &headLen);

    std::vector<uint8_t> pcm;
    if (pktPtr != nullptr && pktLen > 0) {
        pcm = remotedeck::GetGlobalOpusDecoder().Decode(pktPtr, pktLen, sampleRate, channels, headPtr, headLen);
    }
    void* outData = nullptr;
    napi_value outAb = nullptr;
    napi_create_arraybuffer(env, pcm.size(), &outData, &outAb);
    if (!pcm.empty() && outData != nullptr) {
        std::memcpy(outData, pcm.data(), pcm.size());
    }
    return outAb;
}

napi_value JsAudioOpusDestroy(napi_env env, napi_callback_info /*info*/) {
    remotedeck::GetGlobalOpusDecoder().Destroy();
    napi_value undef = nullptr;
    napi_get_undefined(env, &undef);
    return undef;
}
} // namespace

EXTERN_C_START
static napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
        {"start", nullptr, JsStart, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"stop", nullptr, JsStop, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"logout", nullptr, JsLogout, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"getStatus", nullptr, JsGetStatus, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"openTunnel", nullptr, JsOpenTunnel, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"closeAllTunnels", nullptr, JsCloseAllTunnels, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"videoInit", nullptr, JsVideoInit, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"videoPush", nullptr, JsVideoPush, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"videoReset", nullptr, JsVideoReset, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"videoDestroy", nullptr, JsVideoDestroy, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"shareStart", nullptr, JsShareStart, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"shareStop", nullptr, JsShareStop, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"shareStatus", nullptr, JsShareStatus, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"shareKeyFrame", nullptr, JsShareKeyFrame, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"shareResize", nullptr, JsShareResize, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"audioOpusInit", nullptr, JsAudioOpusInit, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"audioOpusDecode", nullptr, JsAudioOpusDecode, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"audioOpusDestroy", nullptr, JsAudioOpusDestroy, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
    return exports;
}
EXTERN_C_END

static napi_module demoModule = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = nullptr,
    .nm_register_func = Init,
    .nm_modname = "remotedeck_ts",
    .nm_priv = ((void*)0),
    .reserved = {0},
};

extern "C" __attribute__((constructor)) void RegisterRemotedeckTsModule(void) {
    napi_module_register(&demoModule);
}
