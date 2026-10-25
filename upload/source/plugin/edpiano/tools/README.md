# 曲库开发工具（tools/）

给曲库加新歌时用的命令行小工具，只在本机 PHP CLI 下运行（每个脚本开头都有
`PHP_SAPI !== 'cli'` 守卫，Web 访问直接退出，不接受任何输入、不碰数据库）。
典型流程是「找到谱源 → 分析结构 → 必要时钢琴化精简 → 放进 `midi/` 并补同名 `.txt` / `.vol`」，
12 号《一番の宝物》与 13 号《欢乐岛》就是这条流水线做的，例子见各节。

## midi-analyze.php — 结构总览

```
php tools/midi-analyze.php <文件.mid>
```

输出文件头（格式/轨道数/ticks）、每条轨道的音符数、音高范围、**中位音高**、延音踏板数，
以及全曲时长、速度表（速度事件多＝谱面带 rubato）。加歌前先跑一遍：

- 判断是不是标准 MIDI、有没有大量悬空音符；
- **中位音高**决定「小提琴+钢琴」能不能自动分声部（见 midi-reduce.php 的注意项）；
- 速度表判断谱面是恒速还是带渐快渐慢。

12 号《一番の宝物》用它确认了：Kenzie Smith 2014 版是「右手旋律 1053 音 + 左手伴奏 587 音」
两轨钢琴谱、108 BPM、谱面连奏到位（不用另加踏板），直接可用。

## midi-chans.php — 通道扫描（乐队编制谱用）

```
php tools/midi-chans.php <文件.mid> [density]
```

按 MIDI 通道列出起音数、音高范围、GM 音色、延音踏板数；加 `density` 参数再按 10 秒窗口
统计旋律通道（ch9 鼓除外）的起音密度直方图。用途：

- 认出哪条通道是主旋律、哪条是伴奏/铺底/鼓；
- 看密度峰值——单音色钢琴下超过 ~20 音/秒 的段落会糊，需要精简声部。

13 号《欢乐岛》用它认出：ch2 小号=主旋律、ch1 长笛=副旋律、ch6/7 钢琴=伴奏、
ch3/4/5/11/12 弦乐=和声与低音、ch10 钢弦吉他=856 音扫弦、ch9=2332 个鼓点，
副歌密度峰值 33 音/秒——据此决定去谁留谁。

## midi-reduce.php — 钢琴化精简

```
php tools/midi-reduce.php <输入.mid> <输出.mid> [组名=通道号[,通道号…]] …
# 例：13 号《欢乐岛》
php tools/midi-reduce.php meg-2007.mid out.mid melody=2 piano=1,6,7 strings=3,5
```

把多通道乐队编制 MIDI 按组拆轨精简成钢琴谱（format 1 多轨）：只保留列出的通道，
音符原样（running status 还原、力度时长不动），CC 只留 64 号延音踏板，
program change / 弯音 / 表情自动化 / 未列出的通道（鼓等）全部不带入。
输出第 0 轨保留原曲 meta（曲名、速度等），其余每组一轨、带组名。

**「小提琴+钢琴」分声部的关键**：播放器（`assets/edpiano.js` 的 `assignParts`）按
**各轨中位音高**选旋律轨——最高中位轨与次高中的位差 ≥5 且音符数 ≥8% 才按轨分；
否则整谱退回单轨模式（小提琴改弹自动生成的和弦伴奏）。所以组别设计时：

- 用 midi-analyze.php 查每组中位音高，保证旋律组比第二高的组高出 ≥5 个半音；
- 副旋律（如长笛）若与主旋律中位持平，把它并进伴奏组（单音色下无音色损失）；
  13 号就是这样把长笛并入 piano 组的。

## midi-polish.php — 乐理润色（自动延音踏板 + 力度平衡）

```
php tools/midi-polish.php <输入.mid> <输出.mid> [--seg=拍数] [--acc-gain=倍率] [--pedal-ch=通道] [--no-pedal]
# 例：12 号《一番の宝物》
php tools/midi-polish.php 12.mid out.mid --seg=2 --acc-gain=0.88
# 例：13 号《欢乐岛》
php tools/midi-polish.php 13.mid out.mid --seg=2 --acc-gain=0.8
```

按乐理惯例给钢琴 MIDI 做两件「填补」：

1. **自动延音踏板**：按 `--seg`（默认 2 拍）窗口做和声分析（12 根音 × 大/小三和弦，音的
   时值×力度加权、低音根音加分），和声变化处换踏——新和弦起点踩下（CC64=127）、下一个
   变化前 0.15 拍放开（CC64=0），同和弦连续窗口不换；和声模糊（音类 ≥10 或得分过低）放开
   不踩；同和弦超 8 拍强制重踏（播放器单段延长上限 8 秒）。播放器把全部轨道的 CC64 合并成
   全局段、段内音符自动延长——正好实现钢琴的「一和弦一踏」。
   （参考：[Pianote 踏板规则](https://www.pianote.com/blog/piano-sustain-pedal)、
   [Monday Music Tips](https://matthewcawood.com/monday-music-tips/how-to-use-the-sustain-pedal)：
   踏板跟随和声，换和弦处换踏，避免浑浊。）
2. **力度平衡 `--acc-gain`**：用播放器同款规则识别旋律轨，其余轨力度整体乘倍率。
   MIDI 编程常见毛病是伴奏力度与旋律持平甚至更高，压低伴奏旋律才唱得出来
   （参考：[MIDI Sequencing Tutorial](https://www.pianoeducation.org/pnotmidi.html)）。

12 号设 0.88（Kenzie 谱面平衡本来就好，轻压），13 号设 0.8（乐队编制精简谱，声部多要压狠些）。
输出后用 `midi-analyze.php` 验证：音符数不变、踏板段无碎踏（<1 拍的要查）。

## 手写 MIDI 解析/写出代码的坑（本目录脚本已处理，重写时注意）

1. **running status**：MIDI 文件大量省略重复状态字节；解析时 `$q++` 消费状态字节后，
   数据才从 `$q` 开始；**重组 raw 事件必须显式补回状态字节**（`chr($st).substr($d,$q,2)`），
   否则输出整轨错位。
2. **meta 事件**：`FF mt VLQ(len) data`，长度 VLQ 可能多字节，切片起点要用捕获的偏移算，
   别假定 3 字节头。
3. **CC 洪水**：商业谱常逐音写表情（CC1/CC11/CC7）自动化，一轨几千条；播放器只认 CC64，
   精简时全丢，文件能小一半。
4. **只包一次 MTrk**：轨道数据先拼好，最后统一 `'MTrk'.pack('N',strlen)` 包装一次；
   对已包装轨道再包一层，内层头字节会被当 delta/事件解析，全轨乱掉且难以察觉。
5. **同刻事件顺序**：note-on 必须排在同刻 note-off 之后（源文件顺序即如此），
   PHP 8 的 usort 稳定，按 tick 排序不会破坏；别用按键名比较的二级排序打乱它。
6. **EOT 别当 meta 收**：解析时 `FF 2F 00` 要在入库判断**之前**跳过，否则它混进 meta 列表
   被写出后，排在它后面的音符事件全被下游解析器当成 EOT 后的内容忽略（12/13 号曾因此
   「丢」4 个音，其实都在文件里）。
7. **同音重叠要队列配对**：同一通道同音高快速重复时，note-on 用单值键会被后一个覆盖，
   配对要按 (通道,音高) 建 FIFO 队列。
8. **轨道名 meta 别带前导 delta**：写出 `FF 03 名字` 时 delta 由统一的 `vlq(0)` 补，
   raw 里再自带一个 `\x00` 就成双 delta，后续字节流整体错位。

## 验证清单（加完歌照着过一遍）

- `midi-analyze.php` 跑输出文件：音符数与保留通道之和一致、时长与源一致、无悬空音符；
- `midi-chans.php` 跑输出文件：确认鼓（ch9）等没混进来、各轨范围符合预期；
- 后台/前台曲库列表出现新曲（api.php 有 60 秒缓存，`?t=x` 强刷）；
- 按 README 惯例：加条目 + 版本条目，`discuz_plugin_edpiano.json` 与 DB `common_plugin.version`
  同步（曲库改动直接 UPDATE，不跑 upgrade.php）。
