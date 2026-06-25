// ============================================================
// helper.js  - 安全計算・ユーティリティ関数
// ============================================================

// --- 数値安全処理 ---
function safeNum(v, fallback) {
  if (fallback === undefined) fallback = 0;
  var n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeFmt(v, d, fallback) {
  if (d === undefined) d = 2;
  if (fallback === undefined) fallback = '--';
  var n = Number(v);
  return Number.isFinite(n) ? n.toFixed(d) : fallback;
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// --- SVG座標安全チェック ---
function isSafeCoord(v) {
  return Number.isFinite(v);
}

function isSafePoint(x, y) {
  return Number.isFinite(x) && Number.isFinite(y);
}

function isSafeLine(x1, y1, x2, y2) {
  return Number.isFinite(x1) && Number.isFinite(y1)
      && Number.isFinite(x2) && Number.isFinite(y2);
}

function isSafeRect(x, y, w, h) {
  return Number.isFinite(x) && Number.isFinite(y)
      && Number.isFinite(w) && Number.isFinite(h)
      && w >= 0 && h >= 0;
}

// --- SVG viewBox自動計算 ---
// 全要素（m単位）から最適なviewBoxを返す
// 返り値: "x0 y0 w h" 文字列
function autoFitViewBox(params) {
  var tipX_m    = params.tipX_m    || 0;
  var tipY_m    = params.tipY_m    || 0;
  var outr      = params.outrigger || 6;
  var bH        = params.buildingH || 0;
  var bDist     = params.buildingDist || 0;
  var hasBld    = params.hasBld || false;
  var margin    = params.margin || SVG_MARGIN_RATIO;

  var minX = Math.min(-outr / 2 - 1, -3);
  var maxX = Math.max(
    tipX_m + (hasBld ? bDist + SVG_BUILDING_WIDTH + 4 : 0) + 5,
    outr / 2 + 2,
    tipX_m + 4
  );
  var maxY = Math.max(tipY_m + 2, bH + 2, 8);

  var vbW  = maxX - minX;
  var vbH  = maxY + 2;
  var vbX0 = minX - vbW * margin;
  var vbY0 = -(maxY + vbH * margin);
  var vbW2 = vbW * (1 + margin * 2);
  var vbH2 = vbH * (1 + margin * 2);

  return {
    str:  vbX0.toFixed(2) + ' ' + vbY0.toFixed(2) + ' ' + vbW2.toFixed(2) + ' ' + vbH2.toFixed(2),
    x0:   vbX0,
    y0:   vbY0,
    w:    vbW2,
    h:    vbH2,
    maxX: maxX,
    maxY: maxY,
  };
}

// --- クレーン計算 ---
// 既存機種: {r,c}配列 + 線形補間
// SL-850RfⅡ(engineType:"sl850"): UIからは直接getSL850Capacity()を呼ぶ
// tblはダミーとして機種検索時のフォールバックにのみ使用する
function getCapacity(crane, radius) {
  var t = crane.tbl;
  if (!t || t.length === 0) return 0;
  if (radius <= t[0].r) return t[0].c;
  if (radius >= t[t.length - 1].r) return t[t.length - 1].c;
  for (var i = 0; i < t.length - 1; i++) {
    if (radius >= t[i].r && radius <= t[i+1].r) {
      var k = (radius - t[i].r) / (t[i+1].r - t[i].r);
      return t[i].c + k * (t[i+1].c - t[i].c);
    }
  }
  return 0;
}

// ============================================================
// SL-850RfⅡ専用: SL850Engineを使った定格取得
//
// sl850State: {
//   outrigger_mm   : 7600|7200|6500|5400|4300|2550
//   counterweight  : true|false
//   boomMode       : "normal"|"special"
//   boom_length_m  : number
//   radius_m       : number (boom作業時)
//   jibLen         : 13.8|18.0|null
//   jib_offset_deg : 5|25|45|60
//   boom_angle_deg : number
// }
// 戻り値: { capacity_t, used_radius_m, trace, reason }
// ============================================================
// craneRawData: { boom_raw, jib_raw } を渡すとそのデータを使用。
// 省略(undefined/null)時はSL850_DATAフォールバック。
function getSL850Capacity(sl850State, craneRawData) {
  if (typeof SL850Engine === 'undefined') {
    return { capacity_t: null, used_radius_m: null, trace: [], reason: 'SL850Engine not loaded' };
  }
  var s = sl850State;

  // データソース解決: craneRawData優先 → SL850_DATAフォールバック
  var rawBoomNormal  = (craneRawData && craneRawData.boom_raw)  || (typeof SL850_DATA !== 'undefined' ? SL850_DATA.boom_normal  : null);
  var rawBoomSpecial = (craneRawData && craneRawData.boom_raw)  || (typeof SL850_DATA !== 'undefined' ? SL850_DATA.boom_special : null);
  var rawJib         = (craneRawData && craneRawData.jib_raw)   || (typeof SL850_DATA !== 'undefined' ? SL850_DATA.jib         : null);

  if (!rawBoomNormal) {
    return { capacity_t: null, used_radius_m: null, trace: [], reason: 'boom_normal data not loaded' };
  }

  // ジブ作業
  if (s.jibLen !== null && s.jibLen !== undefined) {
    if (!rawJib) {
      return { capacity_t: null, radius_m: null, trace: [], reason: 'jib data not loaded' };
    }
    return SL850Engine.lookupJib({
      data:           rawJib,
      outrigger_mm:   s.outrigger_mm,
      counterweight:  true,
      base_boom_m:    s.boom_length_m,
      jib_length_m:   s.jibLen,
      jib_offset_deg: s.jib_offset_deg,
      boom_angle_deg: s.boom_angle_deg,
    });
  }

  // ブーム作業
  var boomData = (s.boomMode === 'special')
    ? (rawBoomSpecial || rawBoomNormal)
    : rawBoomNormal;

  return SL850Engine.lookupBoom({
    data:          boomData,
    outrigger_mm:  s.outrigger_mm,
    counterweight: s.counterweight,
    boom_length_m: s.boom_length_m,
    radius_m:      s.radius_m,
  });
}
// ============================================================
// getVisibleHooks — hookシステム唯一の公開API
//
// データフロー:
//   meta.json.hook_catalog
//     → resolveCrane → selected.hooks (配列そのまま格納)
//     → getVisibleHooks(selected, isJibMode, boomLen)
//     → visibleHooks (UI表示・selectedHook解決に使用)
//
// 自動選択・推奨・fallback は一切行わない
// ============================================================
function getVisibleHooks(selected, isJibMode, boomLen) {
  var hooks = (selected && Array.isArray(selected.hooks)) ? selected.hooks : [];
  var mode  = isJibMode ? 'jib' : 'main';
  var bl    = safeNum(boomLen, 0);
  // モード（main/jib）で使えるフック
  var byMode = hooks.filter(function(h) {
    var usableList = Array.isArray(h.usableFor) ? h.usableFor : [h.usableFor || 'both'];
    return isJibMode
      ? (usableList.includes('jib') || usableList.includes('both'))
      : (usableList.includes('main') || usableList.includes('both'));
  });
  // ブーム長制約(boomMax)を適用
  var byBoom = byMode.filter(function(h) {
    if (!isJibMode && h.boomMax != null && bl > safeNum(h.boomMax, 9999)) return false;
    return true;
  });
  // boomMax制約で全滅した場合は、モード適合フックを残す（選択肢ゼロを防ぐ）
  return byBoom.length > 0 ? byBoom : byMode;
}

function getMinR(crane, boomLen) {
  if (!crane.minR) return 0;
  return crane.minR[boomLen] || 0;
}

function bestBoomIdx(crane, r) {
  if (!crane.boomSteps) return 0;
  for (var i = 0; i < crane.boomSteps.length; i++) {
    var b = crane.boomSteps[i];
    var mR = getMinR(crane, b);
    if (b >= r && mR <= r) return i;
  }
  return crane.boomSteps.length - 1;
}

function radiusToBoomAngle(boomLen, radius) {
  if (!boomLen || !radius || radius > boomLen) return null;
  return Math.acos(radius / boomLen) / DEG_TO_RAD;
}

function boomAngleToRadius(boomLen, angleDeg) {
  return boomLen * Math.cos(angleDeg * DEG_TO_RAD);
}

function calcHeight(boomLen, angleDeg) {
  return boomLen * Math.sin(angleDeg * DEG_TO_RAD) + SVG_BASE_HEIGHT;
}

// ============================================================
// ジブ定格検索（v11追加）
// ============================================================

// ジブ定格テーブルから半径に対する定格を線形補間で返す
// crane   : クレーンオブジェクト（jibData必須）
// jibLen  : ジブ長（m）
// jibAngle: オフセット角（°）
// radius  : 作業半径（m）
// boomLen : メインブーム長（m） ← validBoomLensに最近傍のものを使用
// 戻り値  : 定格（t）, 0=範囲外
function getJibCapacity(crane, jibLen, jibAngle, radius, boomLen) {
  if (!crane.jibData) return 0;
  var jib = null;
  for (var i = 0; i < crane.jibData.length; i++) {
    if (crane.jibData[i].jibLen === jibLen) { jib = crane.jibData[i]; break; }
  }
  if (!jib) return 0;

  // validBoomLensから最近傍ブーム長を選択
  var bestBl = null, bestDist = Infinity;
  for (var j = 0; j < jib.validBoomLens.length; j++) {
    var d = Math.abs(jib.validBoomLens[j] - boomLen);
    if (d < bestDist) { bestDist = d; bestBl = jib.validBoomLens[j]; }
  }
  if (bestBl === null) return 0;

  var tblBoom = jib.tbl[bestBl];
  if (!tblBoom) return 0;
  var tblAngle = tblBoom[jibAngle];
  if (!tblAngle || tblAngle.length === 0) return 0;

  var t = tblAngle;
  if (radius <= t[0].r) return t[0].c;
  if (radius >= t[t.length-1].r) return t[t.length-1].c;
  for (var k = 0; k < t.length-1; k++) {
    if (radius >= t[k].r && radius <= t[k+1].r) {
      var ratio = (radius - t[k].r) / (t[k+1].r - t[k].r);
      return t[k].c + ratio * (t[k+1].c - t[k].c);
    }
  }
  return 0;
}

// ジブ選択時の有効ブーム長リストを返す
// crane.jibData[n].validBoomLens と crane.boomSteps の積集合
// 近傍マッチ（±0.5m以内）で突合
function getJibValidBoomSteps(crane, jibLen) {
  if (!crane.jibData || !crane.boomSteps) return crane.boomSteps || [];
  var jib = null;
  for (var i = 0; i < crane.jibData.length; i++) {
    if (crane.jibData[i].jibLen === jibLen) { jib = crane.jibData[i]; break; }
  }
  if (!jib) return crane.boomSteps;
  // boomStepsのうちvalidBoomLensに近傍（±1.0m）のものを通す
  return crane.boomSteps.filter(function(b) {
    return jib.validBoomLens.some(function(vb) { return Math.abs(vb - b) < 1.0; });
  });
}

// 指定ジブ長に対応するジブオブジェクトを返す
function getJibObj(crane, jibLen) {
  if (!crane.jibData) return null;
  for (var i = 0; i < crane.jibData.length; i++) {
    if (crane.jibData[i].jibLen === jibLen) return crane.jibData[i];
  }
  return null;
}

// ============================================================
// lookupBoomNormal — outriggers形式のloadchartから定格取得
//
// boom_raw: { outriggers: { "7600": { "true": { "23.5": { radius: { "10.0": 13.3 } } } } } }
// params:   { outrigger_mm, counterweight, boom_length_m, radius_m }
// 戻り値:   定格荷重(t) または null
// ============================================================
function lookupBoomNormal(boom_raw, params) {
  if (!boom_raw || !boom_raw.outriggers) return null;

  var outr_mm = params.outrigger_mm || 7600;
  var cw      = params.counterweight !== false ? 'true' : 'false';
  var boomLen = params.boom_length_m;
  var radius  = params.radius_m;

  // アウトリガキー: exact match
  // rtState.outrigger_m はボタン選択のみで設定され、
  // outrigger_options.m と boom_normal.json キーは1対1対応が前提。
  // 一致しない場合は不整合として null を返す（サイレント誤採用を防ぐ）。
  var outr_key = outr_mm ? String(outr_mm) : null;
  if (!outr_key || !boom_raw.outriggers[outr_key]) {
    console.warn(
      '[lookupBoomNormal] outrigger key not found:', outr_key,
      '  available:', Object.keys(boom_raw.outriggers)
    );
    return null;
  }

  var outr_table = boom_raw.outriggers[outr_key];
  if (!outr_table) return null;

  // CWキー: なければ'true'にフォールバック
  var cw_table = outr_table[cw] || outr_table['true'];
  if (!cw_table) return null;

  // ブーム長キー: 指定値に最近傍のキーを探す（元キー文字列を保持）
  var boom_rawkeys = Object.keys(cw_table);
  var boom_key = null;
  var minDiff  = Infinity;
  for (var j = 0; j < boom_rawkeys.length; j++) {
    var bk = parseFloat(boom_rawkeys[j]);
    if (!isFinite(bk)) continue;
    var diff = Math.abs(bk - boomLen);
    if (diff < minDiff) { minDiff = diff; boom_key = boom_rawkeys[j]; }
  }
  if (!boom_key) return null;

  var boom_entry = cw_table[boom_key];
  if (!boom_entry || !boom_entry.radius) return null;

  // 半径テーブルから線形補間
  var r_pairs = Object.keys(boom_entry.radius)
    .map(function(k){ return { r: parseFloat(k), c: boom_entry.radius[k] }; })
    .sort(function(a,b){ return a.r - b.r; });
  if (r_pairs.length === 0) return null;

  if (radius <= r_pairs[0].r) return r_pairs[0].c;
  if (radius >= r_pairs[r_pairs.length - 1].r) return r_pairs[r_pairs.length - 1].c;

  for (var k = 0; k < r_pairs.length - 1; k++) {
    var p0 = r_pairs[k], p1 = r_pairs[k + 1];
    if (radius >= p0.r && radius <= p1.r) {
      var t = (radius - p0.r) / (p1.r - p0.r);
      return p0.c + t * (p1.c - p0.c);
    }
  }
  return null;
}
