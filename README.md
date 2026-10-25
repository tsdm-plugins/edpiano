# edpiano — Discuz X5 悬浮 MIDI 钢琴播放器

天使动漫论坛（bbs.tsdm.vip）用的悬浮 MIDI 钢琴播放器插件：九档音色（钢琴/电钢/八音盒/
木吉他/弦乐/长笛/马林巴等）、小提琴合奏模式（自动分声部或手排 `.violin.json` 声部）、
「架子鼓+钢琴」真鼓模式、后台曲库管理与分类折叠。

插件本体文档（功能、曲库格式、完整版本历史）见
[`upload/source/plugin/edpiano/README.md`](upload/source/plugin/edpiano/README.md)。

## 仓库结构

```
upload/source/plugin/edpiano/   插件本体，镜像正式站 source/plugin/edpiano/
```

改动流程照全站惯例：先在正式站生效，再镜像回本仓库提交。

## 曲库说明

正式站的曲库 `midi/`（`.mid` 转谱、曲名/分类元数据、`.vol`/`.violin.json` 合奏配置）
是版权敏感内容，按曲目条目里的约定**仅论坛内试听**，因此**不入本仓库**（见 `.gitignore`），
只在正式站维护。曲库工具链（`tools/`，CLI 专用带 Web 守卫）与音源样本（`sf/`，
取自 FluidR3 衍生，CC BY 3.0）随插件入库。
