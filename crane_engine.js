// ============================================================
// engine_sl850.js  — SL-850RfⅡ (KR-80H-F) Lookup Engine
//
// 設計原則:
//   - 補間禁止: テーブルの離散値のみ返す
//   - 安全側lookup: target以上の最小キーを採用
//   - throw禁止: 必ずnull + reason返却
//   - lookupキー: toKey()で"24.0"形式統一
//
// 外部依存: なし（スタンドアロン）
// ============================================================

// ── キー正規化 ──────────────────────────────────────────────
function toKey(v) {
  var n = parseFloat(v);
  if (!isFinite(n)) return String(v);
  // 小数点1桁以上を確保 ("24" → "24.0")
  return n % 1 === 0 ? n.toFixed(1) : String(n);
}

// ── 安全側lookup: target以上の最小キーの値を返す ────────────
// table: {string_key: any}
// target: number
// 戻り値: {key: number, value: any, rawKey: string} | null
function findNextGTE(table, target) {
  var rawKeys = Object.keys(table);
  var candidates = rawKeys
    .map(function(k){ return { raw: k, num: parseFloat(k) }; })
    .filter(function(e){ return isFinite(e.num) && e.num >= target; })
    .sort(function(a, b){ return a.num - b.num; });
  if (candidates.length === 0) return null;
  var best = candidates[0];
  return { key: best.num, value: table[best.raw], rawKey: best.raw };
}

// ── アウトリガキー解決 ───────────────────────────────────────
// outrigger_mm: 7600/7200/6500/5400/4300/2550 or "front"
// "front" → 前方表を使う（outriggers.front）
// 数値    → outriggers[mm]
function resolveOutriggerKey(outrigger_mm) {
  if (outrigger_mm === 'front' || outrigger_mm === null) return 'front';
  return String(parseInt(outrigger_mm, 10));
}

// ============================================================
// メイン: boom_normal / boom_special lookup
//
// params: {
//   data        : boom_normal or boom_special JSON object
//   outrigger_mm: 7600|7200|6500|5400|4300|2550|"front"
//   cwKey:         string ('0', '29.8', ...)
//   boom_length_m: number
//   radius_m    : number
// }
// 戻り値: { capacity_t, used_radius_m, trace, reason }
// ============================================================
function lookupBoom(params) {
  var data       = params.data;
  var outrKey    = resolveOutriggerKey(params.outrigger_mm);
  var cwKey      = params.cwKey != null ? String(params.cwKey) : '0';
  var boomKey    = toKey(params.boom_length_m);
  var radius     = params.radius_m;
  var trace      = [];

  // outrigger層
  var outrLayer = data.outriggers[outrKey];
  if (!outrLayer) {
    return { capacity_t:null, used_radius_m:null, trace:trace,
             reason:'outrigger not found: ' + outrKey };
  }
  trace.push('アウトリガ: ' + outrKey + 'mm');

  // CW層
  var cwLayer = outrLayer[cwKey];
  if (!cwLayer) {
    return { capacity_t:null, used_radius_m:null, trace:trace,
             reason:'counterweight key not found: ' + cwKey };
  }
  trace.push('CW: ' + (params.cwKey ?? '0') + 't');

  // boom層
  var boomLayer = cwLayer[boomKey];
  if (!boomLayer) {
    return { capacity_t:null, used_radius_m:null, trace:trace,
             reason:'boom_length not found: ' + boomKey };
  }
  trace.push('ブーム: ' + boomKey + 'm');

  // radius lookup（安全側）
  var radTable = boomLayer.radius;
  if (!radTable) {
    return { capacity_t:null, used_radius_m:null, trace:trace,
             reason:'radius table missing for boom ' + boomKey };
  }

  var hit = findNextGTE(radTable, radius);
  if (hit === null) {
    return { capacity_t:null, used_radius_m:null, trace:trace,
             reason:'radius out of range (too large): ' + radius + 'm' };
  }

  if (hit.key > radius) {
    trace.push('R: ' + radius + 'm → ' + hit.key + 'm採用（安全側）');
  } else {
    trace.push('R: ' + hit.key + 'm');
  }
  trace.push('定格: ' + hit.value + 't');

  return {
    capacity_t:    hit.value,
    used_radius_m: hit.key,
    trace:         trace,
    reason:        null,
    danger_angle:  boomLayer.danger_angle_deg || null,
    hook_spec:     boomLayer.hook || null,
  };
}

// ============================================================
// jib lookup
//
// params: {
//   data          : jib JSON object
//   outrigger_mm  : number | "front"
//   cwKey         : string (boom_normal.jsonと同一キー)
//   base_boom_m   : 24.0 | 45.0
//   jib_length_m  : 13.8 | 18.0
//   jib_offset_deg: 5 | 25 | 45 | 60
//   boom_angle_deg: number（ブーム角度°）
// }
// 戻り値: { capacity_t, radius_m, trace, reason }
// ============================================================
function lookupJib(params) {
  var data       = params.data;
  var outrKey    = resolveOutriggerKey(params.outrigger_mm);
  var cwKey      = params.cwKey != null ? String(params.cwKey) : '0';
  var boomKey    = toKey(params.base_boom_m);
  var jibKey     = toKey(params.jib_length_m);
  var offsetKey  = String(params.jib_offset_deg);
  var boomAngle  = params.boom_angle_deg;
  var trace      = [];

  var outrLayer = data.outriggers[outrKey];
  if (!outrLayer) {
    return { capacity_t:null, radius_m:null, trace:trace,
             reason:'jib outrigger not found: ' + outrKey };
  }
  trace.push('ジブ アウトリガ: ' + outrKey);

  var cwLayer = outrLayer[cwKey];
  if (!cwLayer) {
    return { capacity_t:null, radius_m:null, trace:trace,
             reason:'jib CW layer missing' };
  }

  var boomLayer = cwLayer[boomKey];
  if (!boomLayer) {
    return { capacity_t:null, radius_m:null, trace:trace,
             reason:'jib base_boom not found: ' + boomKey + 'm' };
  }

  var jibLayer = boomLayer[jibKey];
  if (!jibLayer) {
    return { capacity_t:null, radius_m:null, trace:trace,
             reason:'jib_length not found: ' + jibKey + 'm' };
  }

  var offsets = jibLayer.offsets;
  if (!offsets) {
    return { capacity_t:null, radius_m:null, trace:trace,
             reason:'offsets missing' };
  }

  var offsetLayer = offsets[offsetKey];
  if (!offsetLayer) {
    return { capacity_t:null, radius_m:null, trace:trace,
             reason:'offset_deg not found: ' + offsetKey + '°' };
  }

  trace.push('ブーム: ' + boomKey + 'm + ジブ: ' + jibKey + 'm Off' + offsetKey + '°');

  // ブーム角度lookup（安全側: target以上の最小角）
  // 注意: ジブ表はブーム角度が大きいほど半径が小さい（高い）
  //       安全側 = 指定角度"以上"の最小角（より立っている = 安全）
  // offsetLayer は { danger_angle_deg, entries: {...} } または直接 {ang: {radius_m,capacity_t}} の両形式に対応
  var angleTable = (offsetLayer && offsetLayer.entries) ? offsetLayer.entries : offsetLayer;
  var jibDangerAngle = (offsetLayer && offsetLayer.danger_angle_deg !== undefined) ? offsetLayer.danger_angle_deg : null;

  var hit = findNextGTE(angleTable, boomAngle);
  if (hit === null) {
    return { capacity_t:null, radius_m:null, trace:trace,
             reason:'boom_angle out of range: ' + boomAngle + '°' };
  }

  if (hit.key > boomAngle) {
    trace.push('ブーム角: ' + boomAngle + '° → ' + hit.key + '°採用（安全側）');
  } else {
    trace.push('ブーム角: ' + hit.key + '°');
  }

  var entry = hit.value; // { radius_m, capacity_t }
  trace.push('作業半径: ' + entry.radius_m + 'm　定格: ' + entry.capacity_t + 't');

  return {
    capacity_t: entry.capacity_t,
    radius_m:   entry.radius_m,
    trace:      trace,
    reason:     null,
  };
}

// ============================================================
// 危険角チェック
// 戻り値: { ok, danger_angle_deg }
// ============================================================
function checkDangerAngle(boomResult, boomAngleDeg) {
  var da = boomResult.danger_angle;
  if (da === null || da === undefined || boomAngleDeg === null) {
    return { ok: true, danger_angle_deg: null };
  }
  return {
    ok: boomAngleDeg > da,
    danger_angle_deg: da,
  };
}

// ============================================================
// public API
// ============================================================
var SL850Engine = {
  lookupBoom:         lookupBoom,
  lookupJib:          lookupJib,
  checkDangerAngle:   checkDangerAngle,
  toKey:              toKey,
  findNextGTE:        findNextGTE,
};
