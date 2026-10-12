package com.xjl.tl.module.model.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.FieldError;
import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.crypto.AesGcmCipher;
import com.xjl.tl.module.model.dto.ModelConfigDtos.ModelConfigQuery;
import com.xjl.tl.module.model.dto.ModelConfigDtos.ModelConfigRequest;
import com.xjl.tl.module.model.dto.ModelConfigDtos.ModelConfigVO;
import com.xjl.tl.module.model.dto.ModelConfigDtos.ModelOptionVO;
import com.xjl.tl.module.model.entity.ModelConfig;
import com.xjl.tl.module.model.entity.ModelParams;
import com.xjl.tl.module.model.mapper.ModelConfigMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 模型配置管理：CRUD、密钥加密、默认模型与评审模型切换（见 design D6/D7；评审模型见 improve-agent-from-experiments D4；
 * 能力类型、按能力唯一的默认模型与能力-提供方组合校验见 add-speech-and-image-translation D12）。
 */
@Service
public class ModelConfigService {

    /** 能力 → 允许的提供方（design D12）。 */
    static final Map<String, Set<String>> ALLOWED_PROVIDERS = Map.of(
            ModelConfig.CAP_CHAT, Set.of(ModelConfig.OPENAI_COMPATIBLE, ModelConfig.ANTHROPIC),
            ModelConfig.CAP_ASR, Set.of(ModelConfig.OPENAI_COMPATIBLE),
            ModelConfig.CAP_TTS, Set.of(ModelConfig.OPENAI_COMPATIBLE),
            ModelConfig.CAP_REALTIME_TRANSLATE, Set.of(ModelConfig.DASHSCOPE, ModelConfig.VOLCENGINE, ModelConfig.GOOGLE,
                    ModelConfig.OPENAI_COMPATIBLE),
            ModelConfig.CAP_REALTIME_CHAT, Set.of(ModelConfig.DASHSCOPE, ModelConfig.OPENAI_COMPATIBLE),
            ModelConfig.CAP_IMAGE_TRANSLATE, Set.of(ModelConfig.DASHSCOPE));

    private final ModelConfigMapper mapper;
    private final AesGcmCipher cipher;

    public ModelConfigService(ModelConfigMapper mapper, AesGcmCipher cipher) {
        this.mapper = mapper;
        this.cipher = cipher;
    }

    public PageResult<ModelConfigVO> page(ModelConfigQuery q) {
        String kw = q.getKeyword();
        LambdaQueryWrapper<ModelConfig> w = new LambdaQueryWrapper<ModelConfig>()
                .and(StringUtils.hasText(kw), x -> x.like(ModelConfig::getName, kw).or().like(ModelConfig::getModelName, kw))
                .orderByDesc(ModelConfig::getCreatedAt)
                .orderByDesc(ModelConfig::getId);
        return PageResult.of(mapper.selectPage(q.toPage(), w), ModelConfigService::toVO);
    }

    public ModelConfigVO get(Long id) {
        return toVO(getRequired(id));
    }

    /** 已启用且未删除的 CHAT 模型选项，默认模型排在第一位。 */
    public List<ModelOptionVO> options() {
        return options(ModelConfig.CAP_CHAT, false);
    }

    /** 按能力筛选已启用且未删除的模型选项；vision=true 时只返回支持图片输入的配置。默认模型排在第一位。 */
    public List<ModelOptionVO> options(String capability, boolean vision) {
        String cap = StringUtils.hasText(capability) ? capability : ModelConfig.CAP_CHAT;
        LambdaQueryWrapper<ModelConfig> w = new LambdaQueryWrapper<ModelConfig>()
                .select(ModelConfig::getId, ModelConfig::getName, ModelConfig::getCapability, ModelConfig::getProvider,
                        ModelConfig::getIsDefault, ModelConfig::getIsReviewDefault, ModelConfig::getSupportsVision)
                .eq(ModelConfig::getEnabled, true)
                .eq(ModelConfig::getCapability, cap)
                .eq(vision, ModelConfig::getSupportsVision, true)
                .orderByDesc(ModelConfig::getIsDefault)
                .orderByAsc(ModelConfig::getId);
        return mapper.selectList(w).stream()
                .map(m -> new ModelOptionVO(m.getId(), m.getName(), m.getCapability(), m.getProvider(),
                        Boolean.TRUE.equals(m.getIsDefault()), Boolean.TRUE.equals(m.getIsReviewDefault()),
                        Boolean.TRUE.equals(m.getSupportsVision())))
                .toList();
    }

    /** 当前 CHAT 默认模型 id（没有默认模型时返回 null）。 */
    public Long defaultModelId() {
        return defaultModelId(ModelConfig.CAP_CHAT);
    }

    /** 某能力当前的默认模型 id（没有时返回 null）。 */
    public Long defaultModelId(String capability) {
        ModelConfig mc = mapper.selectOne(new LambdaQueryWrapper<ModelConfig>()
                .select(ModelConfig::getId)
                .eq(ModelConfig::getIsDefault, true)
                .eq(ModelConfig::getEnabled, true)
                .eq(ModelConfig::getCapability, capability)
                .last("LIMIT 1"));
        return mc == null ? null : mc.getId();
    }

    /** 已启用的配置；不存在或已停用时返回 null。供各模块按 id 读取能力、提供方与视觉标记。 */
    public ModelConfig findEnabled(Long id) {
        ModelConfig mc = id == null ? null : mapper.selectById(id);
        return mc != null && Boolean.TRUE.equals(mc.getEnabled()) ? mc : null;
    }

    /** 某能力下已启用的配置（默认配置在前）。 */
    public List<ModelConfig> listEnabled(String capability) {
        return mapper.selectList(new LambdaQueryWrapper<ModelConfig>()
                .eq(ModelConfig::getEnabled, true)
                .eq(ModelConfig::getCapability, capability)
                .orderByDesc(ModelConfig::getIsDefault)
                .orderByAsc(ModelConfig::getId));
    }

    /** 当前评审模型 id（没有启用的评审模型时返回 null，表示评审使用译者模型）。 */
    public Long reviewModelId() {
        ModelConfig mc = mapper.selectOne(new LambdaQueryWrapper<ModelConfig>()
                .select(ModelConfig::getId)
                .eq(ModelConfig::getIsReviewDefault, true)
                .eq(ModelConfig::getEnabled, true)
                .last("LIMIT 1"));
        return mc == null ? null : mc.getId();
    }

    /**
     * 解析评审模型：显式指定时必须已启用（否则 C0130）→ 管理员设置的评审模型 → null（与译者相同）。
     * 文档任务在创建时调用并持久化，短文本每次请求时调用。
     */
    public Long resolveReviewModelId(Long explicitId) {
        if (explicitId != null) {
            requireEnabled(explicitId);
            return explicitId;
        }
        return reviewModelId();
    }

    /** 模型存在且已启用，否则抛出 C0130。 */
    public void requireEnabled(Long id) {
        ModelConfig mc = mapper.selectById(id);
        if (mc == null || !Boolean.TRUE.equals(mc.getEnabled())) {
            throw new BizException(ErrorCode.MODEL_CONFIG_UNAVAILABLE);
        }
    }

    @Transactional
    public ModelConfigVO create(ModelConfigRequest req) {
        if (!StringUtils.hasText(req.apiKey())) {
            throw FieldError.invalid("apiKey", "API Key 不能为空");
        }
        ModelConfig mc = new ModelConfig();
        apply(mc, req);
        mc.setIsDefault(false);
        mc.setIsReviewDefault(false);
        mc.setEnabled(req.enabled() == null || req.enabled());
        mc.setDeleted(false);
        mapper.insert(mc);
        return toVO(getRequired(mc.getId()));
    }

    @Transactional
    public ModelConfigVO update(Long id, ModelConfigRequest req) {
        ModelConfig mc = getRequired(id);
        String oldCapability = mc.getCapability();
        apply(mc, req);
        if (!mc.getCapability().equals(oldCapability)) {
            // 能力变化时原有的默认 / 评审标记不再成立
            mc.setIsDefault(false);
            mc.setIsReviewDefault(false);
        }
        if (req.enabled() != null) {
            mc.setEnabled(req.enabled());
            if (!req.enabled()) {
                mc.setIsDefault(false);
                mc.setIsReviewDefault(false);
            }
        }
        mapper.updateById(mc);
        return toVO(getRequired(id));
    }

    @Transactional
    public void delete(Long id) {
        ModelConfig mc = getRequired(id);
        if (Boolean.TRUE.equals(mc.getIsDefault()) || Boolean.TRUE.equals(mc.getIsReviewDefault())) {
            mc.setIsDefault(false);
            mc.setIsReviewDefault(false);
            mapper.updateById(mc);
        }
        mapper.deleteById(id);
    }

    /** 设为默认：事务内先取消原默认，再设置新默认；部分唯一索引兜底并发。 */
    @Transactional
    public void setDefault(Long id) {
        ModelConfig mc = getRequired(id);
        if (!Boolean.TRUE.equals(mc.getEnabled())) {
            throw FieldError.invalid("enabled", "已停用的配置不能设为默认");
        }
        if (Boolean.TRUE.equals(mc.getIsDefault())) {
            return;
        }
        mapper.clearDefault(mc.getCapability());
        mc = getRequired(id);
        mc.setIsDefault(true);
        mapper.updateById(mc);
    }

    /** 设为评审模型：切换方式与 setDefault 相同；已停用的配置返回 C0130。可与默认模型为同一配置。 */
    @Transactional
    public void setReviewDefault(Long id) {
        ModelConfig mc = getRequired(id);
        if (!Boolean.TRUE.equals(mc.getEnabled())) {
            throw new BizException(ErrorCode.MODEL_CONFIG_UNAVAILABLE, "已停用的配置不能设为评审模型");
        }
        if (!ModelConfig.CAP_CHAT.equals(mc.getCapability())) {
            throw FieldError.invalid("capability", "只有对话（CHAT）能力的配置可以设为评审模型");
        }
        if (Boolean.TRUE.equals(mc.getIsReviewDefault())) {
            return;
        }
        mapper.clearReviewDefault();
        mc = getRequired(id);
        mc.setIsReviewDefault(true);
        mapper.updateById(mc);
    }

    /** 取消评审模型标记（幂等：本来就不是评审模型时直接返回）。 */
    @Transactional
    public void clearReviewDefault(Long id) {
        ModelConfig mc = getRequired(id);
        if (!Boolean.TRUE.equals(mc.getIsReviewDefault())) {
            return;
        }
        mc.setIsReviewDefault(false);
        mapper.updateById(mc);
    }

    @Transactional
    public void setEnabled(Long id, boolean enabled) {
        ModelConfig mc = getRequired(id);
        mc.setEnabled(enabled);
        if (!enabled) {
            // 停用默认 / 评审配置时同时取消对应标记
            mc.setIsDefault(false);
            mc.setIsReviewDefault(false);
        }
        mapper.updateById(mc);
    }

    /** 掩码：保留前 3 位与后 4 位，如 sk-****abcd；过短的密钥只显示 ****。 */
    public static String mask(String apiKey) {
        String k = apiKey.trim();
        if (k.length() <= 8) {
            return "****";
        }
        return k.substring(0, 3) + "****" + k.substring(k.length() - 4);
    }

    // ---------------- 内部 ----------------

    private void apply(ModelConfig mc, ModelConfigRequest req) {
        String capability = StringUtils.hasText(req.capability()) ? req.capability() : ModelConfig.CAP_CHAT;
        if (!ALLOWED_PROVIDERS.get(capability).contains(req.provider())) {
            throw FieldError.invalid("provider", "能力 " + capability + " 不支持提供方 " + req.provider());
        }
        mc.setName(req.name().trim());
        mc.setCapability(capability);
        mc.setProvider(req.provider());
        mc.setSupportsVision(ModelConfig.CAP_CHAT.equals(capability) && Boolean.TRUE.equals(req.supportsVision()));
        mc.setBaseUrl(req.baseUrl().trim());
        mc.setModelName(req.modelName().trim());
        mc.setParams(req.params() == null ? ModelParams.empty() : req.params());
        mc.setRemark(req.remark());
        // apiKey 为空表示保持原值
        if (StringUtils.hasText(req.apiKey())) {
            mc.setApiKeyCipher(cipher.encrypt(req.apiKey().trim()));
            mc.setApiKeyMask(mask(req.apiKey()));
        }
    }

    private ModelConfig getRequired(Long id) {
        ModelConfig mc = mapper.selectById(id);
        if (mc == null) {
            throw new BizException(ErrorCode.NOT_FOUND, "模型配置不存在");
        }
        return mc;
    }

    private static ModelConfigVO toVO(ModelConfig m) {
        return new ModelConfigVO(m.getId(), m.getName(), m.getCapability(), m.getProvider(), m.getBaseUrl(),
                m.getModelName(), m.getApiKeyMask(), Boolean.TRUE.equals(m.getSupportsVision()), m.getParams() == null ? ModelParams.empty() : m.getParams(),
                m.getIsDefault(), m.getIsReviewDefault(), m.getEnabled(), m.getRemark(), m.getCreatedAt(),
                m.getUpdatedAt());
    }
}
