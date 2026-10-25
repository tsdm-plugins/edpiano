<?php
/**
 * 电钢琴 edpiano
 * 论坛全站悬浮 MIDI 钢琴播放器：MIDI 在浏览器里解析，音色用 SoundFont 本地采样合成（WebAudio），
 * 服务器只负责列出 midi/ 目录里的曲目，不转码、不上传、不写数据库。
 *
 * - 悬浮小播放器：曲目、进度、音量、音色（电钢 / 大钢琴 / 八音盒 / 吉他 / 弦乐 / 长笛 / 马林巴 / 小提琴+钢琴 / 架子鼓+钢琴）、列表循环
 * - 换曲交叉淡入淡出，曲目之间不留空档；换页后记住曲目与进度，自动续播
 * - 曲库 = source/plugin/edpiano/midi/*.mid（可配同名 .txt：第一行曲名，第二行作者）
 * - 每首可配同名 .inst.json（{"no":["flute",...]}）声明不支持的音色/模式，播放器里置灰；.vol/.dvol=0 的合奏模式同理
 * - 关掉插件即整站恢复原样，不改模板与核心文件
 *
 * 作者：Carinoasd  ·  (C) 2026 Carinoasd
 */
if(!defined('IN_DISCUZ')) {
	exit('Access Denied');
}

class edpiano_core {

	const VER = '1.7.0';
	const BASE = 'source/plugin/edpiano/';
	const INSTRUMENTS = [
		'electric_piano_1' => '电钢琴',
		'acoustic_grand_piano' => '三角钢琴',
		'music_box' => '八音盒',
		'acoustic_guitar_steel' => '木吉他',
		'string_ensemble_1' => '弦乐合奏',
		'flute' => '长笛',
		'marimba' => '马林巴',
	];
	const ENSEMBLE = [
		'id' => 'ensemble',
		'label' => '小提琴+钢琴',
		'piano' => 'acoustic_grand_piano',
		'violin' => 'violin',
	];
	const ENSEMBLE_DRUMS = [
		'id' => 'drums',
		'label' => '架子鼓+钢琴',
		'piano' => 'acoustic_grand_piano',
		'drum' => 'percussion',
	];

	/** 后台设置（缺省值写在代码里，插件停用／缓存缺失也不会出错）。 */
	public static function settings() {
		global $_G;
		$c = isset($_G['cache']['plugin']['edpiano']) && is_array($_G['cache']['plugin']['edpiano']) ? $_G['cache']['plugin']['edpiano'] : [];
		$on = function($k) use ($c) {
			return !isset($c[$k]) || (string)$c[$k] === '' || (string)$c[$k] === '1';
		};
		$vol = isset($c['volume']) && $c['volume'] !== '' ? (int)$c['volume'] : 32;
		$vol = max(0, min(100, $vol));
		$fade = isset($c['fade']) && $c['fade'] !== '' ? (float)$c['fade'] : 0.7;
		$fade = max(0, min(2, $fade));
		$inst = $on('grand') ? 'acoustic_grand_piano' : 'electric_piano_1';
		return [
			'on' => $on('on'),
			'mobile' => $on('mobile'),
			'inst' => $inst,
			'volume' => $vol,
			'fade' => $fade,
			'auto' => $on('autoplay'),
		];
	}

	/** 静态资源版本号：跟着文件修改时间走，换音色／改 JS 后浏览器不会用旧缓存。 */
	public static function assetver() {
		$mt = 0;
		$files = ['assets/edpiano.js', 'assets/edpiano.css', 'assets/vendor/Midi.js'];
		foreach((array)@glob(DISCUZ_ROOT.self::BASE.'sf/*.json') as $f) {
			$files[] = 'sf/'.basename($f);
		}
		foreach($files as $f) {
			$t = @filemtime(DISCUZ_ROOT.self::BASE.$f);
			if($t && $t > $mt) {
				$mt = $t;
			}
		}
		return self::VER.($mt ? '.'.$mt : '');
	}

	/** 前台钩子输出：样式 + 配置 + 播放器脚本。 */
	public static function html($mobile = false) {
		global $_G;
		$st = self::settings();
		if(!$st['on']) {
			return '';
		}
		if($mobile && !$st['mobile']) {
			return '';
		}
		// 后台、AJAX 片段不注入
		if(!empty($_G['inajax'])) {
			return '';
		}
		if(isset($_G['basescript']) && $_G['basescript'] === 'admin') {
			return '';
		}
		$av = self::assetver();
		$cfg = [
			'api' => self::BASE.'api.php',
			'base' => self::BASE,
			'sf' => self::INSTRUMENTS,
			'ens' => self::ENSEMBLE,
			'ens2' => self::ENSEMBLE_DRUMS,
			'inst' => $st['inst'],
			'gain' => $st['volume'] / 100,
			'fade' => $st['fade'],
			'auto' => $st['auto'] ? 1 : 0,
			'v' => self::VER,
			'av' => $av,
		];
		$json = json_encode($cfg, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
		return '<link rel="stylesheet" href="'.self::BASE.'assets/edpiano.css?v='.$av.'" />'
			.'<script type="text/javascript">window.EDPIANO='.$json.';</script>'
			.'<script type="text/javascript" src="'.self::BASE.'assets/vendor/Midi.js?v='.$av.'" defer></script>'
			.'<script type="text/javascript" src="'.self::BASE.'assets/edpiano.js?v='.$av.'" defer></script>';
	}
}

class plugin_edpiano {

	public function global_footer() {
		return edpiano_core::html();
	}
}

class mobileplugin_edpiano {

	public function global_footer_mobile() {
		return edpiano_core::html(true);
	}
}
