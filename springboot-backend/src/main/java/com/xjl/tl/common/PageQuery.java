package com.xjl.tl.common;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import io.swagger.v3.oas.annotations.media.Schema;

/**
 * 分页参数：pageNum 从 1 开始（默认 1），pageSize 默认 10、最大 100。
 */
@Schema(description = "分页参数")
public class PageQuery {

    public static final int DEFAULT_PAGE_SIZE = 10;
    public static final int MAX_PAGE_SIZE = 100;

    @Schema(description = "页码，从 1 开始", example = "1")
    private Integer pageNum;

    @Schema(description = "每页条数，最大 100", example = "10")
    private Integer pageSize;

    public int getPageNum() {
        return pageNum == null || pageNum < 1 ? 1 : pageNum;
    }

    public void setPageNum(Integer pageNum) {
        this.pageNum = pageNum;
    }

    public int getPageSize() {
        if (pageSize == null || pageSize < 1) {
            return DEFAULT_PAGE_SIZE;
        }
        return Math.min(pageSize, MAX_PAGE_SIZE);
    }

    public void setPageSize(Integer pageSize) {
        this.pageSize = pageSize;
    }

    /** 转为 MyBatis-Plus 分页对象。 */
    public <T> Page<T> toPage() {
        return new Page<>(getPageNum(), getPageSize());
    }
}
