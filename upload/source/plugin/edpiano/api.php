<?php
/**
 * 电钢琴 edpiano — 曲库接口。
 * 只列出本插件 midi/ 目录里的 .mid / .midi；同名 .txt 第一行当曲名、第二行当作者、第三行当分类（可省略）。
 * 同名 .inst.json 可声明这一首不支持的音色/模式（黑名单）。
 * 不读数据库、不接受参数，任何人都只能看到这个目录里的文件名。
 */
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=60');
header('X-Content-Type-Options: nosniff');

$dir = __DIR__.DIRECTORY_SEPARATOR.'midi';
$items = [];
if(is_dir($dir) && ($dh = @opendir($dir))) {
	while(($f = readdir($dh)) !== false) {
		if($f === '.' || $f === '..') {
			continue;
		}
		$ext = strtolower(pathinfo($f, PATHINFO_EXTENSION));
		if($ext !== 'mid' && $ext !== 'midi') {
			continue;
		}
		$full = $dir.DIRECTORY_SEPARATOR.$f;
		if(!is_file($full)) {
			continue;
		}
		$base = pathinfo($f, PATHINFO_FILENAME);
		$title = trim(preg_replace('/[_]+/', ' ', $base));
		$artist = '';
		$cat = '';
		$meta = $dir.DIRECTORY_SEPARATOR.$base.'.txt';
		if(is_file($meta)) {
			// 三行按序号取：曲名／作者／分类。不跳空行——作者空着但分类填了（"曲名\n\n分类"）也要各归各位
			$lines = @file($meta, FILE_IGNORE_NEW_LINES);
			if($lines) {
				if(trim($lines[0]) !== '') {
					$title = trim($lines[0]);
				}
				if(isset($lines[1])) {
					$artist = trim($lines[1]);
				}
				if(isset($lines[2])) {
					$cat = trim($lines[2]);
				}
			}
		}
		// 同名 .vol：这一首的小提琴伴奏音量倍率（0＝不合奏，0.2–1.5）
		$vol = 1.0;
		$volFile = $dir.DIRECTORY_SEPARATOR.$base.'.vol';
		if(is_file($volFile)) {
			$v = trim((string)@file_get_contents($volFile));
			if(is_numeric($v)) {
				$vol = max(0, min(1.5, (float)$v));
			}
		}
		// 同名 .dvol：这一首的架子鼓音量倍率（0＝不要鼓，0.2–1.5）
		$dvol = 1.0;
		$dvolFile = $dir.DIRECTORY_SEPARATOR.$base.'.dvol';
		if(is_file($dvolFile)) {
			$dv = trim((string)@file_get_contents($dvolFile));
			if(is_numeric($dv)) {
				$dvol = max(0, min(1.5, (float)$dv));
			}
		}
		// 同名 .inst.json：这一首不支持的音色/模式，黑名单式（{"no":["flute","ensemble"]}）。
		// id 取 edpiano.class.php 里 INSTRUMENTS 的键名和 ENSEMBLE/ENSEMBLE_DRUMS 的 id；.vol/.dvol=0 的合奏不用写在这里，前端自动视为不支持。
		$no = [];
		$instFile = $dir.DIRECTORY_SEPARATOR.$base.'.inst.json';
		if(is_file($instFile)) {
			$j = json_decode((string)@file_get_contents($instFile), true);
			if(isset($j['no']) && is_array($j['no'])) {
				foreach($j['no'] as $nid) {
					if(is_string($nid) && $nid !== '') {
						$no[] = $nid;
					}
				}
			}
		}
		$items[] = [
			'file' => $f,
			'title' => $title,
			'artist' => $artist,
			'cat' => mb_substr($cat, 0, 20, 'UTF-8'),
			'vol' => $vol,
			'dvol' => $dvol,
			'no' => array_values(array_unique($no)),
			'violin' => is_file($dir.DIRECTORY_SEPARATOR.$base.'.violin.json') ? (int)@filemtime($dir.DIRECTORY_SEPARATOR.$base.'.violin.json') : 0,
			'size' => (int)@filesize($full),
			'mtime' => (int)@filemtime($full),
		];
	}
	closedir($dh);
}
usort($items, function($a, $b) {
	$c = strnatcasecmp($a['file'], $b['file']);
	return $c !== 0 ? $c : strcmp($a['file'], $b['file']);
});

echo json_encode(
	['ok' => true, 'count' => count($items), 'items' => $items],
	JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
);
