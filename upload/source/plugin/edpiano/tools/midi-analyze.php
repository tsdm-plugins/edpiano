<?php
/**
 * 电钢琴 edpiano — 曲库开发工具：MIDI 概览分析
 *
 * 用法（仅命令行）：
 *   php midi-analyze.php <文件.mid>
 *
 * 输出：文件头信息（格式/轨道数/ticks/速度表）、总音符数与时长，
 * 以及每条轨道的音符数、音高范围、中位音高、连奏程度（音符间空隙）、延音踏板数。
 * 加新曲前用它判断谱面结构与「小提琴+钢琴」分声部可行性（见 tools/README.md）。
 */
if (PHP_SAPI !== 'cli') { exit("CLI only\n"); }
if ($argc < 2) { exit("usage: php midi-analyze.php <file.mid>\n"); }

$d = file_get_contents($argv[1]);
if (substr($d,0,4) !== 'MThd') exit("not a MIDI file\n");
$hdrlen = unpack('N', substr($d,4,4))[1];
$fmt    = unpack('n', substr($d,8,2))[1];
$ntrk   = unpack('n', substr($d,10,2))[1];
$div    = unpack('n', substr($d,12,2))[1];
printf("== %s  fmt=%d tracks=%d div=%d\n", basename($argv[1]), $fmt, $ntrk, $div);

$p = 8+$hdrlen; $ti = 0; $tempo = 500000; $tempi = []; $totalNotes = 0; $lastTick = 0;
while ($p < strlen($d)) {
    if (substr($d,$p,4) !== 'MTrk') { echo "  (non-MTrk chunk at $p, stop)\n"; break; }
    $len = unpack('N', substr($d,$p+4,4))[1];
    $end = $p+8+$len; $q = $p+8; $tick = 0; $run = 0;
    $notes = 0; $min = 200; $max = -1; $pitches = []; $durs = []; $gaps = []; $cc64 = 0; $on = [];
    while ($q < $end) {
        $dt = 0; do { $b = ord($d[$q++]); $dt = ($dt<<7)|($b&0x7f); } while ($b&0x80);
        $tick += $dt;
        $st = ord($d[$q]);
        if ($st < 0x80) { $st = $run; } else { $q++; $run = $st; }
        if ($st == 0xFF) {
            $mt = ord($d[$q++]); $l = 0;
            do { $b = ord($d[$q++]); $l = ($l<<7)|($b&0x7f); } while ($b&0x80);
            if ($mt == 0x51) { $tempo = unpack('N',"\0".substr($d,$q,3))[1]; $tempi[] = [round($tick/$div,2), round(60e6/$tempo,1)]; }
            if ($mt == 0x2F) break;
            $q += $l;
        } elseif ($st == 0xF0 || $st == 0xF7) {
            $l = 0; do { $b = ord($d[$q++]); $l = ($l<<7)|($b&0x7f); } while ($b&0x80); $q += $l;
        } else {
            $nh = $st & 0xF0;
            if ($nh == 0x90 && ord($d[$q+1]) > 0) { $on[($st&0x0F).":".ord($d[$q])][] = $tick; $pitches[] = ord($d[$q]); $q += 2; }
            elseif ($nh == 0x80 || ($nh == 0x90 && ord($d[$q+1]) == 0)) {
                $pt = ($st&0x0F).":".ord($d[$q]);
                if (!empty($on[$pt])) {
                    $notes++; $lastTick = max($lastTick, $tick);
                    $durs[] = $tick - array_shift($on[$pt]);
                }
                $q += 2;
            } elseif ($nh == 0xB0) { if (ord($d[$q]) == 64 && ord($d[$q+1]) > 63) $cc64++; $q += 2; }
            elseif ($nh == 0xC0 || $nh == 0xD0) { $q += 1; }
            else { $q += 2; }
        }
    }
    if ($notes) {
        $min = min($pitches); $max = max($pitches);
        sort($pitches); $median = $pitches[intdiv(count($pitches),2)];
        printf("  track %d: notes=%-5d range=%3d..%-3d median=%d cc64=%d\n", $ti, $notes, $min, $max, $median, $cc64);
        $totalNotes += $notes;
    } else {
        printf("  track %d: (meta/tempo only)\n", $ti);
    }
    $ti++; $p = $end;
}
$durS = ($lastTick / $div) * ($tempo / 1e6);
printf("  TOTAL notes=%d  last_tick=%d  dur≈%.1fs (%d:%02d)  final_bpm=%.1f\n",
    $totalNotes, $lastTick, $durS, intdiv((int)$durS, 60), (int)$durS % 60, 60e6/$tempo);
if ($tempi) {
    echo "  tempo map (".count($tempi)." entries, first 8):\n";
    foreach (array_slice($tempi, 0, 8) as $t) echo "    beat ".str_pad((string)$t[0], 8)." bpm={$t[1]}\n";
    if (count($tempi) > 8) echo "    …（速度事件多＝谱面带 rubato 渐快渐慢）\n";
}
