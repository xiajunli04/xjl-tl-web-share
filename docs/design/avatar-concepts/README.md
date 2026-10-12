# 数字人概念图

由图像模型（nano-banana-pro）生成，作为数字人形象的设计依据。

| 文件 | 内容 | 状态 |
|---|---|---|
| 01–04 | 半写实 3D 方向：主形象、六地区变体、状态表情表、产品内效果 | 备选（未采用） |
| 11-guofeng-hero | 国风二次元方向主形象（青花瓷旗袍） | **采用** |
| 12-language-avatars | 15 种平台语言的形象头像表 | **采用**（首批实现中、英、日、韩） |
| 13-guofeng-in-product | AI 对话页面效果 | **采用**（布局参考） |

实现时按概念图 1:1 复刻并去掉耳机：`web/scripts/avatar/generate.py` 以 11、12 为参考生成各形象的底图与局部变体，
`build.py` 构建为 `web/public/avatars/<id>/` 下的立绘资源（见 OpenSpec change `rework-avatar-portrait-rig`）。
