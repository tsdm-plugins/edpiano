<?php
/**
 * 电钢琴 edpiano — 后台曲库管理（管理中心模块 admincp）。
 * 曲库仍是 midi/ 目录里的 .mid 文件（同名 .txt 第一行曲名、第二行作者、第三行分类），
 * 这里只是把「远程桌面拷文件」搬进后台网页：上传、改曲名作者、重命名（=调排序）、删除。
 * 不建表、不写数据库；api.php 照旧扫目录，前台最多 60 秒自动出新列表。
 *
 * 作者：Carinoasd  ·  (C) 2026 Carinoasd
 */
if(!defined('IN_DISCUZ') || !defined('IN_ADMINCP')) {
	exit('Access Denied');
}

$epdir = __DIR__.DIRECTORY_SEPARATOR.'midi';
$epbase = 'action=plugins&operation=config&do='.(int)$pluginid.'&identifier=edpiano&pmod=admincp';
$epform = 'plugins&operation=config&do='.(int)$pluginid.'&identifier=edpiano&pmod=admincp';

/** 扫曲库：与 api.php 同一套读法，列表显示和接口永远一致。 */
function edpiano_acp_scan($dir) {
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
				// 与 api.php 同一套读法：三行按序号取（曲名／作者／分类），不跳空行
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
			$vol = 1.0;
			$volFile = $dir.DIRECTORY_SEPARATOR.$base.'.vol';
			if(is_file($volFile)) {
				$v = trim((string)@file_get_contents($volFile));
				if(is_numeric($v)) {
					$vol = max(0, min(1.5, (float)$v));
				}
			}
			$items[] = [
				'file' => $f,
				'base' => $base,
				'ext' => $ext,
				'title' => $title,
				'artist' => $artist,
				'cat' => $cat,
				'hastxt' => is_file($meta),
				'vol' => $vol,
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
	return $items;
}

/** 文件基名净化：只留英文/数字/点/横杠（列表排序与 URL 都吃 ASCII，中文请写进 .txt 曲名）。 */
function edpiano_acp_safename($name) {
	$name = trim((string)$name);
	$name = preg_replace('/\.(mid|midi)$/i', '', $name);
	$name = preg_replace('/[^A-Za-z0-9._\-]+/', '-', $name);
	$name = preg_replace('/-{2,}/', '-', $name);
	$name = trim($name, '-._');
	// Windows 保留名（CON / AUX / COM1 …）当文件名会出问题，前面垫一层
	if(preg_match('/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i', $name)) {
		$name = 'song-'.$name;
	}
	return $name !== '' ? $name : '';
}

/** 曲名/作者净化：去转义、去控制字符、限长（不用 /u 修饰符，坏字节也不会让结果变 null）。 */
function edpiano_acp_text($v, $max) {
	$v = (string)dstripslashes(trim((string)$v));
	$v = (string)preg_replace('/[\x00-\x1f\x7f]+/', '', $v);
	if(function_exists('mb_substr')) {
		$v = mb_substr($v, 0, $max, 'UTF-8');
	} else {
		$v = substr($v, 0, $max * 4);
	}
	return $v;
}

/** 小型行内表单开头（showformheader 之外的第二、三个表单用它）。 */
function edpiano_acp_form($epform) {
	return '<form method="post" action="'.ADMINSCRIPT.'?action='.$epform.'" style="margin:0;display:inline">'
		.'<input type="hidden" name="formhash" value="'.FORMHASH.'">';
}

$epitems = edpiano_acp_scan($epdir);
$epnames = [];
foreach($epitems as $it) {
	$epnames[$it['file']] = true;
}

/* ═══════════ 上传 ═══════════ */
if(submitcheck('epuploadsubmit')) {
	$ok = $bad = 0;
	$msgs = [];
	$files = isset($_FILES['epmidi']) ? $_FILES['epmidi'] : null;
	if(!$files || !is_array($files['name'])) {
		cpmsg('没有收到文件，请选择至少一个 .mid / .midi 文件。', $epbase, 'error');
	}
	foreach($files['name'] as $i => $origname) {
		$err = isset($files['error'][$i]) ? (int)$files['error'][$i] : UPLOAD_ERR_NO_FILE;
		$tmp = isset($files['tmp_name'][$i]) ? $files['tmp_name'][$i] : '';
		$size = isset($files['size'][$i]) ? (int)$files['size'][$i] : 0;
		if($err === UPLOAD_ERR_NO_FILE) {
			continue;
		}
		$nice = $origname !== '' ? dhtmlspecialchars($origname) : '（未命名）';
		if($err !== UPLOAD_ERR_OK) {
			$bad++;
			$msgs[] = $nice.'：上传失败（'.($err == UPLOAD_ERR_INI_SIZE ? '超过 PHP upload_max_filesize 限制' : '错误码 '.$err).'）。';
			continue;
		}
		$ext = strtolower(pathinfo($origname, PATHINFO_EXTENSION));
		if($ext !== 'mid' && $ext !== 'midi') {
			$bad++;
			$msgs[] = $nice.'：不是 .mid / .midi 文件。';
			continue;
		}
		if($size <= 0 || $size > 5 * 1024 * 1024) {
			$bad++;
			$msgs[] = $nice.'：大小需在 5MB 以内。';
			continue;
		}
		if(!is_uploaded_file($tmp)) {
			$bad++;
			$msgs[] = $nice.'：上传校验失败。';
			continue;
		}
		$fh = @fopen($tmp, 'rb');
		$magic = $fh ? fread($fh, 4) : false;
		if($fh) {
			fclose($fh);
		}
		if($magic !== 'MThd') {
			$bad++;
			$msgs[] = $nice.'：不是标准 MIDI 文件（文件头必须是 MThd）。';
			continue;
		}
		$base = edpiano_acp_safename(pathinfo($origname, PATHINFO_FILENAME));
		if($base === '') {
			$base = 'song-'.date('md-His');
		}
		$target = $base.'.'.$ext;
		$n = 0;
		while(file_exists($epdir.DIRECTORY_SEPARATOR.$target)) {
			$n++;
			$target = $base.'-'.$n.'.'.$ext;
		}
		if(move_uploaded_file($tmp, $epdir.DIRECTORY_SEPARATOR.$target)) {
			$ok++;
			$msgs[] = $nice.' → '.$target.'：已加入曲库。';
		} else {
			$bad++;
			$msgs[] = $nice.'：写入曲库目录失败'.(!is_writable($epdir) ? '（目录不可写）' : '').'。';
		}
	}
	cpmsg('上传完成：成功 '.$ok.' 个'.($bad ? '，失败 '.$bad.' 个' : '').'<br /><br />'.implode('<br />', $msgs), $epbase, $bad && !$ok ? 'error' : 'succeed');
}

/* ═══════════ 保存曲名 / 作者（写同名 .txt） ═══════════ */
if(submitcheck('epmetasubmit')) {
	$epfile = basename((string)getgpc('epfile'));
	if(!isset($epnames[$epfile])) {
		cpmsg('曲目不存在，可能刚被别人处理过，请刷新重试。', $epbase, 'error');
	}
	$base = pathinfo($epfile, PATHINFO_FILENAME);
	$title = edpiano_acp_text(getgpc('eptitle'), 120);
	$artist = edpiano_acp_text(getgpc('epartist'), 60);
	$cat = edpiano_acp_text(getgpc('epcat'), 20);
	$volRaw = trim((string)getgpc('epvol'));
	$vol = 1.0;
	if($volRaw !== '') {
		if(!is_numeric($volRaw)) {
			cpmsg('伴奏音量要填数字：0＝这首不合奏，1＝默认，0.2–1.5 之间微调。', $epbase, 'error');
		}
		$vol = max(0, min(1.5, (float)$volRaw));
	}
	$volFile = $epdir.DIRECTORY_SEPARATOR.$base.'.vol';
	if(abs($vol - 1.0) < 0.001) {
		if(is_file($volFile)) {
			@unlink($volFile);
		}
	} else {
		$volOut = rtrim(rtrim(number_format($vol, 2, '.', ''), '0'), '.');
		if(@file_put_contents($volFile, $volOut."\n", LOCK_EX) === false) {
			cpmsg('写入 '.$base.'.vol 失败，请检查目录权限。', $epbase, 'error');
		}
	}
	$txt = $epdir.DIRECTORY_SEPARATOR.$base.'.txt';
	if($title === '' && $artist === '' && $cat === '') {
		if(is_file($txt) && !@unlink($txt)) {
			cpmsg('删除 '.$base.'.txt 失败，请检查目录权限。', $epbase, 'error');
		}
		cpmsg('已清除 '.$epfile.' 的文字信息，曲名回落为文件名。', $epbase, 'succeed');
	}
	if($title === '') {
		cpmsg('曲名不能为空（只想删掉文字信息请把曲名、作者、分类都留空）。', $epbase, 'error');
	}
	if(@file_put_contents($txt, $title."\n".$artist."\n".$cat."\n", LOCK_EX) === false) {
		cpmsg('写入 '.$base.'.txt 失败，请检查目录权限。', $epbase, 'error');
	}
	cpmsg($epfile.' 的曲名 / 作者 / 分类已保存。', $epbase, 'succeed');
}

/* ═══════════ 重命名（= 调整曲目排序） ═══════════ */
if(submitcheck('eprenamesubmit')) {
	$epfile = basename((string)getgpc('epfile'));
	if(!isset($epnames[$epfile])) {
		cpmsg('曲目不存在，可能刚被别人处理过，请刷新重试。', $epbase, 'error');
	}
	$it = null;
	foreach($epitems as $x) {
		if($x['file'] === $epfile) {
			$it = $x;
			break;
		}
	}
	$new = edpiano_acp_safename(getgpc('epnewname'));
	if($new === '') {
		cpmsg('新文件名只能用英文、数字、点、横杠（中文曲名请写在曲名栏，不用改文件名）。', $epbase, 'error');
	}
	if(strcmp($new, $it['base']) === 0) {
		cpmsg('文件名没有变化。', $epbase, 'succeed');
	}
	if(strcasecmp($new, $it['base']) !== 0) {
		foreach($epitems as $x) {
			if(strcasecmp($x['base'], $new) === 0) {
				cpmsg('已有一首叫 '.$x['file'].'，换个名字吧。', $epbase, 'error');
			}
		}
	}
	$target = $new.'.'.$it['ext'];
	$oldmid = $epdir.DIRECTORY_SEPARATOR.$epfile;
	$newmid = $epdir.DIRECTORY_SEPARATOR.$target;
	$oldtxt = $epdir.DIRECTORY_SEPARATOR.$it['base'].'.txt';
	$newtxt = $epdir.DIRECTORY_SEPARATOR.$new.'.txt';
	$oldvol = $epdir.DIRECTORY_SEPARATOR.$it['base'].'.vol';
	$newvol = $epdir.DIRECTORY_SEPARATOR.$new.'.vol';
	if(!@rename($oldmid, $newmid)) {
		cpmsg('重命名失败，请检查目录权限。', $epbase, 'error');
	}
	if(is_file($oldtxt)) {
		@rename($oldtxt, $newtxt);
	}
	if(is_file($oldvol)) {
		@rename($oldvol, $newvol);
	}
	cpmsg($epfile.' 已改名为 '.$target.'，列表按文件名排序，位置会相应变化。', $epbase, 'succeed');
}

/* ═══════════ 删除 ═══════════ */
if(submitcheck('epdelsubmit')) {
	$epfile = basename((string)getgpc('epfile'));
	if(!isset($epnames[$epfile])) {
		cpmsg('曲目不存在，可能刚被别人处理过，请刷新重试。', $epbase, 'error');
	}
	$base = pathinfo($epfile, PATHINFO_FILENAME);
	$txt = $epdir.DIRECTORY_SEPARATOR.$base.'.txt';
	$volFile = $epdir.DIRECTORY_SEPARATOR.$base.'.vol';
	if(!@unlink($epdir.DIRECTORY_SEPARATOR.$epfile)) {
		cpmsg('删除 '.$epfile.' 失败，请检查目录权限。', $epbase, 'error');
	}
	if(is_file($txt)) {
		@unlink($txt);
	}
	if(is_file($volFile)) {
		@unlink($volFile);
	}
	cpmsg('已删除 '.$epfile.(is_file($txt) || is_file($volFile) ? '（同名 .txt/.vol 未删掉，请检查权限）' : ' 与同名 .txt/.vol').'。', $epbase, 'succeed');
}

/* ═══════════ 页面 ═══════════ */
if(!is_writable($epdir)) {
	echo '<div style="margin:8px 0;padding:10px;border:1px solid #d00;background:#fff3f3;color:#c00">'
		.'⚠ 曲库目录不可写（source/plugin/edpiano/midi/），上传、改名、删除都不会成功。请先给网站进程账号加上该目录的写入权限。</div>';
}

showformheader($epform, 'enctype');
showtableheader('上传新曲（可一次多选）');
showtablerow('', ['colspan="2"'], [
	'<input type="file" name="epmidi[]" multiple accept=".mid,.midi,audio/midi,audio/x-midi" />'
	.'<button type="submit" class="btn" name="epuploadsubmit" value="yes">上传</button>'
	.'<div style="color:#999;padding-top:4px">标准 MIDI（format 0 / 1），单个 5MB 以内。文件名会自动转成英文/数字/横杠；'
	.'中文曲名、作者、分类上传后在下面列表里填。同名文件自动加 -1 后缀，不会覆盖。</div>',
]);
showtablefooter();
showformfooter();

showtableheader('曲库（共 '.count($epitems).' 首，按文件名自然排序）');
showtablerow('', ['class="header"'], ['序号', '文件', '曲名 / 作者 / 分类 / 伴奏音量（保存写同名 .txt / .vol）', '大小', '修改时间', '排序 / 删除']);
$i = 0;
foreach($epitems as $it) {
	$i++;
	$metaform = edpiano_acp_form($epform)
		.'<input type="hidden" name="epfile" value="'.dhtmlspecialchars($it['file']).'" />'
		.'<input type="text" class="txt" style="width:150px" name="eptitle" value="'.dhtmlspecialchars($it['title']).'" placeholder="曲名" /> '
		.'<input type="text" class="txt" style="width:110px" name="epartist" value="'.dhtmlspecialchars($it['artist']).'" placeholder="作者" /> '
		.'<input type="text" class="txt" style="width:70px" name="epcat" value="'.dhtmlspecialchars($it['cat']).'" placeholder="分类" /> '
		.'<input type="text" class="txt" style="width:42px" name="epvol" value="'.dhtmlspecialchars(number_format($it['vol'], 2, '.', '')).'" title="小提琴伴奏音量倍率：0＝不合奏，1＝默认" placeholder="1" /> '
		.'<button type="submit" class="btn" name="epmetasubmit" value="yes">保存</button></form>';
	$actform = edpiano_acp_form($epform)
		.'<input type="hidden" name="epfile" value="'.dhtmlspecialchars($it['file']).'" />'
		.'<input type="text" class="txt" style="width:120px" name="epnewname" value="'.dhtmlspecialchars($it['base']).'" /> '
		.'<button type="submit" class="btn" name="eprenamesubmit" value="yes">改名</button></form>'
		.'<div style="height:6px"></div>'
		.edpiano_acp_form($epform)
		.'<input type="hidden" name="epfile" value="'.dhtmlspecialchars($it['file']).'" />'
		.'<button type="submit" class="btn" name="epdelsubmit" value="yes" onclick="return confirm(\'删除 '.$it['file'].' ？同时删同名 .txt，不可恢复。\')">删除</button></form>';
	showtablerow('', [], [
		$i,
		dhtmlspecialchars($it['file']).($it['hastxt'] ? '' : '<br /><span style="color:#999">无 .txt，曲名取自文件名</span>'),
		$metaform,
		$it['size'] >= 1024 ? round($it['size'] / 1024, 1).' KB' : $it['size'].' B',
		dgmdate($it['mtime'], 'Y-n-j H:i'),
		$actform,
	]);
}
if(!$i) {
	showtablerow('', ['colspan="6"'], ['曲库是空的，先在上面传几首 .mid 吧。']);
}
showtablefooter();

echo '<div style="padding:10px 4px;color:#999;font-size:12px">'
	.'改动对前台最多 60 秒生效（曲库接口带 60 秒浏览器缓存），播放器会自动换列表，会员无需刷新两次。<br />'
	.'直接往 source/plugin/edpiano/midi/ 拷文件的老办法也一直可用；列表排序＝文件名自然排序（01-、02- 这样开头）。<br />'
	.'电钢琴 edpiano by Carinoasd · (C) 2026 Carinoasd</div>';
