/*!
 * 电钢琴 edpiano — 悬浮 MIDI 播放器
 * MIDI 在浏览器里解析（@tonejs/midi），音色用 SoundFont 采样 + WebAudio 实时合成。
 * 曲目之间交叉淡入淡出；换页后靠 localStorage 记住曲目与进度自动续播。
 * (C) 2026 Carinoasd
 */
(function() {
	'use strict';

	var CFG = window.EDPIANO;
	if (!CFG || !CFG.api || window.__edpianoBooted) {
		return;
	}
	// 只跑在最外层页面；站内 iframe（附件、编辑器之类）不挂播放器，也避免和多窗口同步打架
	if (window.top !== window.self) {
		return;
	}
	window.__edpianoBooted = true;

	var STORE = 'edpiano.v1';
	var LOOKAHEAD = 1.5;
	var TICK = 200;
	var BASE = CFG.base || 'source/plugin/edpiano/';
	var VERSION = CFG.v || '1';
	var ASSETV = CFG.av || VERSION;
	var FADE = typeof CFG.fade === 'number' ? CFG.fade : 0.7;
	var INSTS = CFG.sf || { electric_piano_1: '电钢琴', acoustic_grand_piano: '三角钢琴' };
	var ENS = (CFG.ens && CFG.ens.id && CFG.ens.piano && CFG.ens.violin) ? CFG.ens : null;
	var ENS2 = (CFG.ens2 && CFG.ens2.id && CFG.ens2.piano && CFG.ens2.drum) ? CFG.ens2 : null;
	var SHORT_INST = {
		electric_piano_1: '电钢',
		acoustic_grand_piano: '大钢琴',
		music_box: '八音盒',
		acoustic_guitar_steel: '吉他',
		string_ensemble_1: '弦乐',
		flute: '长笛',
		marimba: '马林巴'
	};
	var DEFAULT_INST = CFG.inst && INSTS[CFG.inst] ? CFG.inst : 'electric_piano_1';

	var ICON = {
		note: '<svg viewBox="0 0 24 24"><path d="M9.2 18.3a2.6 2.6 0 1 1-1.7-2.44V5.1l11-2.2v11.1a2.6 2.6 0 1 1-1.7-2.44V5.36l-7.6 1.52z"/></svg>',
		play: '<svg viewBox="0 0 24 24"><path d="M8 5.1v13.8L19.4 12z"/></svg>',
		pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.4v14H7zm6.6 0H17v14h-3.4z"/></svg>',
		prev: '<svg viewBox="0 0 24 24"><path d="M7 5h2.2v14H7zm11.6.55v12.9L9.3 12z"/></svg>',
		next: '<svg viewBox="0 0 24 24"><path d="M14.8 5H17v14h-2.2zM5.4 5.55v12.9L14.7 12z"/></svg>',
		loop: '<svg viewBox="0 0 24 24"><path d="M17.5 6.5A7.6 7.6 0 0 0 4.6 12h2.05a5.55 5.55 0 0 1 9.4-3.9l-2.3 2.3h6.15V4.25zM6.5 17.5A7.6 7.6 0 0 0 19.4 12h-2.05a5.55 5.55 0 0 1-9.4 3.9l2.3-2.3H4.05v6.15z"/></svg>',
		vol: '<svg viewBox="0 0 24 24"><path d="M4 9.4h3.1L11.4 6v12L7.1 14.6H4zm10.2-1.1a5.1 5.1 0 0 1 0 7.4l-1.2-1.6a3 3 0 0 0 0-4.2zm2.3-2.3a8.4 8.4 0 0 1 0 12l-1.2-1.6a6.3 6.3 0 0 0 0-8.8z"/></svg>',
		fold: '<svg viewBox="0 0 24 24"><path d="M9 6.1v11.8L18 12z"/></svg>',
		mute: '<svg viewBox="0 0 24 24"><path d="M4 9.4h3.1L11.4 6v12L7.1 14.6H4zm12.4-1.5 1.5-1.5 1.5 1.5 1.5-1.5 1.4 1.4-1.5 1.5 1.5 1.5-1.4 1.4-1.5-1.5-1.5 1.5-1.5-1.5-1.4-1.4 1.5-1.5-1.5-1.5z" transform="translate(-1.6 1.4)"/></svg>',
		min: '<svg viewBox="0 0 24 24"><path d="M5.6 10.9h12.8v2.2H5.6z"/></svg>'
	};

	/* ---------------- 小工具 ---------------- */

	function clamp(v, a, b) {
		return v < a ? a : v > b ? b : v;
	}

	function byId(id) {
		return document.getElementById(id);
	}

	function svg(name) {
		return ICON[name] || '';
	}

	function fmt(sec) {
		sec = Math.max(0, Math.floor(sec || 0));
		var m = Math.floor(sec / 60);
		var s = sec % 60;
		return m + ':' + (s < 10 ? '0' : '') + s;
	}

	function formatError(e) {
		return e && e.message ? e.message : '未知错误';
	}

	function validInst(name) {
		return !!(name && (INSTS[name] || (ENS && name === ENS.id) || (ENS2 && name === ENS2.id)));
	}

	/** 这首歌支持哪些音色/模式：api 里同名 .inst.json 的 no 是黑名单；.vol/.dvol=0 的合奏模式也算不支持 */
	function instAllowed(track, name) {
		if (!validInst(name)) {
			return false;
		}
		if (!track) {
			return true;
		}
		var no = track.no;
		if (no && no.length) {
			for (var i = 0; i < no.length; i++) {
				if (no[i] === name) {
					return false;
				}
			}
		}
		if (ENS && name === ENS.id && (track.vol === 0 || track.vol === '0')) {
			return false;
		}
		if (ENS2 && name === ENS2.id && (track.dvol === 0 || track.dvol === '0')) {
			return false;
		}
		return true;
	}

	/** 切到不支持的歌时退回的音色：默认音色优先，不行就挑第一个支持的单音色（黑名单不该禁掉所有音色） */
	function fallbackInst(track) {
		if (instAllowed(track, DEFAULT_INST)) {
			return DEFAULT_INST;
		}
		for (var k in INSTS) {
			if (Object.prototype.hasOwnProperty.call(INSTS, k) && instAllowed(track, k)) {
				return k;
			}
		}
		return DEFAULT_INST;
	}

	function readStore() {
		try {
			var raw = window.localStorage && window.localStorage.getItem(STORE);
			return raw ? JSON.parse(raw) : null;
		} catch (e) {
			return null;
		}
	}

	function writeStore(obj) {
		try {
			window.localStorage && window.localStorage.setItem(STORE, JSON.stringify(obj));
		} catch (e) { /* 隐私模式 / 容量满，忽略 */ }
	}

	/* ---------------- 状态 ---------------- */

	var saved = readStore() || {};
	var hasSaved = !!(saved && (saved.playing || saved.pos > 0 || saved.idx > 0));
	var autoBoot = !!CFG.auto && !hasSaved;
	// 上次离开时在播：记住「想继续」，但界面先按未播显示，真正开声后再切成播放中
	var wantResume = !!saved.playing;
	var state = {
		idx: typeof saved.idx === 'number' ? saved.idx : 0,
		pos: typeof saved.pos === 'number' ? saved.pos : 0,
		playing: false,
		vol: typeof saved.vol === 'number' ? clamp(saved.vol, 0, 1) : (typeof CFG.gain === 'number' ? clamp(CFG.gain, 0, 1) : 0.32),
		inst: (saved.inst && (INSTS[saved.inst] || (ENS && saved.inst === ENS.id) || (ENS2 && saved.inst === ENS2.id))) ? saved.inst : DEFAULT_INST,
		loop: saved.loop === undefined ? true : !!saved.loop,
		open: !!saved.open,
		// 每个分类的折叠状态：{ 分类名: 1 } ＝收起；跟音量、音色一样记在浏览器里
		closed: (function(o) {
			var r = {};
			if (o && typeof o === 'object') {
				for (var k in o) {
					if (Object.prototype.hasOwnProperty.call(o, k) && o[k]) {
						r[k] = 1;
					}
				}
			}
			return r;
		})(saved.closed),
		pending: false
	};
	var lastVol = state.vol > 0 ? state.vol : 0.32;

	var app = {
		tracks: [],
		cur: -1,
		ctx: null,
		master: null,
		send: null,
		active: null,
		lastDur: 0,
		songs: {},
		insts: {},
		loading: {},
		token: 0,
		busy: false,
		timer: 0,
		status: '',
		progress: 0,
		fatal: '',
		ui: {},
		gestureBound: false,
		gestureHandler: null,
		drag: false
	};

	/* ---------------- 多窗口同步 ----------------
	 * 同一个论坛开多个标签/窗口时，只让「当前活跃」的那个出声，其他窗口做跟随者：
	 * 曲目、进度、音色、循环状态都跟它同步，但不出声；切回哪个窗口，哪个窗口接管继续放。
	 * 用 BroadcastChannel 通信，老浏览器退回 localStorage 的 storage 事件。
	 */

	var TAB_ID = 'w' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
	var BUS_KEY = 'edpiano.bus';
	var bc = null;
	try {
		if (window.BroadcastChannel) {
			bc = new window.BroadcastChannel('edpiano');
		}
	} catch (e) {
		bc = null;
	}
	var sync = {
		isOwner: false,
		owner: null,
		claimAt: 0,
		lastClaim: 0,
		remote: null,
		remoteAt: 0,
		remoteFrom: null,
		resumeTimer: 0,
		linkAt: 0,
		ready: false
	};

	function post(msg) {
		msg.from = TAB_ID;
		msg.at = Date.now();
		msg.n = Math.random();
		if (bc) {
			try {
				bc.postMessage(msg);
			} catch (e) { /* ignore */ }
		} else {
			try {
				window.localStorage.setItem(BUS_KEY, JSON.stringify(msg));
			} catch (e) { /* ignore */ }
		}
	}

	function newerClaim(at, from, mineAt) {
		return at > mineAt || (at === mineAt && String(from) > String(TAB_ID));
	}

	function snapshot() {
		return {
			idx: state.idx,
			pos: app.active ? app.active.songTime() : (state.pos || 0),
			dur: app.active ? app.active.duration : (app.lastDur || 0),
			playing: !!app.active || (app.busy && !!wantResume),
			inst: state.inst,
			loop: !!state.loop
		};
	}

	function postState() {
		if (!sync.isOwner) {
			return;
		}
		var s = snapshot();
		s.type = 'state';
		s.claimAt = sync.claimAt;
		post(s);
	}

	function handleBus(msg) {
		if (!msg || !msg.type || msg.from === TAB_ID) {
			return;
		}
		var at = msg.claimAt || msg.at || 0;
		if (msg.type === 'claim') {
			if (!sync.isOwner || newerClaim(at, msg.from, sync.claimAt)) {
				if (sync.isOwner) {
					stepDown(true, msg.from);
				}
				sync.owner = msg.from;
				sync.claimAt = at;
				if (sync.isOwner) {
					postState();
				}
			} else {
				postState();
			}
			return;
		}
		if (msg.type === 'state') {
			if (sync.isOwner) {
				if (!newerClaim(at, msg.from, sync.claimAt)) {
					return;
				}
				stepDown(false);
				sync.owner = msg.from;
				sync.claimAt = at;
			} else if (sync.owner && msg.from !== sync.owner && at <= sync.claimAt) {
				return;
			}
			adopt(msg);
			return;
		}
		if (msg.type === 'hand') {
			adopt(msg);
			if (msg.to !== TAB_ID && sync.remote) {
				sync.remote.playing = false;
			}
			if (!sync.isOwner) {
				renderStatus();
				renderProgress();
			}
			return;
		}
		if (msg.type === 'ping' && sync.isOwner) {
			postState();
		}
	}

	function adopt(msg) {
		sync.remote = {
			idx: typeof msg.idx === 'number' ? msg.idx : state.idx,
			pos: typeof msg.pos === 'number' ? msg.pos : 0,
			dur: typeof msg.dur === 'number' ? msg.dur : 0,
			playing: !!msg.playing,
			inst: msg.inst,
			loop: msg.loop
		};
		sync.remoteAt = msg.at || Date.now();
		sync.remoteFrom = msg.from || null;
		if (sync.isOwner) {
			return;
		}
		var changed = false;
		if (sync.remote.idx !== state.idx) {
			state.idx = sync.remote.idx;
			changed = true;
		}
		if (msg.inst && validInst(msg.inst) && msg.inst !== state.inst) {
			state.inst = msg.inst;
			changed = true;
		}
		if (typeof msg.loop === 'boolean' && msg.loop !== state.loop) {
			state.loop = msg.loop;
			changed = true;
		}
		state.playing = false;
		if (changed) {
			render();
		} else {
			renderStatus();
			renderProgress();
		}
	}

	function stepDown(withHand, toId) {
		if (!sync.isOwner) {
			return;
		}
		var s = snapshot();
		s.type = 'hand';
		s.claimAt = sync.claimAt;
		if (toId) {
			s.to = toId;
		}
		sync.isOwner = false;
		sync.owner = null;
		if (app.active) {
			state.pos = app.active.pause();
			app.active = null;
		}
		state.playing = false;
		state.pending = false;
		clearGesture();
		stopTick();
		if (withHand) {
			post(s);
		}
		saveState();
		render();
	}

	function claim() {
		if (sync.isOwner) {
			return true;
		}
		var now = Date.now();
		if (now - sync.lastClaim > 300) {
			sync.lastClaim = now;
			sync.claimAt = now;
		}
		sync.isOwner = true;
		sync.owner = TAB_ID;
		post({ type: 'claim', claimAt: sync.claimAt });
		return true;
	}

	/** 在跟随者窗口里动一下就接管：先把对方的曲目/进度接过来 */
	function ensureOwner() {
		if (sync.isOwner) {
			return;
		}
		var r = sync.remote;
		if (r && Date.now() - sync.remoteAt < 20000) {
			var pos = r.pos + (r.playing ? (Date.now() - sync.remoteAt) / 1000 : 0);
			state.idx = clamp(r.idx, 0, Math.max(0, app.tracks.length - 1));
			state.pos = clamp(pos, 0, r.dur || pos);
			if (validInst(r.inst)) {
				state.inst = r.inst;
			}
			if (typeof r.loop === 'boolean') {
				state.loop = r.loop;
			}
		}
		claim();
	}

	function remotePlaying() {
		return !sync.isOwner && !!(sync.remote && sync.remote.playing &&
			Date.now() - sync.remoteAt < 20000);
	}

	function uiPlaying() {
		return !!state.playing || remotePlaying();
	}

	/** 接手后从对方的位置继续；被浏览器挡住自动播放时交给「继续播放」胶囊 */
	function resumeHere() {
		if (!sync.isOwner || !sync.ready) {
			return;
		}
		var r = sync.remote;
		if (r && Date.now() - sync.remoteAt < 20000) {
			var pos = r.pos + (r.playing ? (Date.now() - sync.remoteAt) / 1000 : 0);
			state.idx = clamp(r.idx, 0, Math.max(0, app.tracks.length - 1));
			state.pos = clamp(pos, 0, r.dur || pos);
			if (validInst(r.inst)) {
				state.inst = r.inst;
			}
			if (typeof r.loop === 'boolean') {
				state.loop = r.loop;
			}
			if (r.playing) {
				wantResume = true;
				tryResume();
				return;
			}
			state.playing = false;
			render();
			return;
		}
		if (wantResume) {
			tryResume();
		} else if (autoBoot) {
			wantResume = true;
			tryResume();
		} else {
			render();
		}
	}

	function onActivate() {
		if (!sync.ready || sync.isOwner) {
			return;
		}
		if (document.visibilityState !== 'visible') {
			return;
		}
		window.clearTimeout(sync.resumeTimer);
		sync.resumeTimer = window.setTimeout(function() {
			if (!sync.ready || sync.isOwner || document.visibilityState !== 'visible') {
				return;
			}
			if (document.hasFocus && !document.hasFocus()) {
				return;
			}
			// 刚点的是站内链接：让它正常跳转，别在这里放半秒声音
			if (Date.now() - sync.linkAt < 800) {
				return;
			}
			claim();
			resumeHere();
		}, 260);
	}

	if (bc) {
		bc.onmessage = function(ev) {
			handleBus(ev.data);
		};
	} else {
		window.addEventListener('storage', function(e) {
			if (e.key !== BUS_KEY || !e.newValue) {
				return;
			}
			var msg = null;
			try {
				msg = JSON.parse(e.newValue);
			} catch (err) {
				return;
			}
			handleBus(msg);
		});
	}

	window.addEventListener('focus', onActivate);
	document.addEventListener('visibilitychange', function() {
		if (!document.hidden) {
			onActivate();
		}
	});
	document.addEventListener('pointerdown', function(e) {
		var t = e.target;
		if (t && t.closest && t.closest('a[href]')) {
			sync.linkAt = Date.now();
		}
	}, true);

	function saveState() {
		// 跟随者窗口不拿自己的旧进度去覆盖正在播放的窗口，而是把对方的位置写进去
		var r = (!sync.isOwner && sync.remote) ? sync.remote : null;
		var out = {
			idx: state.idx,
			pos: state.pos,
			playing: state.playing || wantResume,
			vol: state.vol,
			inst: state.inst,
			loop: state.loop,
			open: state.open,
			closed: state.closed
		};
		if (r) {
			out.idx = r.idx;
			out.pos = r.pos + (r.playing ? (Date.now() - sync.remoteAt) / 1000 : 0);
			out.playing = r.playing;
			if (validInst(r.inst)) {
				out.inst = r.inst;
			}
			if (typeof r.loop === 'boolean') {
				out.loop = r.loop;
			}
		}
		writeStore(out);
	}

	/* ---------------- 音频 ---------------- */

	function ensureCtx() {
		if (app.ctx) {
			return app.ctx;
		}
		var AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) {
			throw new Error('浏览器不支持 WebAudio');
		}
		var ctx = new AC();
		var master = ctx.createGain();
		master.gain.value = state.vol;
		master.connect(ctx.destination);

		// 一点点厅堂感：短噪声当脉冲响应，湿声很小，不会糊
		var send = ctx.createGain();
		send.gain.value = 1;
		var conv = ctx.createConvolver();
		conv.buffer = makeIR(ctx, 1.9, 2.8);
		var wet = ctx.createGain();
		wet.gain.value = 0.15;
		send.connect(conv);
		conv.connect(wet);
		wet.connect(master);

		app.ctx = ctx;
		app.master = master;
		app.send = send;
		return ctx;
	}

	function makeIR(ctx, sec, decay) {
		var rate = ctx.sampleRate;
		var len = Math.max(1, Math.floor(rate * sec));
		var buf = ctx.createBuffer(2, len, rate);
		for (var ch = 0; ch < 2; ch++) {
			var d = buf.getChannelData(ch);
			for (var i = 0; i < len; i++) {
				d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
			}
		}
		return buf;
	}

	function applyVolume() {
		if (!app.master || !app.ctx) {
			return;
		}
		var t = app.ctx.currentTime;
		try {
			app.master.gain.cancelScheduledValues(t);
			app.master.gain.setTargetAtTime(state.vol, t, 0.03);
		} catch (e) {
			app.master.gain.value = state.vol;
		}
	}

	/* ---------------- 音色（SoundFont） ---------------- */

	var NAME_RE = /^([A-G])([#b]?)(-?\d+)$/;
	var SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

	function noteToMidi(name) {
		var m = NAME_RE.exec(name);
		if (!m) {
			return -1;
		}
		var n = SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
		return (parseInt(m[3], 10) + 1) * 12 + n;
	}

	function b64ToBuffer(dataUri) {
		var comma = dataUri.indexOf(',');
		var b64 = comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
		var bin = window.atob(b64);
		var len = bin.length;
		var bytes = new Uint8Array(len);
		for (var i = 0; i < len; i++) {
			bytes[i] = bin.charCodeAt(i);
		}
		return bytes.buffer;
	}

	function decodeAudio(ctx, buf) {
		return new Promise(function(resolve, reject) {
			var p = ctx.decodeAudioData(buf, resolve, reject);
			if (p && p.then) {
				p.then(resolve, reject);
			}
		});
	}

	function xhrGet(url, type, onProgress) {
		return new Promise(function(resolve, reject) {
			var xhr = new XMLHttpRequest();
			xhr.open('GET', url, true);
			try {
				xhr.responseType = type;
			} catch (e) { /* 老浏览器 */ }
			if (onProgress && 'onprogress' in xhr) {
				xhr.onprogress = function(e) {
					if (e && e.lengthComputable && e.total) {
						onProgress(e.loaded / e.total);
					}
				};
			}
			xhr.onload = function() {
				if (xhr.status >= 200 && xhr.status < 400) {
					resolve(xhr.response);
				} else {
					reject(new Error('HTTP ' + xhr.status));
				}
			};
			xhr.onerror = function() {
				reject(new Error('网络错误'));
			};
			xhr.send();
		});
	}

	function getInstrument(name, onProgress) {
		if (app.insts[name]) {
			return Promise.resolve(app.insts[name]);
		}
		if (app.loading[name]) {
			return app.loading[name];
		}
		var url = BASE + 'sf/' + name + '.json?v=' + encodeURIComponent(ASSETV);
		var p = xhrGet(url, 'text', function(r) {
			onProgress && onProgress(r * 0.85);
		}).then(function(text) {
			var raw = typeof text === 'string' ? JSON.parse(text) : text;
			var inst = { name: name, urls: {}, decoded: {} };
			for (var k in raw) {
				if (!Object.prototype.hasOwnProperty.call(raw, k)) {
					continue;
				}
				var midi = noteToMidi(k);
				if (midi > 0) {
					inst.urls[midi] = raw[k];
				}
			}
			app.insts[name] = inst;
			delete app.loading[name];
			onProgress && onProgress(1);
			return inst;
		}, function(err) {
			delete app.loading[name];
			throw err;
		});
		app.loading[name] = p;
		return p;
	}

	/** 只解码当前曲子用得到的琴键，省内存。 */
	function prepare(inst, midis, cb) {
		var todo = [];
		for (var i = 0; i < midis.length; i++) {
			var m = midis[i];
			if (!inst.decoded[m] && inst.urls[m] && todo.indexOf(m) < 0) {
				todo.push(m);
			}
		}
		var total = todo.length;
		var done = 0;
		if (!total) {
			cb && cb(0, 0);
			return Promise.resolve(inst);
		}
		return new Promise(function(resolve) {
			var active = 0;
			var waiting = [];
			function finishOne() {
				done++;
				cb && cb(done, total);
				if (done >= total) {
					while (waiting.length) {
						waiting.shift()();
					}
					resolve(inst);
				}
			}
			function pump() {
				while (active < 4 && todo.length) {
					(function(midi) {
						active++;
						var buf;
						try {
							buf = b64ToBuffer(inst.urls[midi]);
						} catch (e) {
							buf = null;
						}
						if (!buf) {
							active--;
							finishOne();
							pump();
							return;
						}
						decodeAudio(app.ctx, buf).then(function(audio) {
							inst.decoded[midi] = audio;
						}, function() {
							/* 这个琴键坏了就跳过，用邻近音高代替 */
						}).then(function() {
							active--;
							finishOne();
							pump();
						});
					})(todo.shift());
				}
			}
			pump();
		});
	}

	function pickBuffer(inst, midi) {
		var direct = inst.decoded[midi];
		if (direct) {
			return { buf: direct, rate: 1 };
		}
		var best = 0;
		var bd = 1e9;
		for (var k in inst.decoded) {
			if (!Object.prototype.hasOwnProperty.call(inst.decoded, k)) {
				continue;
			}
			var d = Math.abs(parseInt(k, 10) - midi);
			if (d < bd) {
				bd = d;
				best = parseInt(k, 10);
			}
		}
		if (!best) {
			return null;
		}
		return { buf: inst.decoded[best], rate: Math.pow(2, (midi - best) / 12) };
	}

	/* ---------------- MIDI 解析 ---------------- */

	function lowerBound(notes, t) {
		var lo = 0;
		var hi = notes.length;
		while (lo < hi) {
			var mid = (lo + hi) >> 1;
			if (notes[mid].time < t) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return lo;
	}

	function pedalSegments(pedal) {
		pedal.sort(function(a, b) { return a.time - b.time; });
		var segs = [];
		var downAt = -1;
		for (var i = 0; i < pedal.length; i++) {
			var p = pedal[i];
			if (p.value >= 0.5) {
				if (downAt < 0) {
					downAt = p.time;
				}
			} else if (downAt >= 0) {
				segs.push([downAt, p.time]);
				downAt = -1;
			}
		}
		if (downAt >= 0) {
			segs.push([downAt, 1e9]);
		}
		return segs;
	}

	function segmentAt(segs, t) {
		var lo = 0;
		var hi = segs.length - 1;
		while (lo <= hi) {
			var mid = (lo + hi) >> 1;
			if (t < segs[mid][0]) {
				hi = mid - 1;
			} else if (t > segs[mid][1]) {
				lo = mid + 1;
			} else {
				return segs[mid];
			}
		}
		return null;
	}

	/** 以时长为权的中位音高，用来判断哪一轨更像旋律 */
	function weightedPitch(notes, pct) {
		var arr = [];
		for (var i = 0; i < notes.length; i++) {
			arr.push({ v: notes[i].midi, w: Math.max(0.05, notes[i].raw || notes[i].duration) });
		}
		arr.sort(function(a, b) { return a.v - b.v; });
		var total = 0;
		for (var j = 0; j < arr.length; j++) {
			total += arr[j].w;
		}
		var acc = 0;
		for (var k = 0; k < arr.length; k++) {
			acc += arr[k].w;
			if (acc >= total * pct) {
				return arr[k].v;
			}
		}
		return arr[arr.length - 1].v;
	}

	/**
	 * 合奏分声部：
	 *  - 多轨且音域分得开（中位音高差 ≥ 5）：最高那一轨当小提琴，其余钢琴（照原曲声部）；
	 *  - 单轨或分不开：原谱全部留给钢琴，另外按和声生成小提琴双音伴奏（buildViolinAccompaniment）。
	 */
	function assignParts(notes, trackMeta) {
		var i;
		if (trackMeta && trackMeta.length >= 2) {
			var sorted = trackMeta.slice().sort(function(a, b) { return b.median - a.median; });
			if (sorted[0].count >= 20 && sorted[0].median - sorted[1].median >= 5) {
				var vid = sorted[0].idx;
				var vcount = 0;
				for (i = 0; i < notes.length; i++) {
					notes[i].part = notes[i].trk === vid ? 'v' : 'p';
					if (notes[i].part === 'v') {
						vcount++;
					}
				}
				if (vcount >= notes.length * 0.08 && vcount <= notes.length * 0.7) {
					return 'tracks';
				}
			}
		}
		for (i = 0; i < notes.length; i++) {
			notes[i].part = 'p';
		}
		return 'single';
	}

	/** 多轨曲的小提琴旋律常有声部叠置：按同一时刻叠了几个音做衰减，避免和弦处突然变响 */
	function markViolinPolyphony(notes) {
		var vs = [];
		for (var i = 0; i < notes.length; i++) {
			if (notes[i].part === 'v' && !notes[i].gen) {
				vs.push(notes[i]);
			}
		}
		for (var a = 0; a < vs.length; a++) {
			var n = vs[a];
			var c = 0;
			for (var b = 0; b < vs.length; b++) {
				var o = vs[b];
				if (o.time <= n.time + 0.02 && o.time + Math.max(0.08, o.raw || o.duration) > n.time + 0.02) {
					c++;
				}
			}
			n.vp = Math.max(1, c);
		}
	}

	var MAJOR_TRIAD = [0, 4, 7];
	var MINOR_TRIAD = [0, 3, 7];

	function pcOf(m) {
		return ((m % 12) + 12) % 12;
	}

	/**
	 * 单小节和声判断：12 个根音 × 大/小三和弦里挑重合度最高的。
	 * 低音在和弦里加一点分；和上一小节相同也加一点分（和声延续）。
	 */
	function detectBarChord(w, total, lowest, prevRoot, prevQual) {
		var bass = pcOf(lowest);
		var bestRoot = -1;
		var bestQual = 0;
		var bestScore = -9;
		for (var root = 0; root < 12; root++) {
			for (var q = 0; q < 2; q++) {
				var tones = q ? MINOR_TRIAD : MAJOR_TRIAD;
				var inW = w[root] + w[(root + tones[1]) % 12] + w[(root + tones[2]) % 12];
				var score = inW / total - 0.5 * (total - inW) / total;
				if (bass === root || bass === (root + tones[1]) % 12 || bass === (root + tones[2]) % 12) {
					score += 0.06;
				}
				if (prevRoot === root && prevQual === q) {
					score += 0.08;
				}
				if (score > bestScore) {
					bestScore = score;
					bestRoot = root;
					bestQual = q;
				}
			}
		}
		if (bestRoot < 0 || bestScore < 0.1) {
			return null;
		}
		return { root: bestRoot, qual: bestQual, score: bestScore };
	}

	function sameChord(a, b) {
		return !!a && !!b && a.root === b.root && a.qual === b.qual;
	}

	function sharedTones(a, b) {
		var ta = a.qual ? MINOR_TRIAD : MAJOR_TRIAD;
		var tb = b.qual ? MINOR_TRIAD : MAJOR_TRIAD;
		var c = 0;
		for (var i = 1; i < 3; i++) {
			for (var j = 1; j < 3; j++) {
				if ((a.root + ta[i]) % 12 === (b.root + tb[j]) % 12) {
					c++;
				}
			}
		}
		return c;
	}

	/** 候选音跟同一段里响着的钢琴音有多少半音冲突（1/11 度） */
	function clashScore(midi, segNotes) {
		var c = 0;
		for (var i = 0; i < segNotes.length; i++) {
			var d = Math.abs(midi - segNotes[i].midi) % 12;
			if (d === 1 || d === 11) {
				c += 3;
			} else if (d === 6) {
				c += 0.5;
			}
		}
		return c;
	}

	/** 挑两个和弦音：低音在 50–64，高音在 58–72；尽量贴着上一段走（声部连接），避开半音冲突 */
	function chooseVoicing(chord, prev, topMidi, segNotes) {
		var tones = chord.qual ? MINOR_TRIAD : MAJOR_TRIAD;
		var pcs = [chord.root, (chord.root + tones[1]) % 12, (chord.root + tones[2]) % 12];
		var cands = [];
		for (var i = 0; i < pcs.length; i++) {
			for (var oct = 3; oct <= 5; oct++) {
				var m = pcs[i] + 12 * (oct + 1);
				if (m >= 48 && m <= 74) {
					cands.push(m);
				}
			}
		}
		var best = null;
		var bestScore = -99;
		for (var a = 0; a < cands.length; a++) {
			var lo = cands[a];
			if (lo < 54 || lo > 66) {
				continue;
			}
			for (var b = 0; b < cands.length; b++) {
				var hi = cands[b];
				if (hi < 62 || hi > 76 || hi <= lo + 2 || hi >= topMidi - 1) {
					continue;
				}
				var gap = hi - lo;
				if (gap < 3 || gap > 12 || gap === 5 || gap === 6) {
					continue;
				}
				if (pcOf(lo) === pcOf(hi)) {
					continue;
				}
				var clash = clashScore(lo, segNotes) + clashScore(hi, segNotes);
				if (clash > 0) {
					continue;
				}
				var move = prev ? Math.abs(lo - prev[0]) + Math.abs(hi - prev[1]) : 0;
				var score = -move * 0.35 - Math.abs((lo + hi) / 2 - 61) * 0.1;
				if (gap === 3 || gap === 4) {
					score += 1.2;
				} else if (gap === 8 || gap === 9) {
					score += 0.9;
				} else if (gap === 7) {
					score += 0.4;
				}
				if (score > bestScore) {
					bestScore = score;
					best = [lo, hi];
				}
			}
		}
		if (best) {
			return best;
		}
		// 双音没有完全干净的，退成单音（仍要避开半音）
		var single = null;
		var singleScore = -99;
		for (var s = 0; s < cands.length; s++) {
			var m2 = cands[s];
			if (m2 < 54 || m2 > 68 || m2 >= topMidi - 2) {
				continue;
			}
			var cl = clashScore(m2, segNotes);
			if (cl > 0) {
				continue;
			}
			var sc = -Math.abs(m2 - 58) * 0.1;
			if (sc > singleScore) {
				singleScore = sc;
				single = [m2];
			}
		}
		return single;
	}

	/** 长和弦里让上声部走到附近另一个和弦音，避免一直一个双音 */
	function nextUpper(chord, curUpper, lower, topMidi, segNotes) {
		var tones = chord.qual ? MINOR_TRIAD : MAJOR_TRIAD;
		var pcs = [chord.root, (chord.root + tones[1]) % 12, (chord.root + tones[2]) % 12];
		var best = null;
		var bestScore = -99;
		for (var i = 0; i < pcs.length; i++) {
			for (var oct = 3; oct <= 5; oct++) {
				var m = pcs[i] + 12 * (oct + 1);
				if (m < 62 || m > 76 || m >= topMidi - 1) {
					continue;
				}
				var gap = m - lower;
				if (gap < 3 || gap > 12 || gap === 5 || gap === 6) {
					continue;
				}
				var move = Math.abs(m - curUpper);
				if (move < 1 || move > 5) {
					continue;
				}
				if (clashScore(m, segNotes) > 0) {
					continue;
				}
				var score = -move * 0.4;
				if (gap === 3 || gap === 4) {
					score += 0.8;
				} else if (gap === 8 || gap === 9) {
					score += 0.6;
				}
				if (score > bestScore) {
					bestScore = score;
					best = m;
				}
			}
		}
		return best;
	}

	/**
	 * 单轨钢琴曲的小提琴伴奏（抒情慢歌用的写法）：
	 *  1. 和声：每小节判一次和弦；钢琴停下来的小节沿用上一个和弦（和声不中断）。
	 *  2. 织体：同和弦合并成一段，一段只起一次弓——低音长音铺底，高音在长段里缓慢走到邻近和弦音。
	 *  3. 声部连接：新和弦的配音尽量贴近上一段（共同音保持、其他音级进），不跳来跳去。
	 *  4. 音区：小提琴放在旋律下方；力度压到 0.22/0.19，不抢钢琴。
	 *  5. 冲突：每个音都避开与同时响的钢琴音的半音/三全音；找不到干净音就退成单音或不拉。
	 */
	function buildViolinAccompaniment(notes, duration, bpm, beats) {
		var bar = clamp((60 / (bpm || 100)) * (beats || 4), 1.0, 5.5);
		var bars = [];
		for (var t0 = 0; t0 < duration - 0.4; t0 += bar) {
			var t1 = Math.min(duration, t0 + bar);
			var w = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
			var total = 0;
			var lowest = 127;
			var barNotes = [];
			for (var i = 0; i < notes.length; i++) {
				var n = notes[i];
				if (n.gen) {
					continue;
				}
				var end = n.time + Math.max(0.08, n.raw || n.duration);
				if (n.time >= t1 - 0.04 || end <= t0 + 0.04) {
					continue;
				}
				var ov = Math.min(t1, end) - Math.max(t0, n.time);
				if (ov <= 0) {
					continue;
				}
				w[pcOf(n.midi)] += ov;
				total += ov;
				if (n.midi < lowest) {
					lowest = n.midi;
				}
				barNotes.push(n);
			}
			var chord = null;
			if (total >= 0.2 && barNotes.length >= 2) {
				chord = detectBarChord(w, total, lowest, -1, -1);
			}
			bars.push({ t0: t0, t1: t1, chord: chord, notes: barNotes });
		}

		// 和声延续 + 平滑：相邻和弦共同音多、分数差不多时不要来回改
		var segs = [];
		var cur = null;
		var prevChord = null;
		var prevScore = -9;
		for (var b = 0; b < bars.length; b++) {
			var bar2 = bars[b];
			var ch = bar2.chord;
			if (ch && prevChord && !sameChord(ch, prevChord) && sharedTones(ch, prevChord) >= 2 &&
				ch.score - prevScore < 0.06) {
				ch = prevChord;
			}
			if (!ch && prevChord) {
				ch = prevChord;
			}
			if (!ch) {
				cur = null;
				continue;
			}
			if (bar2.chord) {
				prevScore = bar2.chord.score;
			}
			prevChord = ch;
			if (cur && sameChord(cur.chord, ch)) {
				cur.t1 = bar2.t1;
				for (var c = 0; c < bar2.notes.length; c++) {
					cur.notes.push(bar2.notes[c]);
				}
			} else {
				cur = { chord: ch, t0: bar2.t0, t1: bar2.t1, notes: bar2.notes.slice() };
				segs.push(cur);
			}
		}

		var out = [];
		var prevVoice = null;
		var origNotes = [];
		for (var oi = 0; oi < notes.length; oi++) {
			if (!notes[oi].gen) {
				origNotes.push(notes[oi]);
			}
		}
		var clashAt = function(midi, t, len) {
			for (var o = 0; o < origNotes.length; o++) {
				var on = origNotes[o];
				var oe = on.time + Math.max(0.08, on.raw || on.duration);
				if (on.time < t + len - 0.02 && oe > t + 0.02) {
					var d = Math.abs(midi - on.midi) % 12;
					if (d === 1 || d === 11) {
						return true;
					}
				}
			}
			return false;
		};
		var pushViolin = function(midi, t, len, vel) {
			if (clashAt(midi, t, len)) {
				if (midi + 12 <= 84 && !clashAt(midi + 12, t, len)) {
					midi += 12;
				} else if (midi - 12 >= 45 && !clashAt(midi - 12, t, len)) {
					midi -= 12;
				} else {
					return;
				}
			}
			out.push({
				midi: midi, time: t, duration: len, raw: len,
				velocity: vel, part: 'v', gen: true, trk: -1, prog: 40
			});
		};
		for (var s = 0; s < segs.length; s++) {
			var seg = segs[s];
			var segLen = seg.t1 - seg.t0;
			if (segLen < 0.4 || !seg.notes.length) {
				continue;
			}
			var topMidi = 0;
			for (var k = 0; k < seg.notes.length; k++) {
				if (seg.notes[k].midi > topMidi) {
					topMidi = seg.notes[k].midi;
				}
			}
			var voice = chooseVoicing(seg.chord, prevVoice, topMidi, seg.notes);
			if (!voice) {
				continue;
			}
			var lower = voice[0];
			var upper = voice.length > 1 ? voice[1] : voice[0];
			var start = seg.t0 + 0.04;
			var endT = seg.t1 - 0.02;
			// 低音：长音铺底，按 2.8 秒切段（采样 3.13 秒，太长会没声）
			for (var lt = start; lt < endT - 0.1; lt += 2.8) {
				var ll = Math.min(2.8, endT - lt);
				if (ll < 0.5) {
					break;
				}
				pushViolin(lower, lt, ll, 0.32);
			}
			// 高音：每 3 秒走到邻近的和弦音，形成一条缓慢的内声部，避免一个双音拖到底
			for (var ut = start; ut < endT - 0.1; ut += 3.0) {
				var ul = Math.min(3.0, endT - ut);
				if (ul < 0.5) {
					break;
				}
				pushViolin(upper, ut, ul, 0.28);
				var nu = nextUpper(seg.chord, upper, lower, topMidi, seg.notes);
				if (nu) {
					upper = nu;
				}
			}
			prevVoice = [lower, upper];
		}
		return out;
	}

	function parseSong(buf, ensVol, dVol) {
		var MidiCtor = window.Midi && (window.Midi.Midi || window.Midi);
		if (!MidiCtor) {
			throw new Error('MIDI 解析库缺失');
		}
		var midi = new MidiCtor(buf);
		var rawNotes = [];
		var pedal = [];
		var trackMeta = [];
		var tracks = midi.tracks || [];
		var drumNotes = [];
		for (var i = 0; i < tracks.length; i++) {
			var tr = tracks[i];
			if (tr.channel === 9) {
				// 打击乐轨：保留成 part 'd'，只有「架子鼓+钢琴」模式发声，其他模式照旧忽略
				var dns = tr.notes || [];
				for (var dj = 0; dj < dns.length; dj++) {
					var dn = dns[dj];
					if (dn.midi < 27 || dn.midi > 87) {
						continue; // 鼓组采样只覆盖 27–87
					}
					drumNotes.push({
						midi: dn.midi, time: dn.time, duration: Math.max(0.05, dn.duration),
						raw: dn.duration, velocity: dn.velocity,
						trk: -2, prog: -1, part: 'd'
					});
				}
				continue;
			}
			var ns = tr.notes || [];
			var tmp = [];
			for (var j = 0; j < ns.length; j++) {
				var n = ns[j];
				if (n.midi < 12 || n.midi > 120) {
					continue;
				}
				var note = {
					midi: n.midi, time: n.time, duration: n.duration,
					raw: n.duration, velocity: n.velocity,
					trk: i, prog: tr.instrument ? tr.instrument.number : -1
				};
				rawNotes.push(note);
				tmp.push(note);
			}
			if (tmp.length) {
				// 这一轨按「时长为权」的中位音高
				tmp.sort(function(a, b) { return a.midi - b.midi; });
				var totalW = 0;
				for (var q = 0; q < tmp.length; q++) {
					totalW += Math.max(0.05, tmp[q].raw);
				}
				var acc = 0;
				var median = tmp[tmp.length - 1].midi;
				for (var q2 = 0; q2 < tmp.length; q2++) {
					acc += Math.max(0.05, tmp[q2].raw);
					if (acc >= totalW / 2) {
						median = tmp[q2].midi;
						break;
					}
				}
				trackMeta.push({ idx: i, count: tmp.length, median: median });
			}
			var cc = (tr.controlChanges && tr.controlChanges[64]) || [];
			for (var k = 0; k < cc.length; k++) {
				pedal.push({ time: cc[k].time, value: cc[k].value });
			}
		}
		rawNotes.sort(function(a, b) {
			return a.time - b.time || a.midi - b.midi;
		});
		if (!rawNotes.length) {
			throw new Error('这首 MIDI 里没有音符');
		}

		// 开头的空白剪掉，点了播放马上出声（鼓若有更早的预备拍，按鼓的起拍算）
		drumNotes.sort(function(a, b) { return a.time - b.time; });
		var lead = rawNotes[0].time;
		if (drumNotes.length && drumNotes[0].time < lead) {
			lead = drumNotes[0].time;
		}
		if (lead > 0.35) {
			for (var a = 0; a < rawNotes.length; a++) {
				rawNotes[a].time -= lead;
			}
			for (var d0 = 0; d0 < drumNotes.length; d0++) {
				drumNotes[d0].time = Math.max(0, drumNotes[d0].time - lead);
			}
			for (var b = 0; b < pedal.length; b++) {
				pedal[b].time -= lead;
			}
		}

		var eVol = typeof ensVol === 'number' ? clamp(ensVol, 0, 1.5) : 1;
		var eDVol = typeof dVol === 'number' ? clamp(dVol, 0, 1.5) : 1;
		var mode = assignParts(rawNotes, trackMeta);

		// 延音踏板：踏板踩着的时候，音符不要提前断掉（小提琴声部演奏时用 raw 长度）
		var segs = pedalSegments(pedal);
		var last = 0;
		for (var c = 0; c < rawNotes.length; c++) {
			var nt = rawNotes[c];
			var end = nt.time + nt.duration;
			if (segs.length) {
				var seg = segmentAt(segs, end);
				if (seg) {
					var target = Math.min(seg[1], nt.time + 8);
					if (target > end) {
						nt.duration = target - nt.time;
						end = target;
					}
				}
			}
			if (end > last) {
				last = end;
			}
		}
		var dur = Math.max(last + 1.2, Math.min(midi.duration || 0, last + 6));

		// 单轨：原谱全部给钢琴，另按和声生成小提琴双音伴奏
		var genCount = 0;
		if (mode === 'single' && eVol > 0) {
			var bpm0 = (midi.header.tempos && midi.header.tempos[0] && midi.header.tempos[0].bpm) || 100;
			var beats0 = (midi.header.timeSignatures && midi.header.timeSignatures[0] &&
				midi.header.timeSignatures[0].timeSignature && midi.header.timeSignatures[0].timeSignature[0]) || 4;
			var extra = buildViolinAccompaniment(rawNotes, dur, bpm0, beats0);
			if (extra.length) {
				for (var g = 0; g < extra.length; g++) {
					rawNotes.push(extra[g]);
				}
				rawNotes.sort(function(a, b) {
					return a.time - b.time || a.midi - b.midi;
				});
				genCount = extra.length;
			}
		}
		if (mode === 'tracks') {
			markViolinPolyphony(rawNotes);
		}

		// 鼓轨最后并入：和声分析、小提琴声部挑选与多声部标记都只看旋律音，鼓音不掺和；
		// .dvol=0 时整轨不入列，等于原来的「鼓轨忽略」
		if (drumNotes.length && eDVol > 0) {
			var dLast = 0;
			for (var e = 0; e < drumNotes.length; e++) {
				rawNotes.push(drumNotes[e]);
				var dEnd = drumNotes[e].time + drumNotes[e].duration;
				if (dEnd > dLast) {
					dLast = dEnd;
				}
			}
			rawNotes.sort(function(a, b) {
				return a.time - b.time || a.midi - b.midi;
			});
			dur = Math.max(dur, dLast + 1.2);
		}
		return { notes: rawNotes, duration: dur, genNotes: genCount, ensVol: eVol, dVol: eDVol, drumNotes: drumNotes.length };
	}

	/** 手排小提琴声部：midi/xxx.violin（JSON：{"notes":[[时间,时值,音高,力度],...]}），有就替换自动伴奏 */
	function applyViolinPart(song, text) {
		var data;
		try {
			data = JSON.parse(text);
		} catch (e) {
			return false;
		}
		var arr = data && data.notes;
		if (!arr || !arr.length) {
			return false;
		}
		var kept = [];
		for (var i = 0; i < song.notes.length; i++) {
			if (!song.notes[i].gen) {
				kept.push(song.notes[i]);
			}
		}
		var added = 0;
		for (var j = 0; j < arr.length; j++) {
			var a = arr[j];
			if (!a || a.length < 3) {
				continue;
			}
			var t = +a[0];
			var d = +a[1];
			var m = Math.round(+a[2]);
			var v = a.length > 3 ? +a[3] : 0.3;
			if (!isFinite(t) || !isFinite(d) || !isFinite(m) || m < 12 || m > 120 || d <= 0.05) {
				continue;
			}
			kept.push({
				midi: m, time: Math.max(0, t), duration: d, raw: d,
				velocity: clamp(v, 0.05, 1), part: 'v', gen: true, trk: -1, prog: 40
			});
			added++;
		}
		if (!added) {
			return false;
		}
		kept.sort(function(a2, b2) {
			return a2.time - b2.time || a2.midi - b2.midi;
		});
		song.notes = kept;
		song.genNotes = added;
		return true;
	}

	function getSong(track) {
		var vmt = typeof track.violin === 'number' ? track.violin : 0;
		var volK = typeof track.vol === 'number' ? track.vol : 1;
		var dvK = typeof track.dvol === 'number' ? track.dvol : 1;
		var key = track.file + ':' + track.mtime + ':' + volK + ':' + dvK + ':' + vmt;
		if (app.songs[key]) {
			return Promise.resolve(app.songs[key]);
		}
		var url = BASE + 'midi/' + encodeURIComponent(track.file) + '?v=' + track.mtime;
		return xhrGet(url, 'arraybuffer').then(function(buf) {
			var song = parseSong(buf, volK, dvK);
			if (!vmt) {
				app.songs[key] = song;
				return song;
			}
			var base = track.file.replace(/\.(mid|midi)$/i, '');
			var vurl = BASE + 'midi/' + encodeURIComponent(base + '.violin.json') + '?v=' + vmt;
			return xhrGet(vurl, 'text').then(function(text) {
				applyViolinPart(song, text);
				app.songs[key] = song;
				return song;
			}, function() {
				app.songs[key] = song;
				return song;
			});
		});
	}

	/* ---------------- 声部（一首曲子） ---------------- */

	/** GM 鼓件分档音量：底鼓／军鼓当家，踩镲吊镲收敛，免得糊成一团 */
	function drumTrim(m) {
		if (m === 35 || m === 36) { return 1; }            // 底鼓
		if (m === 38 || m === 40) { return 0.9; }          // 军鼓
		if (m === 39) { return 0.78; }                     // 拍手
		if (m === 42 || m === 44) { return 0.5; }          // 闭镲／踏镲
		if (m === 46) { return 0.55; }                     // 开镲
		if (m === 49 || m === 55 || m === 52 || m === 57) { return 0.5; }  // 吊镲
		if (m === 51 || m === 53 || m === 59) { return 0.55; }             // 叮镲
		if ((m >= 41 && m <= 43) || m === 45 || m === 47 || m === 48 || m === 50) { return 0.85; } // 嗵鼓
		return 0.68;
	}

	function Voice(insts, ensemble, song, dest, send, drums) {
		var ctx = app.ctx;
		this.ctx = ctx;
		this.insts = insts;
		this.ensemble = !!ensemble;
		this.drums = !!drums;
		this.ensVol = typeof song.ensVol === 'number' ? song.ensVol : 1;
		this.dVol = typeof song.dVol === 'number' ? song.dVol : 1;
		this.song = song;
		this.notes = [];
		for (var ni = 0; ni < song.notes.length; ni++) {
			if (song.notes[ni].gen && !this.ensemble) {
				continue; // 生成的小提琴伴奏只在合奏模式里出现
			}
			if (song.notes[ni].part === 'd' && (!this.drums || !this.dVol)) {
				continue; // 鼓轨只在「架子鼓+钢琴」模式且这首没被 .dvol 关掉时出现
			}
			this.notes.push(song.notes[ni]);
		}
		this.duration = song.duration;
		this.out = ctx.createGain();
		this.out.gain.value = 0;
		this.out.connect(dest);
		// 小提琴单独过一个高通，去掉低频糊音，跟钢琴叠在一起时更容易听出来
		this.violinBus = ctx.createBiquadFilter();
		this.violinBus.type = 'highpass';
		this.violinBus.frequency.value = 180;
		this.violinBus.Q.value = 0.7;
		var pres = ctx.createBiquadFilter();
		pres.type = 'peaking';
		pres.frequency.value = 2600;
		pres.gain.value = 2;
		pres.Q.value = 0.9;
		this.violinBus.connect(pres);
		var comp = ctx.createDynamicsCompressor();
		comp.threshold.value = -18;
		comp.knee.value = 12;
		comp.ratio.value = 4;
		comp.attack.value = 0.004;
		comp.release.value = 0.2;
		pres.connect(comp);
		comp.connect(this.out);
		if (send) {
			this.out.connect(send);
		}
		this.cursor = 0;
		this.songStart = 0;
		this.ctxStart = 0;
		this.state = 'idle';
		this.sources = [];
		this.switched = false;
	}

	Voice.prototype.begin = function(at, when) {
		this.songStart = at;
		this.ctxStart = when;
		this.cursor = lowerBound(this.notes, at);
		this.state = 'playing';
		this.tick();
	};

	Voice.prototype.songTime = function() {
		if (this.state === 'playing') {
			return clamp(this.songStart + (this.ctx.currentTime - this.ctxStart), 0, this.duration);
		}
		return this.songStart;
	};

	Voice.prototype.endAt = function() {
		return this.ctxStart + (this.duration - this.songStart);
	};

	Voice.prototype.tick = function() {
		if (this.state !== 'playing') {
			return;
		}
		var now = this.ctx.currentTime;
		var horizon = now + LOOKAHEAD;
		while (this.cursor < this.notes.length) {
			var n = this.notes[this.cursor];
			var when = this.ctxStart + (n.time - this.songStart);
			if (when > horizon) {
				break;
			}
			this.cursor++;
			if (when < now - 0.06) {
				continue;
			}
			this.playNote(n, when);
		}
		if (!this.switched && this.duration > 2) {
			var pre = Math.max(0.3, FADE) + 0.1;
			if (now >= this.endAt() - pre) {
				this.switched = true;
				app.active === this && onTrackEnd(this);
			}
		}
	};

	Voice.prototype.playNote = function(n, when) {
		var isViolin = this.ensemble && n.part === 'v' && this.insts.v;
		var isDrum = this.drums && n.part === 'd' && this.insts.d;
		var inst = isViolin ? this.insts.v : isDrum ? this.insts.d : this.insts.p;
		var pick = pickBuffer(inst, n.midi);
		if (!pick) {
			return;
		}
		var ctx = this.ctx;
		var src = ctx.createBufferSource();
		src.buffer = pick.buf;
		src.playbackRate.value = pick.rate;
		var g = ctx.createGain();
		var vel = clamp(n.velocity || 0.75, 0.05, 1);
		var peak, len, rel, atk;
		if (isDrum) {
			// 鼓：起音极快，长度用原始时值（封顶 3 秒）让采样自然收尾
			peak = 0.95 * Math.pow(vel, 1.3) * drumTrim(n.midi) * this.dVol;
			len = Math.max(0.09, Math.min(n.raw || n.duration || 0.09, 3));
			rel = 0.28;
			atk = 0.003;
		} else if (isViolin) {
			peak = 0.9 * Math.pow(vel, 1.55) * 0.82 * this.ensVol;
			if (n.vp) {
				peak /= n.vp;
			}
			len = Math.max(0.08, n.raw || n.duration);
			rel = 0.32;
			atk = 0.03;
		} else {
			peak = 0.9 * Math.pow(vel, 1.55);
			len = Math.max(0.08, n.duration);
			rel = 0.22;
			atk = 0.006;
		}
		var end = when + len;
		try {
			g.gain.setValueAtTime(0, when);
			g.gain.linearRampToValueAtTime(peak, when + atk);
			g.gain.setValueAtTime(peak, end);
			g.gain.linearRampToValueAtTime(0.0001, end + rel);
		} catch (e) {
			g.gain.value = peak;
		}
		src.connect(g);
		g.connect(isViolin ? this.violinBus : this.out);
		var self = this;
		src.onended = function() {
			try {
				src.disconnect();
				g.disconnect();
			} catch (e) { /* ignore */ }
			var i = self.sources.indexOf(src);
			if (i >= 0) {
				self.sources.splice(i, 1);
			}
		};
		this.sources.push(src);
		try {
			src.start(when);
			src.stop(end + rel + 0.04);
		} catch (e) { /* ignore */ }
	};

	Voice.prototype.fadeIn = function(sec) {
		var t = this.ctx.currentTime;
		try {
			this.out.gain.cancelScheduledValues(t);
			this.out.gain.setValueAtTime(0, t);
			this.out.gain.linearRampToValueAtTime(1, t + Math.max(0.02, sec));
		} catch (e) {
			this.out.gain.value = 1;
		}
	};

	Voice.prototype.fadeOut = function(sec) {
		var self = this;
		var t = this.ctx.currentTime;
		var dur = Math.max(0.03, sec);
		try {
			this.out.gain.cancelScheduledValues(t);
			this.out.gain.setValueAtTime(this.out.gain.value, t);
			this.out.gain.linearRampToValueAtTime(0, t + dur);
		} catch (e) { /* ignore */ }
		setTimeout(function() { self.stop(); }, dur * 1000 + 80);
	};

	Voice.prototype.stop = function() {
		if (this.state === 'stopped') {
			return;
		}
		this.state = 'stopped';
		var ctx = this.ctx;
		var now = ctx.currentTime;
		try {
			this.out.gain.cancelScheduledValues(now);
			this.out.gain.setValueAtTime(this.out.gain.value, now);
			this.out.gain.linearRampToValueAtTime(0, now + 0.03);
		} catch (e) { /* ignore */ }
		var srcs = this.sources.slice();
		this.sources.length = 0;
		for (var i = 0; i < srcs.length; i++) {
			try {
				srcs[i].stop(now + 0.05);
			} catch (e) { /* ignore */ }
		}
		var out = this.out;
		setTimeout(function() {
			for (var j = 0; j < srcs.length; j++) {
				try {
					srcs[j].disconnect();
				} catch (e) { /* ignore */ }
			}
			try {
				out.disconnect();
			} catch (e) { /* ignore */ }
		}, 140);
	};

	Voice.prototype.pause = function() {
		var at = this.songTime();
		this.stop();
		return at;
	};

	/* ---------------- 播放控制 ---------------- */

	function uniqueMidis(notes) {
		var seen = {};
		var out = [];
		for (var i = 0; i < notes.length; i++) {
			var m = notes[i].midi;
			if (!seen[m]) {
				seen[m] = 1;
				out.push(m);
			}
		}
		out.sort(function(a, b) { return a - b; });
		return out;
	}

	function setStatus(text) {
		app.status = text || '';
		if (app.ui.sub) {
			app.ui.sub.textContent = app.status || subText();
		}
	}

	function setProgress(ratio) {
		app.progress = clamp(ratio || 0, 0, 1);
		if (app.ui.loadfill) {
			app.ui.loadfill.style.width = (app.progress * 100) + '%';
		}
	}

	function subText() {
		if (app.fatal) {
			return app.fatal;
		}
		var t = app.tracks[state.idx];
		if (!t) {
			return app.tracks.length ? '' : '曲库还是空的';
		}
		return t.artist || 'MIDI 钢琴曲';
	}

	function playIndex(idx, opts) {
		opts = opts || {};
		if (!app.tracks.length || !sync.isOwner) {
			return;
		}
		var n = app.tracks.length;
		idx = ((idx % n) + n) % n;
		var track = app.tracks[idx];
		// 这首不支持当前音色（.inst.json 黑名单 / .vol、.dvol=0 的合奏）就回退到默认音色；
		// state.inst 改了之后跟着 startPlayback 里的 postState 广播出去，跟随窗口自然同步
		if (!instAllowed(track, state.inst)) {
			state.inst = fallbackInst(track);
		}
		var token = ++app.token;
		state.idx = idx;
		app.busy = true;
		setProgress(0.02);
		setStatus('正在载入…');
		if (app.ui.play) {
			app.ui.play.innerHTML = svg('pause');
		}
		render();

		var ensV = !!(ENS && state.inst === ENS.id);
		var ensD = !!(ENS2 && state.inst === ENS2.id);
		var want = ensV ? [ENS.piano, ENS.violin] : ensD ? [ENS2.piano, ENS2.drum] : [state.inst];
		var ratios = [0, 0];
		var onProg = function(slot) {
			return function(r) {
				ratios[slot] = r;
				if (token === app.token) {
					var avg = (ratios[0] + (want.length > 1 ? ratios[1] : 1)) / want.length;
					setProgress(avg * 0.6);
					setStatus('正在加载音色 ' + Math.round(avg * 100) + '%');
				}
			};
		};
		Promise.all(want.map(function(name, i) {
			return getInstrument(name, onProg(i));
		})).then(function(loaded) {
			if (token !== app.token) {
				return null;
			}
			setStatus('正在读取曲谱…');
			return getSong(track).then(function(song) {
				if (token !== app.token) {
					return null;
				}
				var pMidis = [], vMidis = [], dMidis = [], seenP = {}, seenV = {}, seenD = {};
				for (var q = 0; q < song.notes.length; q++) {
					var nn = song.notes[q];
					if (nn.gen && !ensV) {
						continue;
					}
					if (nn.part === 'd' && !ensD) {
						continue;
					}
					var isV = ensV && nn.part === 'v';
					var isD = ensD && nn.part === 'd';
					var arr = isV ? vMidis : isD ? dMidis : pMidis;
					var seen = isV ? seenV : isD ? seenD : seenP;
					if (!seen[nn.midi]) {
						seen[nn.midi] = 1;
						arr.push(nn.midi);
					}
				}
				var keyTotal = pMidis.length + (ensV ? vMidis.length : 0) + (ensD ? dMidis.length : 0);
				var keys = [0, 0];
				var onKey = function(slot) {
					return function(done) {
						keys[slot] = done;
						if (token !== app.token) {
							return;
						}
						var d = keys[0] + ((ensV || ensD) ? keys[1] : 0);
						setProgress(0.6 + (keyTotal ? d / keyTotal : 1) * 0.4);
						setStatus(keyTotal > 1 ? '正在准备琴键 ' + d + '/' + keyTotal : '正在准备琴键…');
					};
				};
				var jobs = [prepare(loaded[0], pMidis, onKey(0))];
				if (ensV || ensD) {
					jobs.push(prepare(loaded[1], ensV ? vMidis : dMidis, onKey(1)));
				}
				return Promise.all(jobs).then(function() {
					return {
						insts: { p: loaded[0], v: ensV ? loaded[1] : null, d: ensD ? loaded[1] : null },
						ensemble: ensV,
						drums: ensD,
						song: song
					};
				});
			});
		}).then(function(r) {
			if (!r || token !== app.token) {
				return;
			}
			app.busy = false;
			setProgress(1);
			var at = typeof opts.at === 'number' ? opts.at : 0;
			if (at >= r.song.duration - 0.6) {
				at = 0;
			}
			startPlayback(r.insts, r.ensemble, r.song, idx, clamp(at, 0, r.song.duration), opts.fade, r.drums);
			setTimeout(function() {
				if (token === app.token) {
					setProgress(0);
					setStatus('');
				}
			}, 350);
		}).catch(function(err) {
			if (token !== app.token) {
				return;
			}
			app.busy = false;
			setProgress(0);
			setStatus('载入失败：' + formatError(err));
			state.playing = !!app.active;
			saveState();
			render();
			if (window.console && console.error) {
				console.error('[edpiano]', err);
			}
		});
	}

	function startPlayback(insts, ensemble, song, idx, at, fade, drums) {
		if (!sync.isOwner) {
			return;
		}
		var ctx = ensureCtx();
		if (ctx.state === 'suspended' && ctx.resume) {
			ctx.resume();
		}
		var av = typeof fade === 'number' ? clamp(fade, 0, 2) : FADE;
		var v = new Voice(insts, ensemble, song, app.master, app.send, drums);
		app.cur = idx;
		app.lastDur = song.duration;
		v.begin(at, ctx.currentTime + 0.05);
		v.fadeIn(av);
		var old = app.active;
		app.active = v;
		if (old && old !== v) {
			old.fadeOut(av + 0.05);
		}
		state.playing = true;
		state.pending = false;
		state.pos = at;
		wantResume = true;
		clearGesture();
		saveState();
		render();
		postState();
		startTick();
	}

	function onTrackEnd(voice) {
		if (app.active !== voice) {
			return;
		}
		if (state.loop && app.tracks.length) {
			state.pos = 0;
			playIndex((state.idx + 1) % app.tracks.length, { at: 0, fade: Math.max(0.35, FADE) });
			return;
		}
		state.playing = false;
		state.pos = 0;
		wantResume = false;
		app.active = null;
		voice.stop();
		stopTick();
		saveState();
		render();
		postState();
	}

	function doPause() {
		var v = app.active;
		if (v) {
			state.pos = v.pause();
			app.active = null;
		}
		state.playing = false;
		state.pending = false;
		wantResume = false;
		clearGesture();
		stopTick();
		saveState();
		render();
		postState();
	}

	function doPlay() {
		if (!app.tracks.length) {
			return;
		}
		if (!sync.isOwner) {
			ensureOwner();
		}
		try {
			var ctx = ensureCtx();
			if (ctx.state === 'suspended' && ctx.resume) {
				ctx.resume();
			}
		} catch (e) {
			app.fatal = '这个浏览器不支持 WebAudio，放不了琴声';
			setStatus(app.fatal);
			render();
			return;
		}
		var at = state.pos;
		if (app.lastDur && at >= app.lastDur - 0.6) {
			at = 0;
		}
		playIndex(state.idx, { at: at, fade: 0.25 });
	}

	/** 播放 / 暂停：跟随者窗口里点，会先接管再执行 */
	function onPlayPauseClick() {
		var was = uiPlaying();
		if (!sync.isOwner) {
			ensureOwner();
		}
		if (was) {
			doPause();
		} else {
			doPlay();
		}
	}

	function step(d) {
		if (!app.tracks.length) {
			return;
		}
		if (!sync.isOwner) {
			ensureOwner();
		}
		try {
			ensureCtx();
			if (app.ctx.state === 'suspended') {
				app.ctx.resume();
			}
		} catch (e) { /* ignore */ }
		playIndex((state.idx + d + app.tracks.length) % app.tracks.length, { at: 0, fade: FADE });
	}

	function seekTo(ratio) {
		var was = uiPlaying();
		var dur = currentDuration();
		if (!dur) {
			return;
		}
		if (!sync.isOwner) {
			ensureOwner();
		}
		var pos = clamp(ratio, 0, 1) * dur;
		state.pos = pos;
		if (was || state.playing) {
			playIndex(state.idx, { at: pos, fade: 0.12 });
		} else {
			saveState();
			renderProgress();
			postState();
		}
	}

	function setInstrument(name) {
		var known = INSTS[name] || (ENS && name === ENS.id) || (ENS2 && name === ENS2.id);
		if (!known || name === state.inst) {
			return;
		}
		// 置灰的音色这首放不了（按钮已 disabled，这里再拦一道防止旧缓存/同步状态绕过）
		if (!instAllowed(app.tracks[state.idx], name)) {
			return;
		}
		var was = uiPlaying();
		if (!sync.isOwner) {
			ensureOwner();
		}
		state.inst = name;
		saveState();
		render();
		if (app.active) {
			playIndex(state.idx, { at: app.active.songTime(), fade: Math.max(0.35, FADE) });
		} else if (was) {
			resumeHere();
		} else {
			postState();
		}
	}

	function currentDuration() {
		if (app.active) {
			return app.active.duration;
		}
		if (!sync.isOwner && sync.remote && sync.remote.dur) {
			return sync.remote.dur;
		}
		return app.lastDur || 0;
	}

	function currentPos() {
		if (app.active) {
			return app.active.songTime();
		}
		if (!sync.isOwner && sync.remote && Date.now() - sync.remoteAt < 20000) {
			var r = sync.remote;
			var p = r.pos + (r.playing ? (Date.now() - sync.remoteAt) / 1000 : 0);
			return clamp(p, 0, r.dur || p);
		}
		return state.pos || 0;
	}

	function startTick() {
		if (app.timer) {
			return;
		}
		app.timer = window.setInterval(function() {
			if (app.active) {
				app.active.tick();
			}
			renderProgress();
		}, TICK);
	}

	function stopTick() {
		if (app.timer) {
			window.clearInterval(app.timer);
			app.timer = 0;
		}
	}

	/* ---------------- 自动续播 ---------------- */

	function startSaved() {
		if (wantResume) {
			playIndex(state.idx, { at: state.pos || 0, fade: 0.08 });
		} else if (autoBoot) {
			playIndex(0, { at: 0, fade: 0.3 });
		}
	}

	function clearGesture() {
		var h = app.gestureHandler;
		if(h) {
			document.removeEventListener('pointerdown', h, true);
			document.removeEventListener('keydown', h, true);
			document.removeEventListener('touchstart', h, true);
			app.gestureHandler = null;
		}
		app.gestureBound = false;
	}

	function waitGesture() {
		if (app.gestureBound) {
			return;
		}
		app.gestureBound = true;
		state.pending = true;
		render();
		var handler = function(ev) {
			var t = ev && ev.target;
			// 点链接就让它正常跳转（下一页会再试），别在这里放半秒声音又断掉；
			// 点播放器自己的按钮由它自己的事件处理，避免重复开播。
			if(t && t.closest) {
				if(t.closest('a[href]') || t.closest('#edpiano')) {
					return;
				}
			}
			clearGesture();
			var ctx;
			try {
				ctx = ensureCtx();
			} catch (e) {
				return;
			}
			var go = function() {
				if (ctx.state === 'running') {
					state.pending = false;
					startSaved();
				}
			};
			var p = ctx.resume && ctx.resume();
			if (p && p.then) {
				p.then(go, go);
			} else {
				window.setTimeout(go, 60);
			}
		};
		app.gestureHandler = handler;
		document.addEventListener('pointerdown', handler, true);
		document.addEventListener('keydown', handler, true);
		document.addEventListener('touchstart', handler, true);
	}

	function tryResume() {
		if (!sync.isOwner) {
			return;
		}
		if (!wantResume && !autoBoot) {
			return;
		}
		var ctx;
		try {
			ctx = ensureCtx();
		} catch (e) {
			return;
		}
		var settled = false;
		var done = function() {
			if (settled) {
				return;
			}
			settled = true;
			if (ctx.state === 'running') {
				state.pending = false;
				startSaved();
			} else {
				waitGesture();
			}
		};
		var p = ctx.resume && ctx.resume();
		if (p && p.then) {
			p.then(done, done);
		}
		window.setTimeout(done, 900);
	}

	/* ---------------- 界面 ---------------- */

	function buildUI() {
		var root = document.createElement('div');
		root.id = 'edpiano';
		root.className = 'ep-closed';
		root.innerHTML =
			'<button type="button" class="ep-dock" title="电钢琴" aria-label="打开电钢琴播放器" aria-expanded="false">' +
				svg('note') + '<i class="ep-dot"></i>' +
			'</button>' +
			'<div class="ep-panel ep-hide" role="group" aria-label="电钢琴播放器">' +
				'<div class="ep-load"><i></i></div>' +
				'<div class="ep-hd">' +
					'<div class="ep-logo">' + svg('note') + '<span>电钢琴</span></div>' +
					'<div class="ep-hd-r">' +
						'<div class="ep-inst" role="group" aria-label="音色"></div>' +
						'<button type="button" class="ep-min" aria-label="收起面板" title="收起">' + svg('min') + '</button>' +
					'</div>' +
				'</div>' +
				'<div class="ep-now">' +
					'<div class="ep-name">还没有曲目</div>' +
					'<div class="ep-sub">曲库还是空的</div>' +
				'</div>' +
				'<div class="ep-bar" role="slider" tabindex="0" aria-label="播放进度" aria-valuemin="0" aria-valuemax="100">' +
					'<span class="ep-fill"></span><span class="ep-knob"></span>' +
				'</div>' +
				'<div class="ep-time"><span class="ep-t1">0:00</span><span class="ep-t2">0:00</span></div>' +
				'<div class="ep-ctrl">' +
					'<button type="button" class="ep-btn ep-prev" aria-label="上一首" title="上一首">' + svg('prev') + '</button>' +
					'<button type="button" class="ep-btn ep-play" aria-label="播放" title="播放">' + svg('play') + '</button>' +
					'<button type="button" class="ep-btn ep-next" aria-label="下一首" title="下一首">' + svg('next') + '</button>' +
					'<button type="button" class="ep-btn ep-loop ep-on" aria-label="列表循环" title="列表循环">' + svg('loop') + '</button>' +
					'<div class="ep-vol">' +
						'<button type="button" class="ep-btn ep-mute" aria-label="静音" title="静音">' + svg('vol') + '</button>' +
						'<input class="ep-range" type="range" min="0" max="100" step="1" aria-label="音量" />' +
					'</div>' +
				'</div>' +
				'<div class="ep-list"></div>' +
				'<div class="ep-ft"><span class="ep-hint">换页后自动续播</span><span class="ep-credit"><a href="' + BASE + 'sf/LICENSE.txt" target="_blank" rel="noopener" title="音色来源：FluidR3_GM（CC BY 3.0）">音色 FluidR3</a> · v' + VERSION + '</span></div>' +
			'</div>';

		document.body.appendChild(root);

		app.ui.root = root;
		app.ui.dock = root.querySelector('.ep-dock');
		app.ui.panel = root.querySelector('.ep-panel');
		app.ui.inst = root.querySelector('.ep-inst');
		app.ui.min = root.querySelector('.ep-min');
		app.ui.name = root.querySelector('.ep-name');
		app.ui.sub = root.querySelector('.ep-sub');
		app.ui.bar = root.querySelector('.ep-bar');
		app.ui.fill = root.querySelector('.ep-fill');
		app.ui.knob = root.querySelector('.ep-knob');
		app.ui.t1 = root.querySelector('.ep-t1');
		app.ui.t2 = root.querySelector('.ep-t2');
		app.ui.play = root.querySelector('.ep-play');
		app.ui.prev = root.querySelector('.ep-prev');
		app.ui.next = root.querySelector('.ep-next');
		app.ui.loop = root.querySelector('.ep-loop');
		app.ui.range = root.querySelector('.ep-range');
		app.ui.mute = root.querySelector('.ep-mute');
		app.ui.list = root.querySelector('.ep-list');
		app.ui.loadfill = root.querySelector('.ep-load i');
		app.ui.hint = root.querySelector('.ep-hint');

		// 音色切换（按钮由后台 INSTRUMENTS 配置生成，选中的音色首次点选时才下载）
		var addInst = function(name, label) {
			var b = document.createElement('button');
			b.type = 'button';
			b.setAttribute('data-inst', name);
			b.setAttribute('data-label', label);
			b.setAttribute('title', label);
			b.textContent = label;
			b.addEventListener('click', function() { setInstrument(name); });
			app.ui.inst.appendChild(b);
		};
		for (var key in INSTS) {
			if (!Object.prototype.hasOwnProperty.call(INSTS, key)) {
				continue;
			}
			addInst(key, SHORT_INST[key] || INSTS[key]);
		}
		if (ENS) {
			addInst(ENS.id, ENS.label || '小提琴+钢琴');
		}
		if (ENS2) {
			addInst(ENS2.id, ENS2.label || '架子鼓+钢琴');
		}

		app.ui.dock.addEventListener('click', function() {
			var was = uiPlaying();
			state.open = true;
			saveState();
			render();
			if (!sync.isOwner) {
				ensureOwner();
			}
			if (was) {
				if (!state.playing) {
					resumeHere();
				}
			} else if (!state.playing) {
				doPlay();
			}
		});
		app.ui.min.addEventListener('click', function() {
			state.open = false;
			saveState();
			render();
		});
		app.ui.play.addEventListener('click', onPlayPauseClick);
		app.ui.prev.addEventListener('click', function() { step(-1); });
		app.ui.next.addEventListener('click', function() { step(1); });
		app.ui.loop.addEventListener('click', function() {
			var was = uiPlaying();
			if (!sync.isOwner) {
				ensureOwner();
			}
			state.loop = !state.loop;
			saveState();
			render();
			postState();
			if (was && !state.playing) {
				resumeHere();
			}
		});
		app.ui.range.addEventListener('input', function() {
			state.vol = clamp(parseInt(this.value, 10) / 100, 0, 1);
			if (state.vol > 0) {
				lastVol = state.vol;
			}
			applyVolume();
			saveState();
			updateMute();
		});
		app.ui.mute.addEventListener('click', function() {
			if (state.vol > 0) {
				lastVol = state.vol;
				state.vol = 0;
			} else {
				state.vol = lastVol || 0.32;
			}
			app.ui.range.value = Math.round(state.vol * 100);
			applyVolume();
			saveState();
			updateMute();
		});

		bindSeek();
		render();
	}

	function bindSeek() {
		var bar = app.ui.bar;
		function ratioOf(clientX) {
			var r = bar.getBoundingClientRect();
			return clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
		}
		function paint(r) {
			app.ui.fill.style.width = (r * 100) + '%';
			app.ui.knob.style.left = (r * 100) + '%';
			var dur = currentDuration();
			app.ui.t1.textContent = fmt(r * dur);
		}
		bar.addEventListener('pointerdown', function(e) {
			app.drag = true;
			try {
				bar.setPointerCapture(e.pointerId);
			} catch (err) { /* ignore */ }
			bar.classList.add('ep-drag');
			paint(ratioOf(e.clientX));
		});
		bar.addEventListener('pointermove', function(e) {
			if (app.drag) {
				paint(ratioOf(e.clientX));
			}
		});
		bar.addEventListener('pointerup', function(e) {
			if (!app.drag) {
				return;
			}
			app.drag = false;
			bar.classList.remove('ep-drag');
			seekTo(ratioOf(e.clientX));
		});
		bar.addEventListener('pointercancel', function() {
			app.drag = false;
			bar.classList.remove('ep-drag');
			renderProgress();
		});
		bar.addEventListener('keydown', function(e) {
			var dur = currentDuration();
			if (!dur) {
				return;
			}
			if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
				e.preventDefault();
				seekTo(clamp((currentPos() + (e.key === 'ArrowLeft' ? -5 : 5)) / dur, 0, 1));
			}
		});
	}

	function updateMute() {
		app.ui.mute.innerHTML = state.vol > 0 ? svg('vol') : svg('mute');
		app.ui.mute.setAttribute('aria-label', state.vol > 0 ? '静音' : '取消静音');
	}

	var OTHER_CAT = '未分类';

	function appendTrackItem(box, i) {
		var t = app.tracks[i];
		var b = document.createElement('button');
		b.type = 'button';
		b.className = 'ep-item' + (i === state.idx ? ' ep-cur' : '');
		b.setAttribute('title', t.title + (t.artist ? ' — ' + t.artist : ''));
		var num = document.createElement('span');
		num.className = 'ep-num';
		num.textContent = i + 1;
		var meta = document.createElement('span');
		meta.className = 'ep-meta';
		var name = document.createElement('span');
		name.className = 'ep-t';
		name.textContent = t.title;
		meta.appendChild(name);
		if (t.artist) {
			var a = document.createElement('span');
			a.className = 'ep-a';
			a.textContent = t.artist;
			meta.appendChild(a);
		}
		var eq = document.createElement('span');
		eq.className = 'ep-eq';
		eq.innerHTML = '<i></i><i></i><i></i><i></i>';
		b.appendChild(num);
		b.appendChild(meta);
		b.appendChild(eq);
		b.addEventListener('click', function() {
			if (!sync.isOwner) {
				ensureOwner();
			}
			try {
				ensureCtx();
				if (app.ctx.state === 'suspended') {
					app.ctx.resume();
				}
			} catch (e) { /* ignore */ }
			playIndex(i, { at: 0, fade: FADE });
		});
		box.appendChild(b);
	}

	function renderList() {
		var box = app.ui.list;
		box.innerHTML = '';
		if (!app.tracks.length) {
			var d = document.createElement('div');
			d.className = 'ep-item ep-empty';
			d.textContent = '还没有曲目';
			box.appendChild(d);
			return;
		}
		// 按分类分组：曲目顺序保持接口返回的（文件名自然排序），组按第一次出现排，「未分类」垫底
		var groups = [];
		var byCat = {};
		for (var i = 0; i < app.tracks.length; i++) {
			var cat = app.tracks[i].cat ? String(app.tracks[i].cat).slice(0, 20) : OTHER_CAT;
			if (!byCat[cat]) {
				byCat[cat] = { name: cat, items: [] };
				groups.push(byCat[cat]);
			}
			byCat[cat].items.push(i);
		}
		if (byCat[OTHER_CAT] && groups[groups.length - 1] !== byCat[OTHER_CAT]) {
			groups.splice(groups.indexOf(byCat[OTHER_CAT]), 1);
			groups.push(byCat[OTHER_CAT]);
		}
		for (var g = 0; g < groups.length; g++) {
			(function(gr) {
				var open = !state.closed[gr.name];
				var hasCur = gr.items.indexOf(state.idx) >= 0;
				var head = document.createElement('button');
				head.type = 'button';
				head.className = 'ep-cat' + (open ? ' ep-cat-open' : '') + (hasCur ? ' ep-cat-live' : '');
				head.setAttribute('aria-expanded', open ? 'true' : 'false');
				head.setAttribute('title', (open ? '收起「' : '展开「') + gr.name + '」（' + gr.items.length + ' 首）');
				var chev = document.createElement('span');
				chev.className = 'ep-chev';
				chev.innerHTML = svg('fold');
				var nm = document.createElement('span');
				nm.className = 'ep-cat-n';
				nm.textContent = gr.name;
				var ct = document.createElement('span');
				ct.className = 'ep-cat-c';
				ct.textContent = gr.items.length;
				head.appendChild(chev);
				head.appendChild(nm);
				head.appendChild(ct);
				head.addEventListener('click', function() {
					if (state.closed[gr.name]) {
						delete state.closed[gr.name];
					} else {
						state.closed[gr.name] = 1;
					}
					saveState();
					renderList();
				});
				box.appendChild(head);
				if (!open) {
					return;
				}
				for (var k = 0; k < gr.items.length; k++) {
					appendTrackItem(box, gr.items[k]);
				}
			})(groups[g]);
		}
	}

	/** 只刷新「谁在放 / 按钮 / 底部提示」这类轻量状态，跟随者每秒收到心跳时用 */
	function renderStatus() {
		if (!app.ui.root) {
			return;
		}
		var root = app.ui.root;
		var following = remotePlaying();
		var playingUI = !!state.playing || following;
		root.className = (state.open ? 'ep-open' : 'ep-closed') +
			(state.playing ? ' ep-playing' : '') +
			(following ? ' ep-following' : '') +
			(state.pending ? ' ep-pending' : '');
		app.ui.panel.classList.toggle('ep-hide', !state.open);
		app.ui.dock.setAttribute('aria-expanded', state.open ? 'true' : 'false');
		app.ui.dock.setAttribute('title', state.pending ? '点一下继续播放' : (following ? '另一窗口播放中' : '电钢琴'));
		app.ui.dock.setAttribute('aria-label', state.pending ? '继续播放电钢琴' : '打开电钢琴播放器');
		app.ui.play.innerHTML = playingUI ? svg('pause') : svg('play');
		app.ui.play.setAttribute('aria-label', playingUI ? '暂停' : '播放');
		app.ui.play.setAttribute('title', playingUI ? '暂停' : '播放');
		app.ui.loop.classList.toggle('ep-on', !!state.loop);
		app.ui.range.value = Math.round(state.vol * 100);
		updateMute();
		if (app.ui.hint) {
			app.ui.hint.textContent = (!sync.isOwner && sync.remote)
				? (following ? '另一窗口播放中 · 已同步' : '另一窗口已暂停')
				: '换页后自动续播';
		}
	}

	function render() {
		if (!app.ui.root) {
			return;
		}
		renderStatus();

		var t = app.tracks[state.idx];
		app.ui.name.textContent = t ? t.title : (app.tracks.length ? '' : '还没有曲目');
		var sub = app.status;
		if (!sub && state.pending) {
			sub = '浏览器暂缓了自动播放，点播放键继续';
		}
		app.ui.sub.textContent = sub || subText();

		var insts = app.ui.inst.getElementsByTagName('button');
		for (var i = 0; i < insts.length; i++) {
			var name = insts[i].getAttribute('data-inst');
			insts[i].classList.toggle('ep-on', name === state.inst);
			// 这首不支持的音色置灰（.inst.json 黑名单 / .vol、.dvol=0 的合奏），tooltip 说明原因
			var ok = instAllowed(t, name);
			insts[i].classList.toggle('ep-no', !ok);
			insts[i].disabled = !ok;
			var label = insts[i].getAttribute('data-label') || name;
			insts[i].setAttribute('title', ok ? label : label + '（此曲不支持该音色）');
		}

		renderList();
		renderProgress();
	}

	function renderProgress() {
		if (!app.ui.bar) {
			return;
		}
		var dur = currentDuration();
		var pos = currentPos();
		var r = dur ? clamp(pos / dur, 0, 1) : 0;
		if (!app.drag) {
			app.ui.fill.style.width = (r * 100) + '%';
			app.ui.knob.style.left = (r * 100) + '%';
			app.ui.t1.textContent = fmt(pos);
			app.ui.t2.textContent = fmt(dur);
			app.ui.bar.setAttribute('aria-valuenow', Math.round(r * 100));
		}
	}

	/* ---------------- 启动 ---------------- */

	function fetchTracks() {
		var url = CFG.api + (CFG.api.indexOf('?') >= 0 ? '&' : '?') + 't=' + Math.floor(Date.now() / 60000);
		return xhrGet(url, 'json').then(function(data) {
			if (typeof data === 'string') {
				data = JSON.parse(data);
			}
			var items = data && data.items ? data.items : [];
			app.tracks = items;
			if (state.idx >= items.length) {
				state.idx = 0;
			}
			return items;
		}, function(err) {
			app.fatal = '曲库读取失败：' + formatError(err);
			throw err;
		});
	}

	function boot() {
		buildUI();
		fetchTracks().then(function(items) {
			if (!items.length) {
				app.ui.root.classList.add('ep-hide');
				if (window.console && console.info) {
					console.info('[edpiano] 曲库为空：把 .mid 放到 ' + BASE + 'midi/ 就会出现在播放器里。');
				}
				return;
			}
			app.ui.root.classList.remove('ep-hide');
			render();
			sync.ready = true;

			// 接管者每秒广播一次进度；跟随者让进度条平滑地跟着走
			window.setInterval(function() {
				if (sync.isOwner) {
					postState();
				}
			}, 1000);
			window.setInterval(function() {
				if (!sync.isOwner) {
					renderProgress();
				}
			}, 500);

			// 只有「可见」的窗口才可能出声。先问一下别的窗口：有人正在放/暂停着就做跟随者；
			// 没有别的窗口，或者这个窗口本来就有焦点（刚点的链接/刷新），就自己接管。
			if (document.visibilityState === 'visible') {
				post({ type: 'ping' });
				window.setTimeout(function() {
					if (!sync.ready || sync.isOwner) {
						return;
					}
					var focused = !document.hasFocus || document.hasFocus();
					var seen = sync.remote && Date.now() - sync.remoteAt < 4000;
					if (!focused && seen) {
						state.playing = false;
						render();
						return;
					}
					claim();
					resumeHere();
				}, 350);
			} else {
				state.playing = false;
				render();
			}
		}).catch(function(err) {
			app.ui.root.classList.add('ep-hide');
			if (window.console && console.error) {
				console.error('[edpiano]', err);
			}
		});

		window.addEventListener('pagehide', function() {
			if (sync.isOwner) {
				var s = snapshot();
				if (app.active) {
					state.pos = app.active.songTime();
					state.playing = true;
					wantResume = true;
				}
				s.type = 'hand';
				s.claimAt = sync.claimAt;
				post(s);
				sync.isOwner = false;
				sync.owner = null;
			}
			saveState();
		});
		window.addEventListener('pageshow', function(e) {
			if (e.persisted && document.visibilityState === 'visible') {
				onActivate();
			}
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}
})();
