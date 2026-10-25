<?php
/**
 * 电钢琴 edpiano — 曲库开发工具：MIDI 通道扫描
 *
 * 用法（仅命令行）：
 *   php midi-chans.php <文件.mid> [密度]
 *
 * 输出：每个 MIDI 通道的音符数、音高范围、GM 音色（program change）、延音踏板数；
 * 加「密度」参数时再按 10 秒窗口统计旋律通道（ch9 鼓除外）的起音数，
 * 用来判断整谱塞给单音色钢琴会不会糊（峰值 >20 音/秒 的段落要考虑精简声部）。
 * 钢琴化精简（midi-reduce.php）前先用它决定留哪些通道。
 */
if (PHP_SAPI !== 'cli') { exit("CLI only\n"); }
if ($argc < 2) { exit("usage: php midi-chans.php <file.mid> [density]\n"); }

$GM = ['Acoustic Grand','Bright Acoustic','Electric Grand','Honky-tonk','Electric Piano 1','Electric Piano 2','Harpsichord','Clavi','Celesta','Glockenspiel','Music Box','Vibraphone','Marimba','Xylophone','Tubular Bells','Dulcimer','Drawbar Organ','Percussive Organ','Rock Organ','Church Organ','Reed Organ','Accordion','Harmonica','Tango Accordion','Acoustic Guitar(nylon)','Acoustic Guitar(steel)','Electric Guitar(jazz)','Electric Guitar(clean)','Electric Guitar(muted)','Overdriven Guitar','Distortion Guitar','Guitar harmonics','Acoustic Bass','Electric Bass(finger)','Electric Bass(pick)','Fretless Bass','Slap Bass 1','Slap Bass 2','Synth Bass 1','Synth Bass 2','Violin','Viola','Cello','Contrabass','Tremolo Strings','Pizzicato Strings','Orchestral Harp','Timpani','String Ensemble 1','String Ensemble 2','SynthStrings 1','SynthStrings 2','Choir Aahs','Voice Oohs','Synth Voice','Orchestra Hit','Trumpet','Trombone','Tuba','Muted Trumpet','French Horn','Brass Section','SynthBrass 1','SynthBrass 2','Soprano Sax','Alto Sax','Tenor Sax','Baritone Sax','Oboe','English Horn','Bassoon','Clarinet','Piccolo','Flute','Recorder','Pan Flute','Blown Bottle','Shakuhachi','Whistle','Ocarina','Lead 1 (square)','Lead 2 (sawtooth)','Lead 3 (calliope)','Lead 4 (chiff)','Lead 5 (charang)','Lead 6 (voice)','Lead 7 (fifths)','Lead 8 (bass+lead)','Pad 1 (new age)','Pad 2 (warm)','Pad 3 (polysynth)','Pad 4 (choir)','Pad 5 (bowed)','Pad 6 (metallic)','Pad 7 (halo)','Pad 8 (sweep)','FX 1 (rain)','FX 2 (soundtrack)','FX 3 (crystal)','FX 4 (atmosphere)','FX 5 (brightness)','FX 6 (goblins)','FX 7 (echoes)','FX 8 (sci-fi)','Sitar','Banjo','Shamisen','Koto','Kalimba','Bag pipe','Fiddle','Shanai','Tinkle Bell','Agogo','Steel Drums','Woodblock','Taiko Drum','Melodic Tom','Synth Drum','Reverse Cymbal','Guitar Fret Noise','Breath Noise','Seashore','Bird Tweet','Telephone Ring','Helicopter','Applause','Gunshot'];

$d = file_get_contents($argv[1]);
if (substr($d,0,4) !== 'MThd') exit("not a MIDI file\n");
$hdrlen = unpack('N', substr($d,4,4))[1];
$div    = unpack('n', substr($d,12,2))[1];
$p = 8+$hdrlen; $tick = 0; $run = 0;
$progs = []; $tempo = 500000;
$onset = [];   // ch => [tick,...]
$range = [];   // ch => [n, min, max]
$cc64 = 0;
while ($p < strlen($d)) {
    if (substr($d,$p,4) !== 'MTrk') break;
    $len = unpack('N', substr($d,$p+4,4))[1];
    $end = $p+8+$len; $q = $p+8;
    while ($q < $end) {
        $dt = 0; do { $b = ord($d[$q++]); $dt = ($dt<<7)|($b&0x7f); } while ($b&0x80);
        $tick += $dt;
        $st = ord($d[$q]);
        if ($st < 0x80) { $st = $run; } else { $q++; $run = $st; }
        if ($st == 0xFF) {
            $mt = ord($d[$q++]); $l = 0;
            do { $b = ord($d[$q++]); $l = ($l<<7)|($b&0x7f); } while ($b&0x80);
            if ($mt == 0x51) $tempo = unpack('N',"\0".substr($d,$q,3))[1];
            if ($mt == 0x2F) { $q = $end; break; }
            $q += $l;
        } elseif ($st == 0xF0 || $st == 0xF7) {
            $l = 0; do { $b = ord($d[$q++]); $l = ($l<<7)|($b&0x7f); } while ($b&0x80); $q += $l;
        } else {
            $nh = $st & 0xF0; $c = $st & 0x0F;
            if ($nh == 0x90 && ord($d[$q+1]) > 0) {
                $onset[$c][] = $tick;
                if (!isset($range[$c])) $range[$c] = [0, 200, -1];
                $range[$c][0]++; $range[$c][1] = min($range[$c][1], ord($d[$q])); $range[$c][2] = max($range[$c][2], ord($d[$q]));
            } elseif ($nh == 0xB0) { if (ord($d[$q]) == 64 && ord($d[$q+1]) > 63) $cc64++; }
            elseif ($nh == 0xC0) { $progs[$c] = ord($d[$q]); }
            $q += ($nh == 0xC0 || $nh == 0xD0) ? 1 : 2;
        }
    }
    $p = $end;
}
printf("== %s  div=%d  bpm=%.1f  cc64=%d\n", basename($argv[1]), $div, 60e6/$tempo, $cc64);
$chanList = array_unique(array_merge(array_keys($range), array_keys($progs)));
sort($chanList);
foreach ($chanList as $c) {
    $pg = isset($progs[$c]) ? sprintf('%s(%d)', $GM[$progs[$c]] ?? '?', $progs[$c]) : '(no program)';
    $n = $range[$c][0] ?? 0;
    $r = $n ? "{$range[$c][1]}..{$range[$c][2]}" : '-';
    printf("  ch%-2d onsets=%-5d range=%-9s prog=%s\n", $c, $n, $r, $pg);
}
if (isset($argv[2]) && $argv[2] === 'density') {
    $all = [];
    foreach ($onset as $c => $arr) { if ($c == 9) continue; foreach ($arr as $t) $all[] = $t; }
    sort($all);
    $buckets = [];
    foreach ($all as $t) { $s = (int)floor($t / $div * ($tempo/1e6) / 10); $buckets[$s] = ($buckets[$s] ?? 0)+1; }
    ksort($buckets);
    echo "melodic onsets per 10s (drums excluded):\n";
    foreach ($buckets as $s => $n) printf("  %4ds: %d%s\n", $s*10, $n, str_repeat('#', (int)ceil($n/10)));
}
