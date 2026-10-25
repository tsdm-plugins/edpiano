<?php
/**
 * 电钢琴 edpiano — 曲库开发工具：乐队编制 MIDI 钢琴化精简
 *
 * 用法（仅命令行）：
 *   php midi-reduce.php <输入.mid> <输出.mid> [组名=通道号[,通道号…]] …
 * 例（13 号《欢乐岛》的参数）：
 *   php midi-reduce.php meg-2007.mid out.mid melody=2 piano=1,6,7 strings=3,5
 *
 * 行为：
 *  - 只保留列出的通道，按组拆成多条轨道输出（format 1，第 0 轨为原曲 meta/速度事件）；
 *  - 音符原样保留（含 running status 还原、力度、音高、时长）；
 *  - CC 只保留 64 号延音踏板，表情/颤音等自动化全部丢弃（播放器不读，只会撑大文件）；
 *  - program change、弯音、余量 CC、鼓（一般不列入组里即可）全部不带入。
 *
 * 注意（都是踩过的坑）：
 *  - 播放器「小提琴+钢琴」按各轨中位音高差 ≥5 选旋律轨，组名顺序无关；
 *    若两条轨中位音高相同，会把整谱退回单轨模式，必要时把副旋律通道并进伴奏组；
 *  - 输出轨道只包一次 MTrk 头（本脚本已处理），手写时勿对已包装轨道再包一层。
 */
if (PHP_SAPI !== 'cli') { exit("CLI only\n"); }
if ($argc < 4) { exit("usage: php midi-reduce.php <in.mid> <out.mid> [group=ch[,ch…]] …\n"); }

$in = $argv[1]; $out = $argv[2];
$groups = [];   // name => [ch,...]
$order  = [];
for ($i = 3; $i < $argc; $i++) {
    if (!preg_match('/^([A-Za-z0-9_-]+)=(\d+(?:,\d+)*)$/', $argv[$i], $m)) {
        exit("bad group arg: {$argv[$i]}\n");
    }
    $groups[$m[1]] = array_map('intval', explode(',', $m[2]));
    $order[] = $m[1];
}
$keep = []; $groupOf = [];
foreach ($groups as $name => $chs) {
    foreach ($chs as $c) { $keep[] = $c; $groupOf[$c] = $name; }
}
$keep = array_unique($keep);

$d = file_get_contents($in);
if (substr($d,0,4) !== 'MThd') exit("not a MIDI file\n");
$hdrlen = unpack('N', substr($d,4,4))[1];
$div    = unpack('n', substr($d,12,2))[1];
$p = 8+$hdrlen; $tick = 0; $run = 0;
$metaAll = [];                          // [tick, raw(FF mt len data)]
$ev = [];                               // name => [[tick, raw3bytes], ...]
foreach ($order as $name) $ev[$name] = [];
$tempo = 500000;

while ($p < strlen($d)) {
    if (substr($d,$p,4) !== 'MTrk') break;
    $len = unpack('N', substr($d,$p+4,4))[1];
    $end = $p+8+$len; $q = $p+8;
    while ($q < $end) {
        $dt = 0; do { $b = ord($d[$q++]); $dt = ($dt<<7)|($b&0x7f); } while ($b&0x80);
        $tick += $dt;
        $st = ord($d[$q]);
        if ($st < 0x80) { $st = $run; } else { $q++; $run = $st; }   // $q 现指向数据字节（或 meta 的 mt）
        if ($st == 0xFF) {
            $mt = ord($d[$q++]); $qL = $q; $l = 0;
            do { $b = ord($d[$q++]); $l = ($l<<7)|($b&0x7f); } while ($b&0x80);
            if ($mt == 0x51) $tempo = unpack('N',"\0".substr($d,$q,3))[1];
            if ($mt == 0x2F) { $q = $end; break; }
            $metaAll[] = [$tick, substr($d, $qL-2, 2 + ($q-$qL) + $l)];
            $q += $l;
        } elseif ($st == 0xF0 || $st == 0xF7) {
            $l = 0; do { $b = ord($d[$q++]); $l = ($l<<7)|($b&0x7f); } while ($b&0x80); $q += $l;
        } else {
            $nh = $st & 0xF0; $c = $st & 0x0F;
            if (in_array($c, $keep, true)) {
                $g = $groupOf[$c];
                // 重组 raw：状态字节必须显式带上（源文件大量用 running status，$q 处没有状态字节）
                if ($nh == 0x90 || $nh == 0x80) $ev[$g][] = [$tick, chr($st).substr($d,$q,2)];
                elseif ($nh == 0xB0 && ord($d[$q]) == 64) $ev[$g][] = [$tick, chr($st).substr($d,$q,2)];
            }
            $q += ($nh == 0xC0 || $nh == 0xD0) ? 1 : 2;
        }
    }
    $p = $end;
}

function vlq($n) { $s = chr($n & 0x7f); $n >>= 7; while ($n) { $s = chr(($n & 0x7f)|0x80).$s; $n >>= 7; } return $s; }
function mtrk($b) { return 'MTrk'.pack('N', strlen($b)).$b; }

usort($metaAll, fn($a,$b) => $a[0] <=> $b[0]);
$t0 = ''; $last = 0;
foreach ($metaAll as $m) { $t0 .= vlq($m[0]-$last).$m[1]; $last = $m[0]; }
$t0 .= vlq(0)."\xFF\x2F\x00";
$tracks = [$t0];

$total = 0;
foreach ($order as $name) {
    $evs = $ev[$name];
    usort($evs, fn($a,$b) => $a[0] <=> $b[0]);   // PHP≥8 排序稳定，同时刻事件保持原相对顺序
    $t = "\x00\xFF\x03".chr(strlen($name)).$name;
    $last = 0; $ons = 0;
    foreach ($evs as $e) {
        $t .= vlq($e[0]-$last).$e[1]; $last = $e[0];
        if ((ord($e[1][0]) & 0xF0) == 0x90 && ord($e[1][2]) > 0) $ons++;
    }
    $t .= vlq(0)."\xFF\x2F\x00";
    $tracks[] = $t;                              // 此处不包装，最后统一 mtrk() 一次
    $total += count($evs);
    echo "  track [$name]: events=".count($evs)." (onsets=$ons)\n";
}
$blob = 'MThd'.pack('N',6).pack('nnn', 1, count($tracks), $div);
foreach ($tracks as $t) $blob .= mtrk($t);
file_put_contents($out, $blob);
echo "wrote $out: tracks=".count($tracks)." events=$total size=".strlen($blob)."\n";
