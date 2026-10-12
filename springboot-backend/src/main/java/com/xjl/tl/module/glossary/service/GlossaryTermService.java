package com.xjl.tl.module.glossary.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.xjl.tl.common.BizException;
import com.xjl.tl.common.ErrorCode;
import com.xjl.tl.common.FieldError;
import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.mybatis.SqlUtils;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.ImportError;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.ImportPreviewVO;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.ImportResultVO;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.ImportSample;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.TermQuery;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.TermRequest;
import com.xjl.tl.module.glossary.dto.GlossaryDtos.TermVO;
import com.xjl.tl.module.glossary.entity.Glossary;
import com.xjl.tl.module.glossary.entity.GlossaryTerm;
import com.xjl.tl.module.glossary.mapper.GlossaryMapper;
import com.xjl.tl.module.glossary.mapper.GlossaryTermMapper;
import com.xjl.tl.security.CurrentUser;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 术语 CRUD、termCount 维护与 CSV 导入导出（见 glossary 规格「术语管理」「CSV 导入与导出」）。
 * 任何术语变更都会刷新术语库的 term_count 与 updated_at。
 */
@Service
public class GlossaryTermService {

    public static final String STRATEGY_SKIP = "skip";
    public static final String STRATEGY_OVERWRITE = "overwrite";

    private static final int MAX_ERRORS = 200;
    private static final int MAX_SAMPLES = 10;
    private static final int BATCH_SIZE = 500;
    private static final int MAX_TERM_LENGTH = 200;
    private static final int MAX_NOTE_LENGTH = 255;

    private final GlossaryService glossaryService;
    private final GlossaryMapper glossaryMapper;
    private final GlossaryTermMapper termMapper;

    public GlossaryTermService(GlossaryService glossaryService, GlossaryMapper glossaryMapper,
                               GlossaryTermMapper termMapper) {
        this.glossaryService = glossaryService;
        this.glossaryMapper = glossaryMapper;
        this.termMapper = termMapper;
    }

    // ---------------- 查询 ----------------

    public PageResult<TermVO> page(CurrentUser user, Long glossaryId, TermQuery q) {
        glossaryService.getReadable(user, glossaryId);
        String kw = q.getKeyword();
        String pattern = StringUtils.hasText(kw) ? SqlUtils.containsPattern(kw) : null;
        LambdaQueryWrapper<GlossaryTerm> w = new LambdaQueryWrapper<GlossaryTerm>()
                .eq(GlossaryTerm::getGlossaryId, glossaryId)
                .apply(pattern != null, "(source_term ILIKE {0} OR target_term ILIKE {0})", pattern)
                .orderByDesc(GlossaryTerm::getCreatedAt)
                .orderByDesc(GlossaryTerm::getId);
        return PageResult.of(termMapper.selectPage(q.toPage(), w), GlossaryTermService::toVO);
    }

    // ---------------- 增删改 ----------------

    @Transactional
    public TermVO create(CurrentUser user, Long glossaryId, TermRequest req) {
        glossaryService.getWritable(user, glossaryId);
        String source = req.sourceTerm().trim();
        ensureUnique(glossaryId, source, null);
        GlossaryTerm t = new GlossaryTerm();
        t.setGlossaryId(glossaryId);
        t.setSourceTerm(source);
        t.setTargetTerm(req.targetTerm().trim());
        t.setNote(GlossaryService.trimToNull(req.note()));
        t.setCaseSensitive(Boolean.TRUE.equals(req.caseSensitive()));
        try {
            termMapper.insert(t);
        } catch (DuplicateKeyException e) {
            throw termExists(source);
        }
        glossaryMapper.refreshTermCount(glossaryId);
        return toVO(termMapper.selectById(t.getId()));
    }

    @Transactional
    public TermVO update(CurrentUser user, Long glossaryId, Long termId, TermRequest req) {
        glossaryService.getWritable(user, glossaryId);
        GlossaryTerm t = getTerm(glossaryId, termId);
        String source = req.sourceTerm().trim();
        ensureUnique(glossaryId, source, termId);
        t.setSourceTerm(source);
        t.setTargetTerm(req.targetTerm().trim());
        t.setNote(GlossaryService.trimToNull(req.note()));
        if (req.caseSensitive() != null) {
            t.setCaseSensitive(req.caseSensitive());
        }
        try {
            termMapper.updateById(t);
        } catch (DuplicateKeyException e) {
            throw termExists(source);
        }
        glossaryMapper.refreshTermCount(glossaryId);
        return toVO(termMapper.selectById(termId));
    }

    @Transactional
    public void delete(CurrentUser user, Long glossaryId, Long termId) {
        glossaryService.getWritable(user, glossaryId);
        getTerm(glossaryId, termId);
        termMapper.deleteById(termId);
        glossaryMapper.refreshTermCount(glossaryId);
    }

    // ---------------- 导入导出 ----------------

    public ImportPreviewVO preview(CurrentUser user, Long glossaryId, byte[] file) {
        glossaryService.getWritable(user, glossaryId);
        Analysis a = analyze(glossaryId, TermCsv.parse(file));
        List<ImportSample> sample = a.valid().stream().limit(MAX_SAMPLES)
                .map(v -> new ImportSample(v.row().line(), v.row().source(), v.row().target(),
                        GlossaryService.trimToNull(v.row().note()), v.existingId() != null))
                .toList();
        int updateCount = (int) a.valid().stream().filter(v -> v.existingId() != null).count();
        return new ImportPreviewVO(a.total(), a.valid().size(), a.valid().size() - updateCount, updateCount,
                a.errors().stream().limit(MAX_ERRORS).toList(), sample);
    }

    @Transactional
    public ImportResultVO importTerms(CurrentUser user, Long glossaryId, byte[] file, String strategy) {
        glossaryService.getWritable(user, glossaryId);
        String s = StringUtils.hasText(strategy) ? strategy.trim().toLowerCase(Locale.ROOT) : STRATEGY_SKIP;
        if (!STRATEGY_SKIP.equals(s) && !STRATEGY_OVERWRITE.equals(s)) {
            throw FieldError.invalid("strategy", "导入策略只能是 skip 或 overwrite");
        }
        Analysis a = analyze(glossaryId, TermCsv.parse(file));
        List<GlossaryTerm> toInsert = new ArrayList<>();
        int updated = 0;
        int skipped = 0;
        for (ValidRow v : a.valid()) {
            String note = GlossaryService.trimToNull(v.row().note());
            if (v.existingId() == null) {
                GlossaryTerm t = new GlossaryTerm();
                t.setSourceTerm(v.row().source());
                t.setTargetTerm(v.row().target());
                t.setNote(note);
                t.setCaseSensitive(false);
                toInsert.add(t);
            } else if (STRATEGY_OVERWRITE.equals(s)) {
                termMapper.overwrite(v.existingId(), v.row().target(), note);
                updated++;
            } else {
                skipped++;
            }
        }
        try {
            for (int i = 0; i < toInsert.size(); i += BATCH_SIZE) {
                termMapper.insertBatch(glossaryId, toInsert.subList(i, Math.min(i + BATCH_SIZE, toInsert.size())));
            }
        } catch (DuplicateKeyException e) {
            // 预览与导入之间有并发写入时由唯一索引兜底
            throw new BizException(ErrorCode.TERM_EXISTS, "导入过程中术语发生变化，请重新预览后导入");
        }
        glossaryMapper.refreshTermCount(glossaryId);
        return new ImportResultVO(toInsert.size(), updated, skipped, a.errorCount());
    }

    /** 导出 CSV（可读即可导出：自己的库与公共库），按创建顺序输出。 */
    public Export export(CurrentUser user, Long glossaryId) {
        Glossary g = glossaryService.getReadable(user, glossaryId);
        List<String[]> rows = termMapper.selectList(new LambdaQueryWrapper<GlossaryTerm>()
                        .eq(GlossaryTerm::getGlossaryId, glossaryId)
                        .orderByAsc(GlossaryTerm::getId))
                .stream()
                .map(t -> new String[]{t.getSourceTerm(), t.getTargetTerm(), t.getNote() == null ? "" : t.getNote()})
                .toList();
        return new Export(g.getName(), TermCsv.write(rows));
    }

    /** 导出结果。 */
    public record Export(String name, byte[] content) {
    }

    // ---------------- 内部 ----------------

    private record ValidRow(TermCsv.Row row, Long existingId) {
    }

    private record Analysis(int total, List<ValidRow> valid, List<ImportError> errors, int errorCount) {
    }

    /** 逐行校验：缺列、超长、文件内重复记为错误行；与已有术语冲突的记录 existingId。 */
    private Analysis analyze(Long glossaryId, List<TermCsv.Row> rows) {
        Map<String, Long> existing = new HashMap<>();
        termMapper.selectList(new LambdaQueryWrapper<GlossaryTerm>()
                        .select(GlossaryTerm::getId, GlossaryTerm::getSourceTerm)
                        .eq(GlossaryTerm::getGlossaryId, glossaryId))
                .forEach(t -> existing.put(key(t.getSourceTerm()), t.getId()));
        Map<String, Integer> seen = new HashMap<>();
        List<ValidRow> valid = new ArrayList<>();
        List<ImportError> errors = new ArrayList<>();
        for (TermCsv.Row row : rows) {
            String error = validate(row);
            if (error == null) {
                Integer firstLine = seen.putIfAbsent(key(row.source()), row.line());
                if (firstLine != null) {
                    error = "源术语与第 " + firstLine + " 行重复";
                }
            }
            if (error != null) {
                errors.add(new ImportError(row.line(), error));
            } else {
                valid.add(new ValidRow(row, existing.get(key(row.source()))));
            }
        }
        return new Analysis(rows.size(), valid, errors, errors.size());
    }

    private static String validate(TermCsv.Row row) {
        if (!StringUtils.hasText(row.source())) {
            return "源术语不能为空";
        }
        if (!StringUtils.hasText(row.target())) {
            return "目标术语不能为空";
        }
        if (row.source().length() > MAX_TERM_LENGTH) {
            return "源术语最长 " + MAX_TERM_LENGTH + " 位";
        }
        if (row.target().length() > MAX_TERM_LENGTH) {
            return "目标术语最长 " + MAX_TERM_LENGTH + " 位";
        }
        if (row.note() != null && row.note().length() > MAX_NOTE_LENGTH) {
            return "备注最长 " + MAX_NOTE_LENGTH + " 位";
        }
        return null;
    }

    private void ensureUnique(Long glossaryId, String source, Long excludeId) {
        boolean exists = termMapper.exists(new LambdaQueryWrapper<GlossaryTerm>()
                .eq(GlossaryTerm::getGlossaryId, glossaryId)
                .apply("lower(source_term) = lower({0})", source)
                .ne(excludeId != null, GlossaryTerm::getId, excludeId));
        if (exists) {
            throw termExists(source);
        }
    }

    private GlossaryTerm getTerm(Long glossaryId, Long termId) {
        GlossaryTerm t = termMapper.selectById(termId);
        if (t == null || !glossaryId.equals(t.getGlossaryId())) {
            throw new BizException(ErrorCode.NOT_FOUND, "术语不存在");
        }
        return t;
    }

    private static BizException termExists(String source) {
        return new BizException(ErrorCode.TERM_EXISTS, "术语已存在：" + source);
    }

    private static String key(String source) {
        return source.trim().toLowerCase(Locale.ROOT);
    }

    private static TermVO toVO(GlossaryTerm t) {
        return new TermVO(t.getId(), t.getSourceTerm(), t.getTargetTerm(), t.getNote(), t.getCaseSensitive(),
                t.getUpdatedAt());
    }
}
