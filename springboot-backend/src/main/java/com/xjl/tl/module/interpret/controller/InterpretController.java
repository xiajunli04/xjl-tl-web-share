package com.xjl.tl.module.interpret.controller;

import com.xjl.tl.common.PageQuery;
import com.xjl.tl.common.PageResult;
import com.xjl.tl.common.Result;
import com.xjl.tl.module.interpret.dto.InterpretDtos.InterpretCreateRequest;
import com.xjl.tl.module.interpret.dto.InterpretDtos.InterpretJoinVO;
import com.xjl.tl.module.interpret.dto.InterpretDtos.InterpretQuery;
import com.xjl.tl.module.interpret.dto.InterpretDtos.InterpretSegmentVO;
import com.xjl.tl.module.interpret.dto.InterpretDtos.InterpretSessionVO;
import com.xjl.tl.module.interpret.dto.InterpretDtos.JoinRequest;
import com.xjl.tl.module.interpret.service.InterpretService;
import com.xjl.tl.module.log.annotation.OperationLog;
import com.xjl.tl.module.translate.dto.TranslateDtos.FavoriteRequest;
import com.xjl.tl.security.CurrentUser;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import org.springdoc.core.annotations.ParameterObject;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "同声传译", description = """
        同传会话：创建（收听 / 双向对话 / 会议室）、加入会议室、重取票据、结束，以及同传历史（只有创建者可见，他人会话返回 A0404）。\
        实时音频走 WebSocket /ws/interpret?ticket=<wsTicket>，见 add-speech-and-image-translation D1–D3、D7、D9""")
@RestController
@RequestMapping("/api/interpret")
public class InterpretController {

    public static final String MODULE = "同声传译";

    private final InterpretService service;

    public InterpretController(InterpretService service) {
        this.service = service;
    }

    @Operation(summary = "创建同传会话", description = """
            mode=LISTEN 时 languages=[目标]，CONVERSE 时为两种不同语言 [A, B]，ROOM 时为 [我的语言]（生成 6 位房间码）。\
            返回会话 id、participantId 与 60 秒内有效的一次性 wsTicket。双向对话语言相同、S2S 引擎选择自动路由返回 A0410；\
            已有进行中的会话返回 409 + A0214；引擎不可用返回 503 + C0173；语言不支持返回 A0420；模型停用返回 C0130。""")
    @OperationLog(module = MODULE, action = "创建同传会话")
    @PostMapping("/sessions")
    public Result<InterpretJoinVO> create(@Valid @RequestBody InterpretCreateRequest req) {
        CurrentUser user = CurrentUser.get();
        return Result.ok(service.create(user.id(), user.username(), req));
    }

    @Operation(summary = "加入会议室", description = """
            提交显示名与语言获取票据；断线 30 秒内携带原 participantId 重新加入可恢复身份。房间不存在或已关闭返回 404 + A0452；\
            人数超过 8 人或语言数超过上限（级联 6 种 / S2S 4 种）返回 409 + A0451。""")
    @PostMapping("/rooms/{code}/join")
    public Result<InterpretJoinVO> join(@PathVariable String code, @Valid @RequestBody JoinRequest req) {
        CurrentUser user = CurrentUser.get();
        return Result.ok(service.join(user.id(), user.username(), code, req));
    }

    @Operation(summary = "重取票据", description = "创建者断线重连时获取新的 wsTicket；会话已结束返回 404 + A0452")
    @PostMapping("/sessions/{id}/ticket")
    public Result<InterpretJoinVO> ticket(@PathVariable Long id) {
        return Result.ok(service.ticket(CurrentUser.get().id(), id));
    }

    @Operation(summary = "结束同传会话", description = "写完转写并统计（时长、句数、平均与 p50 延迟、人数、语言）后返回会话；会议室成员收到 ended{reason:host_left}；已结束的会话直接返回")
    @OperationLog(module = MODULE, action = "结束同传会话")
    @PostMapping("/sessions/{id}/end")
    public Result<InterpretSessionVO> end(@PathVariable Long id) {
        return Result.ok(service.end(CurrentUser.get().id(), id));
    }

    @Operation(summary = "进行中的同传会话", description = "刷新页面后恢复用：返回当前用户进行中的会话，没有时 data 为 null；"
            + "进程重启后残留的会话会被就地结束")
    @GetMapping("/sessions/active")
    public Result<InterpretSessionVO> active() {
        return Result.ok(service.active(CurrentUser.get().id()));
    }

    @Operation(summary = "分页查询同传会话", description = "按创建时间倒序；keyword 匹配标题或转写内容（原文与译文，不区分大小写）；时间范围为 [from, to)")
    @GetMapping("/sessions")
    public Result<PageResult<InterpretSessionVO>> page(@ParameterObject InterpretQuery query) {
        return Result.ok(service.page(CurrentUser.get().id(), query));
    }

    @Operation(summary = "同传会话详情")
    @GetMapping("/sessions/{id}")
    public Result<InterpretSessionVO> detail(@PathVariable Long id) {
        return Result.ok(service.detail(CurrentUser.get().id(), id));
    }

    @Operation(summary = "转写分页", description = "按时间顺序（seq 升序），每页最多 100 条")
    @GetMapping("/sessions/{id}/segments")
    public Result<PageResult<InterpretSegmentVO>> segments(@PathVariable Long id, @ParameterObject PageQuery query) {
        return Result.ok(service.segments(CurrentUser.get().id(), id, query));
    }

    @Operation(summary = "收藏/取消收藏")
    @PutMapping("/sessions/{id}/favorite")
    public Result<Void> favorite(@PathVariable Long id, @Valid @RequestBody FavoriteRequest req) {
        service.setFavorite(CurrentUser.get().id(), id, req.favorite());
        return Result.ok();
    }

    @Operation(summary = "删除同传会话（逻辑删除）", description = "进行中的会话先结束再删除")
    @OperationLog(module = MODULE, action = "删除同传会话")
    @DeleteMapping("/sessions/{id}")
    public Result<Void> delete(@PathVariable Long id) {
        service.delete(CurrentUser.get().id(), id);
        return Result.ok();
    }
}
