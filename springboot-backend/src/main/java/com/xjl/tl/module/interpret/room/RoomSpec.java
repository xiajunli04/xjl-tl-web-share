package com.xjl.tl.module.interpret.room;

import java.util.List;
import java.util.Map;

/**
 * 创建房间所需的会话设置（InterpretService 校验后构造）。
 *
 * @param sessionId       会话 id
 * @param hostUserId      创建者
 * @param mode            LISTEN | CONVERSE | ROOM | CHAT
 * @param engine          同传引擎 id
 * @param s2s             是否厂商语音到语音引擎
 * @param maxLanguages    会议室语言数上限（级联 6 / S2S 4）
 * @param engineLanguages 引擎支持的语言（空表示不限制）
 * @param roomCode        房间码（仅 ROOM）
 * @param languages       会话语言：LISTEN [目标]；CONVERSE [A, B]；ROOM [主持人语言]；CHAT [我的语言, 对话语言]
 * @param sourceHints     LISTEN 的源语种提示
 * @param converseRouting CONVERSE 路由 auto | ptt
 * @param glossaryIds     术语库
 * @param domainHint      领域提示
 * @param tts             是否语音播报
 * @param gender          音色性别
 * @param voices          各语言音色
 * @param asrEngine       级联识别引擎
 * @param ttsEngine       级联合成引擎
 * @param modelConfigId   模型配置
 * @param hostName        主持人显示名
 * @param chatScenario    AI 对话场景（仅 CHAT）
 * @param latencyMode     响应速度 balanced | fast（仅对平台级联生效）
 */
public record RoomSpec(long sessionId, Long hostUserId, String mode, String engine, boolean s2s, int maxLanguages,
                       List<String> engineLanguages, String roomCode, List<String> languages, List<String> sourceHints,
                       String converseRouting, List<Long> glossaryIds, String domainHint, boolean tts, String gender,
                       Map<String, String> voices, String asrEngine, String ttsEngine, Long modelConfigId,
                       String hostName, String chatScenario, String latencyMode) {

    public boolean chat() {
        return "CHAT".equals(mode);
    }
}
