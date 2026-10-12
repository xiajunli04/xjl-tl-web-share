package com.xjl.tl.common.config;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.core.handlers.MetaObjectHandler;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import org.apache.ibatis.reflection.MetaObject;
import org.mybatis.spring.annotation.MapperScan;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.OffsetDateTime;

/**
 * MyBatis-Plus 配置：分页插件（单页上限 100）、created_at / updated_at 自动填充。
 * 主键策略与逻辑删除在 application.yml 的 mybatis-plus.global-config 中配置。
 */
@Configuration
@MapperScan("com.xjl.tl.module.**.mapper")
public class MybatisPlusConfig {

    @Bean
    public MybatisPlusInterceptor mybatisPlusInterceptor() {
        MybatisPlusInterceptor interceptor = new MybatisPlusInterceptor();
        PaginationInnerInterceptor pagination = new PaginationInnerInterceptor(DbType.POSTGRE_SQL);
        pagination.setMaxLimit(100L);
        interceptor.addInnerInterceptor(pagination);
        return interceptor;
    }

    @Bean
    public MetaObjectHandler timeMetaObjectHandler() {
        return new MetaObjectHandler() {
            @Override
            public void insertFill(MetaObject metaObject) {
                OffsetDateTime now = OffsetDateTime.now();
                strictInsertFill(metaObject, "createdAt", OffsetDateTime.class, now);
                strictInsertFill(metaObject, "updatedAt", OffsetDateTime.class, now);
            }

            @Override
            public void updateFill(MetaObject metaObject) {
                // 无条件覆盖，保证 updated_at 反映最近一次修改（Python 侧据此刷新缓存）
                if (metaObject.hasSetter("updatedAt")) {
                    setFieldValByName("updatedAt", OffsetDateTime.now(), metaObject);
                }
            }
        };
    }
}
