<?php
/**
 * 电钢琴 edpiano — 曲库开发工具：MIDI 乐理润色（自动延音踏板 + 旋律/伴奏力度平衡）
 *
 * 用法（仅命令行）：
 *   php midi-polish.php <输入.mid> <输出.mid> [--seg=拍数] [--acc-gain=倍率] [--pedal-ch=通道] [--no-pedal]
 * 例：
 *   php midi-polish.php 12.mid out.mid --seg=2 --acc-gain=0.88
 *
 * 做两件事（乐理依据见 tools/README.md 参考链接）：
 *  1. 自动延音踏板：按 --seg（默认 2 拍）的窗口做和声分析（12 根音 × 大/小三和弦，
 *     按音的时值×力度加权、低音根音加分），和声变化处换踏——新和弦起点踩下（CC64=127）、
 *     下一个变化前 0.15 拍放开（CC64=0），同和弦连续窗口保持不换；和声模糊（音类 ≥10 或
 *     得分过低）时放开不踩；同和弦超 8 拍强制重踏（播放器单段延长上限 8 秒）。
 *     播放器把所有轨的 CC64 合并成全局段、段内音符自动延长——正好实现「一和弦一踏」。
 *  2. 力度平衡 --acc-gain：用播放器同款规则（各轨中位音高差 ≥5 选旋律轨）识别旋律，
 *     其余轨力度整体乘 --acc-gain（默认 1＝不动）。MIDI 编程常见毛病是伴奏力度
 *     与旋律持平甚至更高，压低伴奏旋律才唱得出来。
 */
if (PHP_SAPI !== 'cli') { exit("CLI only\n"); }
if ($argc < 3) { exit("usage: php midi-polish.php <in.mid> <out.mid> [--seg=2] [--acc-gain=1] [--pedal-ch=N] [--no-pedal]\n"); }

$in = $argv[1]; $out = $argv[2];
$segBeats = 2; $accGain = 1.0; $pedalCh = null; $doPedal = true;
for ($i = 3; $i < $argc; $i++) {
    if (preg_match('/^--seg=([\d.]+)$/', $argv[$i], $m)) $segBeats = (float)$m[1];
    elseif (preg_match('/^--acc-gain=([\d.]+)$/', $argv[$i], $m)) $accGain = (float)$m[1];
    elseif (preg_match('/^--pedal-ch=(\d+)$/', $argv[$i], $m)) $pedalCh = (int)$m[1];
    elseif ($argv[$i] === '--no-pedal') $doPedal = false;
    else exit("unknown arg: {$argv[$i]}\n");
}

/* ---------- 解析（保留轨道结构与轨道名；running status 按验证过的逻辑还原） ---------- */
$d = file_get_contents($in);
if (substr($d,0,4) !== 'MThd') exit("not a MIDI file\n");
$hdrlen = unpack('N', substr($d,4,4))[1];
$div    = unpack('n', substr($d,12,2))[1];
$tracks = [];
$p = 8+$hdrlen;
while ($p < strlen($d)) {
    if (substr($d,$p,4) !== 'MTrk') break;
    $len = unpack('N', substr($d,$p+4,4))[1];
    $end = $p+8+$len; $q = $p+8; $tick = 0; $run = 0;
    $tr = ['name'=>'', 'meta'=>[], 'notes'=>[], 'other'=>[]];   // notes: [onTick, offTick, ch, pitch, vel]
    $on = [];
    while ($q < $end) {
        $dt = 0; do { $b = ord($d[$q++]); $dt = ($dt<<7)|($b&0x7f); } while ($b&0x80);
        $tick += $dt;
        $st = ord($d[$q]);
        if ($st < 0x80) { $st = $run; } else { $q++; $run = $st; }
        if ($st == 0xFF) {
            $mt = ord($d[$q++]); $qL = $q; $l = 0;
            do { $b = ord($d[$q++]); $l = ($l<<7)|($b&0x7f); } while ($b&0x80);
            if ($mt == 0x2F) { $q = $end; break; }              // EOT 不入库（先于 meta 存储判断）
            if ($mt == 0x03) $tr['name'] = substr($d,$q,$l);
            else $tr['meta'][] = [$tick, substr($d, $qL-2, 2+($q-$qL)+$l)];
            $q += $l;
        } elseif ($st == 0xF0 || $st == 0xF7) {
            $l = 0; do { $b = ord($d[$q++]); $l = ($l<<7)|($b&0x7f); } while ($b&0x80); $q += $l;
        } else {
            $nh = $st & 0xF0; $c = $st & 0x0F;
            if ($nh == 0x90 && ord($d[$q+1]) > 0) {
                $on["$c:".ord($d[$q])][] = [$tick, ord($d[$q+1])]; $q += 2;   // 同音重叠用队列配对
            } elseif ($nh == 0x80 || ($nh == 0x90 && ord($d[$q+1]) == 0)) {
                $k = "$c:".ord($d[$q]);
                if (!empty($on[$k])) {
                    $info = array_shift($on[$k]);
                    $tr['notes'][] = [$info[0], $tick, $c, ord($d[$q]), $info[1]];
                }
                $q += 2;
            } elseif ($nh == 0xB0 && ord($d[$q]) == 64) {
                $q += 2;                                   // 丢弃旧踏板，稍后按和声重排
            } else {
                $tr['other'][] = [$tick, chr($st).substr($d,$q, ($nh==0xC0||$nh==0xD0)?1:2)];
                $q += ($nh == 0xC0 || $nh == 0xD0) ? 1 : 2;
            }
        }
    }
    $tracks[] = $tr; $p = $end;
}

/* ---------- 旋律轨识别（播放器 assignParts 同款：中位音高差 ≥5） ---------- */
$rank = [];
foreach ($tracks as $ti => $tr) {
    if (!count($tr['notes'])) continue;
    $ps = []; foreach ($tr['notes'] as $n) $ps[] = $n[3];
    sort($ps);
    $rank[$ti] = ['median'=>$ps[intdiv(count($ps),2)], 'count'=>count($ps)];
}
$melodyTi = null;
if (count($rank) >= 2) {
    $vals = array_values($rank); $keys = array_keys($rank);
    array_multisort($vals, SORT_DESC, $keys);
    if ($vals[0]['count'] >= 20 && $vals[0]['median'] - $vals[1]['median'] >= 5) $melodyTi = $keys[0];
}
echo "melody track: ".($melodyTi===null ? 'none' : "#$melodyTi ({$tracks[$melodyTi]['name']})")."\n";

/* ---------- 力度平衡 ---------- */
if ($accGain != 1.0 && $melodyTi !== null) {
    foreach ($tracks as $ti => &$tr) {
        if ($ti === $melodyTi || !count($tr['notes'])) continue;
        foreach ($tr['notes'] as &$n) $n[4] = max(1, min(120, (int)round($n[4]*$accGain)));
    }
    unset($tr, $n);
    echo "acc-gain=$accGain applied to non-melody tracks\n";
}

/* ---------- 和声分析 + 自动踏板 ---------- */
if ($doPedal) {
    $allNotes = [];
    foreach ($tracks as $tr) foreach ($tr['notes'] as $n) $allNotes[] = $n;
    if (count($allNotes)) {
        $segTicks = max(1, (int)round($segBeats * $div));
        $first = PHP_INT_MAX; $lastT = 0;
        foreach ($allNotes as $n) { $first = min($first, $n[0]); $lastT = max($lastT, $n[1]); }
        $s0 = intdiv($first, $segTicks); $s1 = intdiv($lastT, $segTicks);

        /* 每窗口和声：12 根音 × 大/小三和弦，时值×力度加权，低音根音加分 */
        $chordAt = [];
        for ($s = $s0; $s <= $s1; $s++) {
            $a = $s*$segTicks; $b = ($s+1)*$segTicks;
            $w = []; $bass = PHP_INT_MAX; $pcs = []; $wsum = 0;
            foreach ($allNotes as $n) {
                $os = max($n[0], $a); $oe = min($n[1], $b);
                if ($oe <= $os) continue;
                $wt = ($oe-$os) * (0.5 + $n[4]/127);
                $w[$n[3]] = ($w[$n[3]] ?? 0) + $wt; $wsum += $wt;
                $pcs[$n[3] % 12] = 1;
                if ($n[3] < $bass) $bass = $n[3];
            }
            if (!$w) { $chordAt[$s] = null; continue; }
            $best = null; $bestScore = -1e9;
            for ($r = 0; $r < 12; $r++) foreach ([4,3] as $third) {
                $score = 0;
                foreach ($w as $pt => $wt) {
                    $iv = ($pt - $r + 12) % 12;
                    if ($iv == 0) $score += 3*$wt;
                    elseif ($iv == $third || $iv == 7) $score += 2*$wt;
                    else $score -= $wt;
                }
                if ($bass < PHP_INT_MAX && $bass % 12 == $r) $score += 2*($w[$bass] ?? 0);
                if ($score > $bestScore) { $bestScore = $score; $best = "$r:$third"; }
            }
            $chordAt[$s] = (count($pcs) >= 10 || $bestScore < 1.5*$wsum) ? null : $best;
        }

        /* 踏板通道：默认取「非旋律轨里音符最多那条」的通道（播放器全局合并，放哪条轨都生效） */
        if ($pedalCh === null) {
            $best = null;
            foreach ($tracks as $ti => $tr) {
                if ($ti === $melodyTi || !count($tr['notes'])) continue;
                if ($best === null || count($tr['notes']) > count($tracks[$best]['notes'])) $best = $ti;
            }
            if ($best === null) { $keys = array_keys($rank); $best = $keys[0]; }
            $pedalCh = $tracks[$best]['notes'][0][2];
        }
        echo "pedal on ch$pedalCh, window=$segBeats beats\n";

        /* 换踏：和声变化/模糊/超 8 拍 → 变化点前 0.15 拍放开，新窗口起点踩下 */
        $pedalEvents = []; $downAt = -1; $cur = null; $presses = 0;
        for ($s = $s0; $s <= $s1 + 1; $s++) {
            $ch = $chordAt[$s] ?? null;
            $boundary = $s * $segTicks;
            if ($downAt >= 0) {
                $held = $boundary - $downAt;
                if ($ch !== $cur || $held >= 8*$segTicks) {
                    $rel = max($downAt + 10, $boundary - (int)round(0.15*$div));
                    $pedalEvents[] = [$rel, 0]; $downAt = -1;
                }
            }
            if ($ch !== null && $downAt < 0 && $s <= $s1) {
                $pedalEvents[] = [$boundary, 127]; $downAt = $boundary; $presses++;
            }
            $cur = $ch;
        }

        /* 踏板事件写进「非旋律轨里音符最多」的那条轨（与 pedalCh 默认选择一致） */
        $tgt = null;
        foreach ($tracks as $ti => $tr) {
            if ($ti === $melodyTi || !count($tr['notes'])) continue;
            if ($tgt===null || count($tr['notes'])>count($tracks[$tgt]['notes'])) $tgt = $ti;
        }
        if ($tgt === null) $tgt = array_key_first($rank);
        foreach ($pedalEvents as $e) $tracks[$tgt]['other'][] = [$e[0], chr(0xB0|$pedalCh).chr(64).chr($e[1])];
        echo "pedal: $presses presses\n";
    }
}

/* ---------- 写出（保持原轨道结构，只包一次 MTrk） ---------- */
function vlq($n) { $s = chr($n & 0x7f); $n >>= 7; while ($n) { $s = chr(($n & 0x7f)|0x80).$s; $n >>= 7; } return $s; }
function mtrk($b) { return 'MTrk'.pack('N', strlen($b)).$b; }

$blob = 'MThd'.pack('N',6).pack('nnn', 1, count($tracks), $div);
$totalNotes = 0;
foreach ($tracks as $tr) {
    $evs = [];
    if ($tr['name'] !== '') $evs[] = [0, "\xFF\x03".chr(strlen($tr['name'])).$tr['name']]; // 不带前导 delta，由 vlq(0) 补
    foreach ($tr['meta'] as $m) $evs[] = [$m[0], $m[1]];
    foreach ($tr['notes'] as $n) {
        $evs[] = [$n[0], chr(0x90|$n[2]).chr($n[3]).chr($n[4])];
        $evs[] = [$n[1], chr(0x80|$n[2]).chr($n[3]).chr(0)];
        $totalNotes++;
    }
    foreach ($tr['other'] as $o) $evs[] = [$o[0], $o[1]];
    usort($evs, fn($a,$b) => $a[0] <=> $b[0]);
    $t = ''; $last = 0;
    foreach ($evs as $e) { $t .= vlq($e[0]-$last).$e[1]; $last = $e[0]; }
    $t .= vlq(0)."\xFF\x2F\x00";
    $blob .= mtrk($t);
}
file_put_contents($out, $blob);
echo "wrote $out: tracks=".count($tracks)." notes=$totalNotes size=".strlen($blob)."\n";
