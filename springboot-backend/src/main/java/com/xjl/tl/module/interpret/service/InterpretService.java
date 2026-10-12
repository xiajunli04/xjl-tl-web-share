package com.xjl.tl.module.interpret.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.FieldError;
import com.xjl.tl.common.PageQuery;
import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.config.MediaProperties;
import com.xjl.tl.common.config.TranslateProperties;
import com.xjl.tl.common.mybatis.SqlUtils;
import com.xjl.tl.module.glossary.service.GlossaryService;
import com.xjl.tl.module.interpret.dto.InterpretDtos;
import com.xjl.tl.module.interpret.dto.InterpretDtos.InterpretCreateRequest;
import com.xjl.tl.module.interpret.dto.InterpretDtos.InterpretJoinVO;
import com.xjl.tl.module.interpret.dto.InterpretDtos.InterpretQuery;
import com.xjl.tl.module.interpret.dto.InterpretDtos.InterpretSegmentVO;
import com.xjl.tl.module.interpret.dto.InterpretDtos.InterpretSessionVO;
import com.xjl.tl.module.interpret.dto.InterpretDtos.JoinRequest;
import com.xjl.tl.module.interpret.entity.InterpretSegment;
import com.xjl.tl.module.interpret.entity.InterpretSession;
import com.xjl.tl.module.interpret.mapper.InterpretSegmentMapper;
import com.xjl.tl.module.interpret.mapper.InterpretSessionMapper;
import com.xjl.tl.module.interpret.room.Member;
import com.xjl.tl.module.interpret.room.Room;
import com.xjl.tl.module.interpret.room.RoomRegistry;
import com.xjl.tl.module.interpret.room.RoomSpec;
import com.xjl.tl.module.interpret.service.SegmentWriter.FinishInfo;
import com.xjl.tl.module.model.service.ModelConfigService;
import com.xjl.tl.module.speech.dto.SpeechDtos.EngineInfo;
import com.xjl.tl.module.speech.service.SpeechService;
import com.xjl.tl.module.translate.SupportedLanguage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.security.SecureRandom;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * 同传会话（add-speech-and-image-translation D2 / D3 / D9 / D13，契约 §2.4）：创建、加入会议室、重取票据、结束，
 * 以及同传历史（列表、详情、转写分页、收藏、删除，只有创建者可见）。
 * <ul>
 *   <li>校验：LISTEN 一个目标语言；CONVERSE 两种不同语言（A0410）；ROOM 一个本人语言；引擎须在 Python 引擎列表中可用（C0173）；
 *       S2S 引擎（或不支持自动方向的引擎）+ converseRouting=auto → A0410；每个用户最多一个进行中的会话（A0214）</li>
 *   <li>进程重启后数据库中残留的 ACTIVE 会话没有内存房间：创建、重取票据、结束、删除时就地结束</li>
 * </ul>
 */
@Service
public class InterpretService {

    public static final String DEFAULT_ENGINE = "cascade";
    /** AI 对话的实时语音模型引擎（improve-speech-playback-latency D7）。 */
    public static final String REALTIME_CHAT_ENGINE = "realtime-chat";
    public static final String DEFAULT_LATENCY_MODE = "balanced";
    public static final String DEFAULT_CHAT_SCENARIO = "free";
    static final int ROOM_CODE_LENGTH = 6;
    static final int MAX_SOURCE_HINTS = 5;
    private static final long END_WAIT_SECONDS = 15;
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Logger log = LoggerFactory.getLogger(InterpretService.class);

    private final InterpretSessionMapper sessionMapper;
    private final InterpretSegmentMapper segmentMapper;
    private final RoomRegistry registry;
    private final SegmentWriter segmentWriter;
    private final WsTicketService ticketService;
    private final SpeechService speechService;
    private final GlossaryService glossaryService;
    private final ModelConfigService modelConfigService;
    private final MediaProperties mediaProps;
    private final TranslateProperties translateProps;
    private final JsonMapper jsonMapper;

    public InterpretService(InterpretSessionMapper sessionMapper, InterpretSegmentMapper segmentMapper,
                            RoomRegistry registry, SegmentWriter segmentWriter, WsTicketService ticketService,
                            SpeechService speechService, GlossaryService glossaryService,
                            ModelConfigService modelConfigService, MediaProperties mediaProps,
                            TranslateProperties translateProps, JsonMapper jsonMapper) {
        this.sessionMapper = sessionMapper;
        this.segmentMapper = segmentMapper;
        this.registry = registry;
        this.segmentWriter = segmentWriter;
        this.ticketService = ticketService;
        this.speechService = speechService;
        this.glossaryService = glossaryService;
        this.modelConfigService = modelConfigService;
        this.mediaProps = mediaProps;
        this.translateProps = translateProps;
        this.jsonMapper = jsonMapper;
    }

    // ---------------- 创建 / 加入 / 票据 / 结束 ----------------

    public InterpretJoinVO create(Long userId, String username, InterpretCreateRequest req) {
        String mode = req.mode();
        String engineId = StringUtils.hasText(req.engine()) ? req.engine().trim() : DEFAULT_ENGINE;
        List<String> languages = req.languages().stream().map(String::trim).toList();
        languages.forEach(l -> SupportedLanguage.require("languages", l));
        switch (mode) {
            case InterpretSession.MODE_LISTEN -> {
                if (languages.size() != 1) {
                    throw FieldError.invalid("languages", "同传收听需要且只需要一个目标语言");
                }
            }
            case InterpretSession.MODE_CONVERSE -> {
                if (languages.size() != 2) {
                    throw FieldError.invalid("languages", "双向对话需要两种语言");
                }
                if (languages.get(0).equals(languages.get(1))) {
                    throw FieldError.invalid("languages", "双向对话的两种语言必须不同");
                }
            }
            case InterpretSession.MODE_CHAT -> {
                if (languages.size() != 2) {
                    throw FieldError.invalid("languages", "AI 对话需要指定我的语言与对话语言");
                }
                if (!DEFAULT_ENGINE.equals(engineId) && !REALTIME_CHAT_ENGINE.equals(engineId)) {
                    throw FieldError.invalid("engine", "AI 对话仅支持平台级联或实时语音模型");
                }
            }
            default -> {
                if (languages.size() != 1) {
                    throw FieldError.invalid("languages", "会议室需要且只需要一个本人语言");
                }
            }
        }
        if (!InterpretSession.MODE_CHAT.equals(mode) && REALTIME_CHAT_ENGINE.equals(engineId)) {
            throw FieldError.invalid("engine", "实时语音模型只用于 AI 对话");
        }
        List<String> hints = InterpretSession.MODE_LISTEN.equals(mode) && req.sourceHints() != null
                ? req.sourceHints().stream().filter(StringUtils::hasText).map(String::trim).distinct().toList()
                : List.of();
        if (hints.size() > MAX_SOURCE_HINTS) {
            throw FieldError.invalid("sourceHints", "源语种提示最多 " + MAX_SOURCE_HINTS + " 个");
        }
        hints.forEach(h -> SupportedLanguage.require("sourceHints", h));
        List<Long> glossaryIds = req.glossaryIds() == null ? List.of() : List.copyOf(new LinkedHashSet<>(req.glossaryIds()));
        if (glossaryIds.size() > translateProps.maxGlossaries()) {
            throw FieldError.invalid("glossaryIds", "最多选择 " + translateProps.maxGlossaries() + " 个术语库");
        }
        glossaryService.requireReadable(userId, glossaryIds);
        if (req.modelConfigId() != null) {
            modelConfigService.requireEnabled(req.modelConfigId());
        }
        // AI 对话的引擎可用性来自 chat 类别（平台级联 / 实时语音模型），其余模式来自 interpret 类别
        EngineInfo engine = InterpretSession.MODE_CHAT.equals(mode)
                ? speechService.requireChatEngine(engineId) : speechService.requireInterpretEngine(engineId);
        List<String> engineLanguages = engine.languages() == null ? List.of() : engine.languages();
        for (String l : languages) {
            if (!engineLanguages.isEmpty() && !engineLanguages.contains(l)) {
                throw FieldError.invalid("languages", "所选引擎不支持语言：" + l);
            }
        }
        boolean autoUnsupported = engine.speechToSpeech() || Boolean.FALSE.equals(engine.autoConverse());
        String routing = null;
        if (InterpretSession.MODE_CONVERSE.equals(mode)) {
            routing = StringUtils.hasText(req.converseRouting()) ? req.converseRouting() : (autoUnsupported ? "ptt" : "auto");
            if ("auto".equals(routing) && autoUnsupported) {
                throw FieldError.invalid("converseRouting", "该引擎仅支持按键说话");
            }
        }
        ensureNoActive(userId);

        boolean tts = req.tts() == null || req.tts();
        String gender = StringUtils.hasText(req.gender()) ? req.gender() : "female";
        Map<String, String> voices = req.voices() == null ? Map.of() : new LinkedHashMap<>(req.voices());
        String domainHint = StringUtils.hasText(req.domainHint()) ? req.domainHint().trim() : null;
        String hostName = StringUtils.hasText(req.displayName()) ? req.displayName().trim()
                : (InterpretSession.MODE_ROOM.equals(mode) ? "主持人" : username);
        ObjectNode options = jsonMapper.createObjectNode();
        options.set("sourceHints", jsonMapper.valueToTree(hints));
        options.put("converseRouting", routing);
        options.set("glossaryIds", jsonMapper.valueToTree(glossaryIds));
        options.put("domainHint", domainHint);
        options.put("tts", tts);
        options.put("headphone", Boolean.TRUE.equals(req.headphone()));
        options.put("gender", gender);
        options.set("voices", jsonMapper.valueToTree(voices));
        options.put("asrEngine", blankToNull(req.asrEngine()));
        options.put("ttsEngine", blankToNull(req.ttsEngine()));
        if (req.modelConfigId() == null) {
            options.putNull("modelConfigId");
        } else {
            options.put("modelConfigId", req.modelConfigId());
        }
        options.put("displayName", hostName);
        String chatScenario = InterpretSession.MODE_CHAT.equals(mode)
                ? (StringUtils.hasText(req.chatScenario()) ? req.chatScenario() : DEFAULT_CHAT_SCENARIO) : null;
        if (chatScenario != null) {
            options.put("chatScenario", chatScenario);
        }
        String latencyMode = StringUtils.hasText(req.latencyMode()) ? req.latencyMode() : DEFAULT_LATENCY_MODE;
        options.put("latencyMode", latencyMode);

        InterpretSession s = insertSession(userId, mode, engineId, languages, options, req.title());
        int maxLanguages = engine.speechToSpeech() ? mediaProps.roomMaxLanguagesS2s() : mediaProps.roomMaxLanguagesCascade();
        RoomSpec spec = new RoomSpec(s.getId(), userId, mode, engineId, engine.speechToSpeech(), maxLanguages,
                engineLanguages, s.getRoomCode(), languages, hints, routing, glossaryIds, domainHint, tts, gender, voices,
                blankToNull(req.asrEngine()), blankToNull(req.ttsEngine()), req.modelConfigId(), hostName,
                chatScenario, latencyMode);
        Room room = registry.open(spec);
        return joinVO(room, registry.host(room), userId);
    }

    /** 已有 ACTIVE 会话：内存中有房间则 A0214；没有（进程重启后的残留）则就地结束。 */
    private void ensureNoActive(Long userId) {
        InterpretSession active = sessionMapper.selectOne(new LambdaQueryWrapper<InterpretSession>()
                .eq(InterpretSession::getUserId, userId)
                .eq(InterpretSession::getStatus, InterpretSession.STATUS_ACTIVE)
                .last("LIMIT 1"));
        if (active == null) {
            return;
        }
        if (registry.find(active.getId()) != null) {
            // 带上进行中的会话，前端据此提供「继续 / 结束并重新开始」，而不是只提示错误
            throw new BizException(ErrorCode.SESSION_BUSY, "已有进行中的同传会话，请先结束", toVO(active));
        }
        endStale(active);
    }

    /**
     * 当前用户进行中的同传会话（刷新页面后用于恢复）；没有返回 null。
     * 库中 ACTIVE 但内存里没有房间（进程重启后的残留）时就地结束并返回 null。
     */
    public InterpretSessionVO active(Long userId) {
        InterpretSession active = sessionMapper.selectOne(new LambdaQueryWrapper<InterpretSession>()
                .eq(InterpretSession::getUserId, userId)
                .eq(InterpretSession::getStatus, InterpretSession.STATUS_ACTIVE)
                .last("LIMIT 1"));
        if (active == null) {
            return null;
        }
        if (registry.find(active.getId()) == null) {
            endStale(active);
            return null;
        }
        return toVO(active);
    }

    /** 插入会话；会议室生成 6 位房间码（与进行中的房间冲突时重试），唯一索引冲突视为并发创建（A0214）。 */
    private InterpretSession insertSession(Long userId, String mode, String engine, List<String> languages,
                                           ObjectNode options, String title) {
        boolean room = InterpretSession.MODE_ROOM.equals(mode);
        for (int attempt = 0; attempt < 8; attempt++) {
            String code = room ? newRoomCode() : null;
            InterpretSession s = new InterpretSession();
            s.setUserId(userId);
            s.setMode(mode);
            s.setEngine(engine);
            s.setLanguages(jsonMapper.valueToTree(languages));
            s.setRoomCode(code);
            s.setOptions(options);
            s.setStatus(InterpretSession.STATUS_ACTIVE);
            s.setTitle(StringUtils.hasText(title) ? title.trim() : defaultTitle(mode, languages, code));
            s.setStartedAt(OffsetDateTime.now());
            s.setFavorite(false);
            s.setDeleted(false);
            try {
                sessionMapper.insert(s);
                return s;
            } catch (DuplicateKeyException e) {
                if (room && String.valueOf(e.getMessage()).contains("uk_interpret_session_room")) {
                    continue;
                }
                throw new BizException(ErrorCode.SESSION_BUSY, "已有进行中的同传会话，请先结束");
            }
        }
        throw new BizException(ErrorCode.SYSTEM_ERROR, "房间码生成失败，请重试");
    }

    private String newRoomCode() {
        String code;
        do {
            StringBuilder sb = new StringBuilder(ROOM_CODE_LENGTH);
            for (int i = 0; i < ROOM_CODE_LENGTH; i++) {
                sb.append(RoomRegistry.CODE_ALPHABET.charAt(RANDOM.nextInt(RoomRegistry.CODE_ALPHABET.length())));
            }
            code = sb.toString();
        } while (registry.codeInUse(code));
        return code;
    }

    /** 标题缺省：同传收听 · 中文 / 双向对话 · 中文 ⇄ 英语 / AI 对话 · 英语 / 会议室 K7M2QX。 */
    static String defaultTitle(String mode, List<String> languages, String code) {
        return switch (mode) {
            case InterpretSession.MODE_LISTEN -> "同传收听 · " + cnName(languages.getFirst());
            case InterpretSession.MODE_CONVERSE -> "双向对话 · " + cnName(languages.get(0)) + " ⇄ " + cnName(languages.get(1));
            case InterpretSession.MODE_CHAT -> "AI 对话 · " + cnName(languages.get(1));
            default -> "会议室 " + code;
        };
    }

    private static String cnName(String code) {
        for (SupportedLanguage l : SupportedLanguage.values()) {
            if (l.code().equals(code)) {
                return l.cnName();
            }
        }
        return code;
    }

    /** 加入会议室：房间不存在或已关闭 A0452，人数 / 语言数超限 A0451。 */
    public InterpretJoinVO join(Long userId, String username, String code, JoinRequest req) {
        String lang = req.lang().trim();
        SupportedLanguage.require("lang", lang);
        String name = StringUtils.hasText(req.displayName()) ? req.displayName().trim() : username;
        Room room = registry.findByCode(code);
        if (room == null) {
            throw new BizException(ErrorCode.ROOM_NOT_FOUND);
        }
        Member m = registry.join(code, userId, name, lang, blankToNull(req.participantId()), req.tts());
        return joinVO(room, m, userId);
    }

    /** 创建者重连：为主持人身份签发新票据。会话已结束或房间已不存在返回 A0452。 */
    public InterpretJoinVO ticket(Long userId, Long id) {
        InterpretSession s = getOwned(userId, id);
        if (!InterpretSession.STATUS_ACTIVE.equals(s.getStatus())) {
            throw new BizException(ErrorCode.ROOM_NOT_FOUND, "同传会话已结束");
        }
        Room room = registry.find(id);
        if (room == null) {
            endStale(s);
            throw new BizException(ErrorCode.ROOM_NOT_FOUND, "同传会话已结束");
        }
        return joinVO(room, registry.host(room), userId);
    }

    /** 结束会话（幂等）：等待转写写完与统计更新后返回最新会话。 */
    public InterpretSessionVO end(Long userId, Long id) {
        InterpretSession s = getOwned(userId, id);
        if (InterpretSession.STATUS_ACTIVE.equals(s.getStatus())) {
            if (registry.find(id) != null) {
                try {
                    registry.end(id, RoomRegistry.REASON_USER_END).get(END_WAIT_SECONDS, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new BizException(ErrorCode.SYSTEM_ERROR, "结束同传会话被中断");
                } catch (Exception e) {
                    log.error("结束同传会话失败 id={}", id, e);
                    throw new BizException(ErrorCode.SYSTEM_ERROR, "结束同传会话失败，请重试");
                }
            } else {
                endStale(s);
            }
        }
        return toVO(getOwned(userId, id));
    }

    /** 没有内存房间的 ACTIVE 会话：直接写入统计并结束。 */
    private void endStale(InterpretSession s) {
        log.info("结束残留的同传会话 id={}", s.getId());
        List<String> langs = new ArrayList<>();
        if (s.getLanguages() != null) {
            s.getLanguages().forEach(n -> langs.add(n.asString()));
        }
        try {
            segmentWriter.finish(new FinishInfo(s.getId(), List.of(), 1, langs)).get(END_WAIT_SECONDS, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            log.error("结束残留的同传会话失败 id={}", s.getId(), e);
            throw new BizException(ErrorCode.SYSTEM_ERROR, "结束同传会话失败，请重试");
        }
    }

    private InterpretJoinVO joinVO(Room room, Member m, Long userId) {
        String ticket = ticketService.issue(userId, room.sessionId(), m.participantId());
        RoomSpec spec = room.spec();
        List<String> languages = InterpretSession.MODE_ROOM.equals(spec.mode()) ? List.of(m.lang()) : spec.languages();
        return new InterpretJoinVO(room.sessionId(), m.participantId(), ticket, spec.roomCode(), spec.mode(),
                spec.engine(), languages, m.host(), InterpretDtos.WS_URL);
    }

    // ---------------- 历史 ----------------

    public PageResult<InterpretSessionVO> page(Long userId, InterpretQuery q) {
        String kw = q.getKeyword();
        String pattern = StringUtils.hasText(kw) ? SqlUtils.containsPattern(kw) : null;
        QueryWrapper<InterpretSession> w = new QueryWrapper<InterpretSession>()
                .eq("user_id", userId)
                .apply(pattern != null, """
                        (title ILIKE {0} OR EXISTS (SELECT 1 FROM biz.interpret_segment g WHERE g.session_id = interpret_session.id
                          AND (g.source_text ILIKE {0} OR EXISTS (SELECT 1 FROM jsonb_each_text(g.translations) t WHERE t.value ILIKE {0}))))""",
                        pattern)
                .eq(StringUtils.hasText(q.getMode()), "mode", q.getMode())
                .eq(q.getFavorite() != null, "favorite", q.getFavorite())
                .ge(q.getFrom() != null, "created_at", q.getFrom())
                .lt(q.getTo() != null, "created_at", q.getTo())
                .orderByDesc("created_at", "id");
        Page<InterpretSession> page = sessionMapper.selectPage(q.toPage(), w);
        return PageResult.of(page, InterpretService::toVO);
    }

    public InterpretSessionVO detail(Long userId, Long id) {
        return toVO(getOwned(userId, id));
    }

    /** 转写分页：按 seq 升序，每页最多 100 条。 */
    public PageResult<InterpretSegmentVO> segments(Long userId, Long id, PageQuery q) {
        getOwned(userId, id);
        Page<InterpretSegment> page = segmentMapper.selectPage(q.toPage(), new LambdaQueryWrapper<InterpretSegment>()
                .eq(InterpretSegment::getSessionId, id)
                .orderByAsc(InterpretSegment::getSeq));
        return PageResult.of(page, g -> new InterpretSegmentVO(g.getSeq(), g.getSpeakerParticipant(), g.getSpeakerName(),
                g.getSourceLang(), g.getSourceText(), g.getTranslations(), g.getMetrics(), g.getStartedMs(),
                g.getEndedMs()));
    }

    public void setFavorite(Long userId, Long id, boolean favorite) {
        getOwned(userId, id);
        sessionMapper.update(null, new LambdaUpdateWrapper<InterpretSession>()
                .eq(InterpretSession::getId, id)
                .set(InterpretSession::getFavorite, favorite));
    }

    /** 删除（逻辑删除）：进行中的会话先结束。 */
    public void delete(Long userId, Long id) {
        end(userId, id);
        sessionMapper.deleteById(id);
    }

    /** 当前用户的会话：他人会话与不存在 / 已删除一样返回 A0404。 */
    public InterpretSession getOwned(Long userId, Long id) {
        InterpretSession s = sessionMapper.selectById(id);
        if (s == null || !userId.equals(s.getUserId())) {
            throw new BizException(ErrorCode.NOT_FOUND, "同传会话不存在");
        }
        return s;
    }

    private static InterpretSessionVO toVO(InterpretSession s) {
        return new InterpretSessionVO(s.getId(), s.getMode(), s.getEngine(), s.getLanguages(), s.getRoomCode(),
                s.getStatus(), s.getTitle(), s.getStartedAt(), s.getEndedAt(), s.getDurationMs(), s.getStats(),
                s.getFavorite(), s.getOptions());
    }

    private static String blankToNull(String v) {
        return StringUtils.hasText(v) ? v.trim() : null;
    }
}
