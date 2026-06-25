// ============================================================
// script.js  — 揚重計画シミュレーター v15
//
// 責務マップ（各責務は1箇所のみ）:
//   buildSVG()        — SVG断面図レンダリング（純粋関数）
//   getCaps()         — capabilities取得
//   hasCaps()         — capabilities有無判定
//   App()             — Reactコンポーネント（1個のみ）
//     state定義        — App内冒頭に集約
//     getManifestEntry()— manifestList参照（App内クロージャ）
//     resolveCrane()   — selected合成（craneCacheを引数で受取）
//     loadCraneData()  — fetch + setCraneCache
//     pickCraneById()  — 選択エントリポイント
//     useEffect×4      — manifest/cacheRefresh/theme/resize/selected/drag
//
// データフロー（一本化）:
//   manifest.json fetch
//     → setManifestList
//     → 左パネルに一覧表示
//     → pickCraneById(id)
//       → loadCraneData(id)  … meta+loadchart fetch → setCraneCache
//       → setSelected(resolveCrane(id, craneCache))
//         → useEffect([craneCache]) で craneCache更新時にselected再解決
//         → rtState初期化（機種変更時のみ）
//           → buildSVG / lookup
// ============================================================

var ce       = React.createElement;
var useState = React.useState;
var useRef   = React.useRef;

// ============================================================
// ErrorBoundary
// ============================================================
class CraneErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(err) { return { hasError: true, error: err }; }
  componentDidCatch(err, info) { /* silent */ }
  render() {
    var self = this;
    if (this.state.hasError) {
      return ce('div', { style: { padding: '20px', color: COLOR.dangerText, fontFamily: 'monospace' } },
        ce('div', { style: { fontWeight: 700, marginBottom: '8px' } }, '⚠️ 描画エラーが発生しました'),
        ce('div', { style: { fontSize: '12px', color: COLOR.textSub, marginBottom: '12px' } }, String(this.state.error)),
        ce('button', {
          onClick: function () { self.setState({ hasError: false, error: null }); },
          style: { background: COLOR.primaryBt, color: '#fff', border: 'none', borderRadius: '5px', padding: '6px 14px', cursor: 'pointer' }
        }, 'リセット')
      );
    }
    return this.props.children;
  }
}

// ============================================================
// getCaps / hasCaps — capabilities取得（App外・純粋関数）
// 参照元: selected.capabilities のみ
// ============================================================
function getCaps(crane) {
  if (!crane) return {};
  var cap = crane.capabilities;
  if (!cap) return {};
  return {
    outrigger:     !!cap.outrigger,
    counterweight: !!cap.counterweight,
    boom_mode:     !!(cap.boomMode || cap.boom_mode),
    jib:           !!cap.jib,
  };
}
function hasCaps(crane) {
  var c = getCaps(crane);
  return !!(c.outrigger || c.jib || c.counterweight || c.boom_mode);
}

// ============================================================
// resolveCrane(id, manifestList, craneCache)
// — selectedに格納する合成オブジェクトを返す純粋関数
//   craneCache を引数で受け取るのでstale closureが発生しない
//
// 優先順位: craneCache[id].meta > manifestList entry > フォールバック
// ============================================================
function resolveCrane(id, manifestList, craneCache) {
  var mf     = (manifestList || []).find(function (x) { return x.id === id; }) || null;
  var cached = (craneCache || {})[id] || null;
  var meta   = cached && cached.meta;

  var base = {
    id:          id,
    name:        (meta && meta.name)        || (mf && mf.name)        || id,
    type:        (meta && meta.type)        || (mf && mf.type)        || '',
    vehicleType: (meta && meta.vehicleType) || (mf && mf.vehicleType) || 'roughterrain',
    engineType:  (meta && meta.engine)      || (mf && mf.engineType)  || 'legacy',
    cap:         (meta && meta.cap_t)       || (mf && mf.cap)         || 0,
    boomSteps:        (meta && meta.boom_steps)         || null,
    boomStepsSpecial: (meta && meta.boom_steps_special) || null,
    boomSections:     (meta && meta.boomSections)       || 4,
    maxBoom:          (meta && meta.max_boom_m)         || null,
    minR:             (meta && meta.min_r_m)            || null,
    outrigger:        (meta && meta.outrigger_m)        || null,
    crawlerWidth:     (meta && (meta.crawler_width != null ? meta.crawler_width : meta.outrigger_m)) || null,
    tbl:    [],   // legacy用（SL850は使わない）
    jibData: null,
  };

  // selected.hooks: hook_catalog 優先、なければ hook_spec を変換して使用
  var _rawCatalog = meta && meta.hook_catalog;
  var _rawSpec    = meta && meta.hook_spec;
  if (Array.isArray(_rawCatalog) && _rawCatalog.length > 0) {
    base.hooks = _rawCatalog;
  } else if (Array.isArray(_rawSpec) && _rawSpec.length > 0) {
    base.hooks = _rawSpec.map(function(h, idx) {
      var hId  = h.id || ('hook_' + idx);
      var hTon = h.ton != null ? h.ton : (h.hook_t != null ? h.hook_t : 0);
      // usableFor: データにあればそのまま。なければtonで判定（5t以下はjib可）
      var hUsableFor = Array.isArray(h.usableFor) ? h.usableFor
                     : (hTon <= 5 ? ['main', 'jib'] : ['main']);
      return {
        id:           hId,
        name:         h.name         || (hTon + 'tフック'),
        weight_t:     h.weight_t     != null ? h.weight_t     : (h.mass_t  != null ? h.mass_t  : (h.mass   != null ? h.mass   : 0)),
        hookHeight_boom_m: h.hookHeight_boom_m != null ? h.hookHeight_boom_m
                          : (h.hookHeight_m != null ? h.hookHeight_m
                          : (h.length_m != null ? h.length_m
                          : (h.length != null ? h.length : 2.0))),
        hookHeight_jib_m: h.hookHeight_jib_m != null ? h.hookHeight_jib_m : null,
        ton:          hTon,
        usableFor:    hUsableFor,
        boomMax:      h.boomMax      != null ? h.boomMax      : (h.boom_max != null ? h.boom_max : null),
      };
    });
  } else {
    base.hooks = [];
  }

  // capabilities / options / defaults
  base.capabilities       = (meta && meta.capabilities)      || null;
  base.rtOutriggerOptions = (meta && meta.outrigger_options) || null;
  base.rtJibOptions       = (meta && meta.jib_options)       || null;
  base.jibHookDefault     = (meta && meta.jib_hook_default)   || null;
  base.rtBoomModes        = (meta && meta.boom_modes)        || null;
  base.defaults           = (meta && meta.defaults)          || null;
  base.maxRBoom           = (meta && (meta.maxR_boom != null ? meta.maxR_boom : meta.maxR)) || (mf && mf.maxR_boom) || null;
  base.maxRJib            = (meta && meta.maxR_jib) || (mf && mf.maxR_jib) || null;
  base.maxR               = base.maxRBoom || base.maxRJib || (meta && meta.max_r_m) || null;
  base.boomFootX          = (meta && meta.boom_foot_x != null) ? meta.boom_foot_x : 0;
  base.boomFootY          = (meta && meta.boom_foot_y != null) ? meta.boom_foot_y : SVG_BASE_HEIGHT;

  return base;
}

// ============================================================
// getLookupContext — lookup用データ取得（SL850はcraneCache経由）
// ============================================================
function getLookupContext(crane, craneCache) {
  var cached  = (craneCache || {})[crane.id] || null;
  var tbl     = (cached && cached.tbl)     || crane.tbl     || [];
  var jibData = (cached && cached.jibData) || crane.jibData || null;
  var resolved = Object.assign({}, crane, { tbl: tbl, jibData: jibData });
  return { tbl: tbl, jibData: jibData, crane: resolved };
}

// ============================================================
// buildSVG — SVG断面図レンダラー（純粋関数）
// console.logなし
// ============================================================
// buildSVG: selectedHook = { weight_t, hookHeight_m } を直接受け取る
// isJibMode フラグでフック基点(jibTip/boomTip)を切り替える
function buildSVG(crane, radius, weight, boomLen, selectedHook, buildingDist, buildingH, buildingDepth, compact, safetyFactor, liftHeight, isJibMode, palette, jibLen, jibOffsetAngle, outriggerOverride, boomAngleDegOverride) {
  var P = palette || getSvgPalette('dark', 'default');
  // selectedHook: null=未選択。フック描画スキップ。
  // isJibMode=true  → hookHeight_jib_m (ジブ先端→フック先端)
  // isJibMode=false → hookHeight_boom_m (ブーム先端→フック先端)
  var _hookSelected = !!(selectedHook && selectedHook.id && selectedHook.id !== 'none');
  var _hook      = selectedHook || {};
  var usedMass   = _hookSelected ? safeNum(_hook.weight_t || _hook.mass, 0) : 0;
  var hookLength = _hookSelected
    ? (isJibMode
        ? safeNum(_hook.hookHeight_jib_m  != null ? _hook.hookHeight_jib_m  : (_hook.hookHeight_boom_m || _hook.hookHeight_m || 2.0), 2.0)
        : safeNum(_hook.hookHeight_boom_m != null ? _hook.hookHeight_boom_m : (_hook.hookHeight_m || 2.0), 2.0))
    : 2.0;
  var angleDeg   = (boomAngleDegOverride !== undefined && boomAngleDegOverride !== null) ? boomAngleDegOverride : radiusToBoomAngle(boomLen, radius);
  // 揚程初期値（ジブの場合は後でjibTipY確定後に補正）
  var heightM    = angleDeg !== null ? (calcHeight(boomLen, angleDeg) - hookLength) : null;
  var _hasJibForHeight = !!isJibMode;
  var angRad     = ((angleDeg !== null ? angleDeg : 70)) * DEG_TO_RAD;
  var boomAngleDeg = angleDeg !== null ? angleDeg : 70;
  var boomRad    = boomAngleDeg * DEG_TO_RAD;

  var isCrawler = crane.vehicleType === 'crawler';
  var outr      = (outriggerOverride !== undefined && outriggerOverride !== null)
    ? outriggerOverride
    : (isCrawler ? (crane.crawlerWidth || 2.23) : (crane.outrigger || 6));
  var nSections = crane.boomSections || 4;

  var BASE   = SVG_BASE_HEIGHT;
  var bDist  = Math.max(0, safeNum(buildingDist, 0));
  var bH     = Math.max(0, safeNum(buildingH, 0));
  var bldW_m = (buildingDepth && safeNum(buildingDepth, 0) > 0) ? Math.max(1, safeNum(buildingDepth, SVG_BUILDING_WIDTH)) : SVG_BUILDING_WIDTH;
  var hasBld = !compact && bDist > 0 && bH > 0 && Number.isFinite(bDist) && Number.isFinite(bH);

  // ブームフートピン位置（機種ごと。未設定はデフォルト値）
  var footX = (crane.boomFootX != null) ? crane.boomFootX : 0;
  var footY = (crane.boomFootY != null) ? crane.boomFootY : BASE;

  // ── ジオメトリ ──
  // ブーム描画始点 = フートピン位置（作業半径Rは旋回中心x=0 から計測のまま）
  var boomBaseX = footX, boomBaseY = footY;
  var boomTipX  = boomBaseX + boomLen * Math.cos(boomRad);
  var boomTipY  = boomBaseY + boomLen * Math.sin(boomRad);

  // hasJib: isJibModeと統一（jibLen/jibOffsetAngle個別チェック廃止）
  var hasJib = !!(isJibMode && jibLen && jibLen > 0);
  var jibBaseX = boomTipX, jibBaseY = boomTipY;
  var jibTipX  = jibBaseX, jibTipY  = jibBaseY;
  if (hasJib) {
    var jibRenderDeg = boomAngleDeg - safeNum(jibOffsetAngle, 0);
    var jibRad2 = jibRenderDeg * DEG_TO_RAD;
    jibTipX = jibBaseX + safeNum(jibLen, 0) * Math.cos(jibRad2);
    jibTipY = jibBaseY + safeNum(jibLen, 0) * Math.sin(jibRad2);
  }

  // ジブ時: jibTip基準 / ブーム時: boomTip基準
  var liftPtX = hasJib ? jibTipX : boomTipX;
  var liftPtY = hasJib ? jibTipY : boomTipY;


  // 揚程補正: ジブ使用時はジブ先端高さからフック長を引く
  if (_hasJibForHeight && hasJib && Number.isFinite(jibTipY)) {
    heightM = jibTipY - hookLength;
  }

  var loadH_m    = 1.5;
  var hookBlockH = Math.min(hookLength * 0.6, 1.0);
  var slingLen   = 2.0;  // (B) スリング固定値

  // ─── フック位置: liftPt（ブーム/ジブ先端）基準で上から確定 ───────────
  // hookLength = liftPt → フックブロック上端 の固定距離
  // ブーム時: hookHeight_boom_m / ジブ時: hookHeight_jib_m を使用
  //
  // liftHeight スライダー = liftPt（先端）のGL高さを設定
  // → フック全体・吊荷が一体で上下する

  var liftH_req  = Math.max(0, safeNum(liftHeight, 0));

  // liftPtYをスライダーで上下（liftH_req=0のとき先端Y=liftPtY）
  // スライダーはliftPtの高さを下げる方向に作用
  var effectiveLiftPtY = liftPtY - liftH_req;

  // (A) liftPt → フックブロック上端 = hookLength（固定）
  var hookTopY_m = effectiveLiftPtY - hookLength;
  var hookBotY_m = hookTopY_m - hookBlockH;

  // (B) フックブロック下端 → 吊荷上端 = slingLen（固定）
  var loadTop_m  = Math.max(0, hookBotY_m - slingLen);
  var loadBot_m  = Math.max(0, loadTop_m - loadH_m);

  // (A) ホイストワイヤー長 = liftPt（実際の先端位置）→ フックブロック上端
  var hoistWireLen = Math.max(0, liftPtY - hookTopY_m);

  var hookX_m      = liftPtX;
  var hookBaseX_m  = liftPtX, hookBaseY_m = liftPtY;
  var loadRectBot  = loadBot_m, loadRectTop = loadTop_m, loadGLH = loadBot_m;

  // viewBox
  var tipForViewX = hasJib ? Math.max(boomTipX, jibTipX) : boomTipX;
  var tipForViewY = hasJib ? Math.max(boomTipY, jibTipY) : boomTipY;
  var tipMinViewX = hasJib ? Math.min(boomTipX, jibTipX) : boomTipX;
  var DIM_DOWN = 1.5, DIM_RIGHT = SVG_DIM_RIGHT;   // ← maxX_m より前に定義（NaN防止）
  var minX_m = Math.min(-outr / 2 - 1.5 - outr, -3.5, tipMinViewX - 1);
  var maxX_m = Math.max(tipForViewX + 5, hasBld ? bDist + bldW_m + DIM_RIGHT + 4 : 0, outr / 2 + 2);
  var topY_m = Math.max(tipForViewY + 2.5, bH + 2, 10);   // 地面より上
  var botY_m = hasBld ? (DIM_DOWN * 3.0 + 1.4) : (DIM_DOWN * 1.8 + 0.8); // 地面より下（寸法線分）
  var vbW = maxX_m - minX_m, vbH = topY_m + botY_m, PAD = SVG_MARGIN_RATIO;
  var vbX0 = minX_m - vbW * PAD, vbY0 = -(topY_m + vbH * PAD);
  var vbW2 = vbW * (1 + PAD * 2), vbH2 = vbH * (1 + PAD * 2);
  var maxY_m = topY_m;  // 後方互換

  function sx(x) { return x; }
  function sy(y) { return -y; }

  var gndSY = sy(0), baseSX = sx(boomBaseX), baseSY = sy(boomBaseY);
  var pivotSX = sx(0), pivotSY = sy(BASE);  // 旋回中心（R計測の基点・参考表示用）
  var tipSX = sx(boomTipX), tipSY = sy(boomTipY);
  var fs = compact ? 0.80 : 0.90, fsS = compact ? 0.62 : 0.72;
  var markerId = 'arr' + crane.id + (compact ? 'c' : 'f');

  if (!Number.isFinite(vbX0) || !Number.isFinite(vbY0) || vbW2 <= 0 || vbH2 <= 0 || !Number.isFinite(tipSX) || !Number.isFinite(tipSY)) {
    return ce('svg', { viewBox: '0 0 100 60', style: { width: '100%', height: '100%', display: 'block' } },
      ce('rect', { x: 0, y: 0, width: 100, height: 60, fill: P.bg }),
      ce('text', { x: 50, y: 35, textAnchor: 'middle', fontSize: 5, fill: P.sub }, '条件を入力してください'));
  }
  var vbStr = vbX0.toFixed(2) + ' ' + vbY0.toFixed(2) + ' ' + vbW2.toFixed(2) + ' ' + vbH2.toFixed(2);

  // 干渉判定（建物はクレーン中心基準の絶対位置＝吊荷位置に依存しない固定障害物）
  var boomHit = false;
  var bldNearX = bDist;   // 建物近接面X = クレーン中心(0)からの水平距離
  var bldSX = hasBld ? sx(bldNearX) : 0, bldSY_t = hasBld ? sy(bH) : 0;
  if (hasBld && Number.isFinite(bldSX) && Number.isFinite(bldSY_t)) {
    if (tipSX >= bldSX && tipSX <= bldSX + bldW_m && tipSY >= bldSY_t && tipSY <= gndSY) boomHit = true;
    if (!boomHit) {
      var dx2 = tipSX - baseSX, dy2 = tipSY - baseSY;
      if (Math.abs(dx2) > 0.001) {
        var t2 = (bldSX - baseSX) / dx2;
        if (t2 >= 0 && t2 <= 1) { var yt = baseSY + t2 * dy2; if (yt >= bldSY_t && yt <= gndSY) boomHit = true; }
      }
    }
  }
  var boomColor = boomHit ? P.ng : P.boom, boomColorL = boomHit ? P.ngTxt : P.boomL;

  // Layer1: 背景
  var gndHatches = [];
  var hCount = Math.ceil(vbW2 / 1.8) + 2;
  for (var hi = 0; hi < hCount; hi++) {
    var hx = vbX0 - 1 + hi * 1.8;
    if (Number.isFinite(hx)) gndHatches.push(ce('line', { key: 'h' + hi, x1: hx, y1: gndSY, x2: hx - 0.7, y2: gndSY + 0.7, stroke: P.hatch, strokeWidth: 0.05 }));
  }
  var bgLayer = ce('g', { key: 'bg' },
    ce('rect', { x: vbX0, y: vbY0, width: vbW2, height: vbH2, fill: P.bg }),
    ce('line', { x1: vbX0, y1: gndSY, x2: vbX0 + vbW2, y2: gndSY, stroke: P.groundLine, strokeWidth: 0.18 }),
    ce('g', { key: 'hatches' }, gndHatches));

  // Layer2: 建物（直線寸法線・クレーン中心基準）
  var buildingLayer = null;
  if (hasBld && Number.isFinite(bldSX) && Number.isFinite(bldSY_t)) {
    var bldColor = '#b8860b', bldTxtColor = '#8a6d0b';
    var sc = boomHit ? P.ng : bldColor, tc = boomHit ? P.ngTxt : bldTxtColor;
    var bldFarX  = bldSX + bldW_m;
    // 寸法線位置（すべて単一直線・段差なし）
    // 距離・幅は「アウトリガ幅(sy(-DIM_DOWN*1.8))」の下に同一高さで横一列
    var baseDimY = sy(-DIM_DOWN * 3.0);          // 距離・幅 共通ベースライン（地面下）
    var hgtDimX  = bldFarX + DIM_RIGHT * 1.0;    // 高さ: 建物右に垂直線（現状維持）
    var ext = 0.05;                              // witness線
    buildingLayer = ce('g', { key: 'building' },
      // 建物本体
      ce('rect', { x: bldSX, y: bldSY_t, width: Math.max(0.1, bldW_m), height: Math.max(0.1, gndSY - bldSY_t), fill: boomHit ? 'rgba(192,57,43,0.10)' : 'rgba(184,134,11,0.08)', stroke: sc, strokeWidth: 0.10 }),
      ce('text', { x: bldSX + bldW_m / 2, y: bldSY_t - 1.5, textAnchor: 'middle', fontSize: fsS, fill: tc, fontWeight: '600' }, '建物'),

      // witness線（クレーン中心・建物手前面・建物奥面 を地面からベースラインまで）
      ce('line', { x1: sx(0),    y1: gndSY, x2: sx(0),    y2: baseDimY + 0.3, stroke: bldColor, strokeWidth: ext }),
      ce('line', { x1: bldSX,    y1: gndSY, x2: bldSX,    y2: baseDimY + 0.3, stroke: bldColor, strokeWidth: ext }),
      ce('line', { x1: bldFarX,  y1: gndSY, x2: bldFarX,  y2: baseDimY + 0.3, stroke: bldColor, strokeWidth: ext }),

      // ① 建物までの距離（クレーン中心 → 建物手前面）
      ce('line', { x1: sx(0), y1: baseDimY, x2: bldSX, y2: baseDimY, stroke: bldColor, strokeWidth: 0.07, markerStart: 'url(#' + markerId + ')', markerEnd: 'url(#' + markerId + ')' }),
      ce('rect', { x: (sx(0) + bldSX) / 2 - 2.6, y: baseDimY + 0.10, width: 5.2, height: 0.80, rx: 0.12, fill: P.labelBg }),
      ce('text', { x: (sx(0) + bldSX) / 2, y: baseDimY + 0.68, textAnchor: 'middle', fontSize: fsS, fill: bldTxtColor }, '建物までの距離 ' + bDist + 'm'),

      // ② 建物幅（建物手前面 → 奥面）：距離と同一高さで横一列
      ce('line', { x1: bldSX, y1: baseDimY, x2: bldFarX, y2: baseDimY, stroke: boomHit ? P.ngTxt : bldColor, strokeWidth: 0.07, markerStart: 'url(#' + markerId + ')', markerEnd: 'url(#' + markerId + ')' }),
      ce('rect', { x: (bldSX + bldFarX) / 2 - 2.0, y: baseDimY + 0.10, width: 4.0, height: 0.80, rx: 0.12, fill: P.labelBg }),
      ce('text', { x: (bldSX + bldFarX) / 2, y: baseDimY + 0.68, textAnchor: 'middle', fontSize: fsS, fill: boomHit ? P.ngTxt : bldTxtColor }, '建物幅 ' + bldW_m.toFixed(1) + 'm'),

      // ③ 建物高さ：建物右の一直線（現状維持）
      ce('line', { x1: bldFarX, y1: bldSY_t, x2: hgtDimX + 0.3, y2: bldSY_t, stroke: bldColor, strokeWidth: ext }),
      ce('line', { x1: bldFarX, y1: gndSY, x2: hgtDimX + 0.3, y2: gndSY, stroke: bldColor, strokeWidth: ext }),
      ce('line', { x1: hgtDimX, y1: bldSY_t, x2: hgtDimX, y2: gndSY, stroke: boomHit ? P.ngTxt : bldColor, strokeWidth: 0.07, markerStart: 'url(#' + markerId + ')', markerEnd: 'url(#' + markerId + ')' }),
      ce('rect', { x: hgtDimX + 0.20, y: (bldSY_t + gndSY) / 2 - 0.46, width: 3.2, height: 1.5, rx: 0.12, fill: P.labelBg }),
      ce('text', { x: hgtDimX + 0.35, y: (bldSY_t + gndSY) / 2 - 0.02, fontSize: fsS, fill: tc }, '建物高さ'),
      ce('text', { x: hgtDimX + 0.35, y: (bldSY_t + gndSY) / 2 + 0.72, fontSize: fsS, fill: tc }, bH + 'm'));
  }

  // Layer3: クレーン本体
  var C = P.body, CS = P.bodyS;
  var craneBodyLayer;
  if (isCrawler) {
    // クローラー: フートピン(footX,footY)絶対基準・承認済み形状
    //   旋回体: 左肩フートピン段(切欠)＋右上面取り＋他直角
    //   カーボディ: 旋回体とキャタピラの間の首
    //   キャタピラ: カプセル形＋両端の起動輪/誘導輪のみ
    var trackH   = 0.95;                            // キャタピラ高さ
    var trackTop = trackH;                          // キャタピラ上端
    var carbodyH = 0.45;                            // カーボディ高さ
    var carbodyTop = trackTop + carbodyH;            // カーボディ上端 = 旋回体底面
    var bodyBot  = carbodyTop;                       // 旋回体底面
    var H = footY;
    var swH = Math.max(2.0, H - bodyBot - 0.3);      // 旋回体高さ
    var trackHalf0 = outr / 2;                        // キャタピラ半長
    var swLeft  = Math.max(-trackHalf0, footX - 0.3); // 左面x（キャタピラ左端を超えない）
    // 旋回体右端はキャタピラ右端を超えない（下のクローラから先に出さない）
    var swRight = Math.min(trackHalf0, swLeft + Math.max(3.4, H * 1.3));
    var swW     = swRight - swLeft;                   // 旋回体幅
    var stepSize = 0.55;                              // フートピン段（正方形）の一辺
    var stepRight = swLeft + stepSize;                // 段の右端
    var stepUp  = stepSize;                           // 段差の高さ＝幅（正方形）
    var bodyTop = footY + stepUp;                     // 本体上面（段より一段上）
    var footTop = footY;                              // フートピン段の上面（フートピン高さ）

    // 旋回体パス（6頂点・時計回り・右上面取りなし＝直角）
    //  1 段左上(swLeft,footTop) 2 段右(stepRight,footTop) 3 段差上(stepRight,bodyTop)
    //  4 本体上面右(swRight,bodyTop) 5 右面下(swRight,bodyBot) 6 底面左(swLeft,bodyBot) →1 左面
    var swingPath =
      'M ' + sx(swLeft)     + ' ' + sy(footTop) +
      ' L ' + sx(stepRight) + ' ' + sy(footTop) +
      ' L ' + sx(stepRight) + ' ' + sy(bodyTop) +
      ' L ' + sx(swRight)   + ' ' + sy(bodyTop) +
      ' L ' + sx(swRight)   + ' ' + sy(bodyBot) +
      ' L ' + sx(swLeft)    + ' ' + sy(bodyBot) +
      ' Z';

    var trackCx   = 0;                               // キャタピラ中心 = 旋回中心(x=0)
    var trackHalf = trackHalf0;                       // キャタピラ半長
    var wheelR    = trackH * 0.32;

    craneBodyLayer = ce('g', { key: 'craneBody' },
      // キャタピラ（カプセル形＋両端輪のみ）
      ce('rect', { x: trackCx - trackHalf, y: sy(trackTop), width: trackHalf * 2, height: trackH, rx: trackH / 2, fill: C, stroke: CS, strokeWidth: 0.10 }),
      ce('circle', { cx: trackCx - trackHalf + wheelR + 0.15, cy: sy(trackH / 2), r: wheelR, fill: 'none', stroke: CS, strokeWidth: 0.08 }),
      ce('circle', { cx: trackCx + trackHalf - wheelR - 0.15, cy: sy(trackH / 2), r: wheelR, fill: 'none', stroke: CS, strokeWidth: 0.08 }),
      // カーボディ（旋回体とキャタピラの間の首）
      ce('rect', { x: trackCx - swW * 0.18, y: sy(carbodyTop), width: swW * 0.36, height: carbodyH, rx: 0.06, fill: C, stroke: CS, strokeWidth: 0.09 }),
      // 旋回体＋運転席
      ce('path', { d: swingPath, fill: C, stroke: CS, strokeWidth: 0.11, strokeLinejoin: 'round' }),
      // フートピン（段の左下の角）
      ce('circle', { cx: sx(boomBaseX), cy: sy(boomBaseY), r: 0.20, fill: P.dim, stroke: CS, strokeWidth: 0.08 }));
  } else {
    // ラフター/AT: フートピン(footX,footY)絶対基準・参考図ピンク形状（凸形状）
    //   旋回体: 左上にフートピン段（ブラケット）が突き出た形
    //   左面/後面=垂直, 上面=水平, 右(前面)=上面取り+右下カット, 底面=水平
    var H = footY;                                 // フートピン高さ(GL基準)
    var tireTopY0 = 0.52;                           // タイヤ上端
    var mainTop0  = footY - 0.55;                   // 本体上面（段より一段下）
    var availH    = Math.max(2.0, mainTop0 - tireTopY0); // 旋回体+キャリアに使える高さ
    var swH = availH * 0.6;                          // 旋回体本体の高さ（60%）
    var swW     = Math.max(4.6, H * 1.7);          // 旋回体幅
    var swLeft  = -swW / 2;                         // 左面x（旋回中心x=0に対称配置）
    var swRight = swLeft + swW;                     // 右面x = +swW/2
    var stepTop = footY + 0.25;                     // フートピン段の上面
    var stepRight = footX + 0.9;                    // フートピン段の右端
    var mainTop = mainTop0;                          // 本体上面
    var bodyBot = mainTop - swH;                    // 本体底面 = キャリア上面
    var cut  = 0.5;                                 // 右上の面取り
    var cut2 = Math.max(0.6, swH * 0.4);            // 右下カット

    // キャリア（旋回体中央下・単純長方形・小さめ）
    var carrierW    = swW * 0.5;
    var carrierCx   = (swLeft + swRight) / 2;
    var carrierLeft = carrierCx - carrierW / 2;
    var carrierRight= carrierCx + carrierW / 2;
    var carrierTop  = bodyBot;                       // 旋回体底面に接する
    var tireTopY    = tireTopY0;                      // タイヤ上端
    var carrierBot  = tireTopY;                      // キャリア下端 = タイヤ上端
    var carrierH    = Math.max(0.6, carrierTop - carrierBot);

    // 旋回体パス（フートピン段付き凸形状・時計回り）
    var swingPath =
      'M ' + sx(swLeft)     + ' ' + sy(stepTop) +              // 1 段 左上
      ' L ' + sx(stepRight) + ' ' + sy(stepTop) +              // 2 段 右上（上面・水平）
      ' L ' + sx(stepRight) + ' ' + sy(mainTop) +              // 3 段 右下（垂直）
      ' L ' + sx(swRight - cut) + ' ' + sy(mainTop) +          // 4 本体上面（水平）
      ' L ' + sx(swRight)   + ' ' + sy(mainTop - cut) +        // 5 右上面取り
      ' L ' + sx(swRight)   + ' ' + sy(bodyBot + cut2) +       // 6 前面（垂直）
      ' L ' + sx(swRight - cut2) + ' ' + sy(bodyBot) +         // 7 右下カット
      ' L ' + sx(swLeft)    + ' ' + sy(bodyBot) +              // 8 底面（水平）
      ' Z';                                                     // 9→1 左面（垂直）

    craneBodyLayer = ce('g', { key: 'craneBody' },
      // ① アウトリガ（キャリア両側面から水平張出＋ジャッキ＋接地プレート）
      [-1, 1].map(function (sg) {
        var beamY  = carrierTop - 0.25;            // ビーム高さ（キャリア側面の上寄り）
        var innerX = sg < 0 ? carrierLeft : carrierRight;
        var tipX   = carrierCx + sg * (outr / 2);  // 張出端x
        var x0 = Math.min(innerX, tipX), x1 = Math.max(innerX, tipX);
        return ce('g', { key: 'outr' + sg },
          ce('rect', { x: x0, y: sy(beamY + 0.09), width: (x1 - x0), height: 0.18, rx: 0.04, fill: C, stroke: CS, strokeWidth: 0.06 }),
          ce('rect', { x: tipX - 0.09, y: sy(beamY), width: 0.18, height: beamY, fill: C, stroke: CS, strokeWidth: 0.06 }),
          ce('rect', { x: tipX - 0.30, y: sy(0.12), width: 0.60, height: 0.13, rx: 0.04, fill: C, stroke: P.ok, strokeWidth: 0.08 }));
      }),
      // ② タイヤ（キャリア下・左右2輪・控えめ）
      [carrierLeft + carrierW * 0.25, carrierLeft + carrierW * 0.75].map(function (tx, i) {
        return ce('rect', { key: 'tire' + i, x: tx - 0.28, y: sy(tireTopY), width: 0.56, height: 0.50, rx: 0.10, fill: C, stroke: P.ok, strokeWidth: 0.09 });
      }),
      // ③ キャリア（単純長方形）
      ce('rect', { x: carrierLeft, y: sy(carrierTop), width: carrierW, height: carrierH, rx: 0.06, fill: C, stroke: CS, strokeWidth: 0.10 }),
      // ④ 旋回体（凸形状・一体）
      ce('path', { d: swingPath, fill: C, stroke: CS, strokeWidth: 0.11, strokeLinejoin: 'round' }),
      // ⑤ フートピン（回転軸の丸）
      ce('circle', { cx: sx(boomBaseX), cy: sy(boomBaseY), r: 0.22, fill: P.dim, stroke: CS, strokeWidth: 0.08 }));
  }

  // Layer4: ブーム
  var boomBaseW = compact ? SVG_BOOM_WIDTH_SM : SVG_BOOM_WIDTH;
  var bCos = Math.cos(angRad), bSin = Math.sin(angRad);
  var boomElems = [];
  // 中心スパイン（viewBoxスケールに依存しない固定太さ＝長尺でも視認可能）
  boomElems.push(ce('line', { key: 'spine', x1: baseSX.toFixed(3), y1: baseSY.toFixed(3), x2: tipSX.toFixed(3), y2: tipSY.toFixed(3), stroke: boomColor, strokeWidth: 2.6, vectorEffect: 'non-scaling-stroke', strokeLinecap: 'round', opacity: 0.55 }));
  for (var si = 0; si < nSections; si++) {
    var t0 = si / nSections, t1 = (si + 1) / nSections;
    var w0 = boomBaseW * (1 - t0 * 0.65), w1 = boomBaseW * (1 - t1 * 0.65);
    var p0x = baseSX + (tipSX - baseSX) * t0, p0y = baseSY + (tipSY - baseSY) * t0;
    var p1x = baseSX + (tipSX - baseSX) * t1, p1y = baseSY + (tipSY - baseSY) * t1;
    var bx1 = p0x - bSin * w0, by1 = p0y + bCos * w0;
    var bx2 = p0x + bSin * w0, by2 = p0y - bCos * w0;
    var bx3 = p1x + bSin * w1, by3 = p1y - bCos * w1;
    var bx4 = p1x - bSin * w1, by4 = p1y + bCos * w1;
    var pathD = 'M ' + bx1.toFixed(3) + ' ' + by1.toFixed(3) + ' L ' + bx2.toFixed(3) + ' ' + by2.toFixed(3) + ' L ' + bx3.toFixed(3) + ' ' + by3.toFixed(3) + ' L ' + bx4.toFixed(3) + ' ' + by4.toFixed(3) + ' Z';
    if (si < nSections - 1) {
      var sepW = w1 * 1.05;
      boomElems.push(ce('line', { key: 'sep' + si, x1: (p1x - bSin * sepW).toFixed(3), y1: (p1y + bCos * sepW).toFixed(3), x2: (p1x + bSin * sepW).toFixed(3), y2: (p1y - bCos * sepW).toFixed(3), stroke: boomColorL, strokeWidth: 1.0, vectorEffect: 'non-scaling-stroke', opacity: 0.7 }));
    }
    boomElems.push(ce('path', { key: 'sec' + si, d: pathD, fill: boomColor, fillOpacity: 0.18, stroke: boomColor, strokeWidth: 1.6, vectorEffect: 'non-scaling-stroke' }));
    boomElems.push(ce('line', { key: 'hl' + si, x1: p0x.toFixed(3), y1: p0y.toFixed(3), x2: p1x.toFixed(3), y2: p1y.toFixed(3), stroke: boomColorL, strokeWidth: 1.0, vectorEffect: 'non-scaling-stroke', opacity: 0.40 }));
  }
  var boomMidX = (baseSX + tipSX) / 2, boomMidY = (baseSY + tipSY) / 2, boomLabelW = compact ? 2.6 : 3.0;
  boomElems.push(
    ce('rect', { key: 'bmlbg', x: boomMidX - boomLabelW / 2, y: boomMidY - 0.42, width: boomLabelW, height: 0.82, rx: 0.14, fill: P.labelBg, opacity: 0.88 }),
    ce('text', { key: 'bmlbl', x: boomMidX, y: boomMidY + 0.25, textAnchor: 'middle', fontSize: fs, fill: P.boomOk }, safeFmt(boomLen, 1) + 'm'));
  if (angleDeg !== null) {
    // 角度の数値のみ表示（弧・水平線は描かない）。位置=運転席の上あたり
    var angTxtX = boomBaseX + (boomLen > 0 ? 5.0 : 4.0);
    var angTxtY = boomBaseY + 0.6;
    boomElems.push(
      ce('text', { key: 'angTxt', x: sx(angTxtX), y: sy(angTxtY), textAnchor: 'middle', fontSize: fs, fill: P.sub }, safeFmt(angleDeg, 1) + '°'));
  }
  var boomLayer = ce('g', { key: 'boom' }, boomElems);

  // Layer4b: ジブ
  var jibLayer = null;
  if (hasJib && Number.isFinite(jibTipX) && Number.isFinite(jibTipY)) {
    var jibElems = [];
    var jibW2 = (compact ? SVG_BOOM_WIDTH_SM : SVG_BOOM_WIDTH) * 0.42, jibTipW2 = jibW2 * 0.45;
    var jtipSX = sx(jibBaseX), jtipSY = sy(jibBaseY), jendSX = sx(jibTipX), jendSY = sy(jibTipY);
    var jDX = jendSX - jtipSX, jDY = jendSY - jtipSY, jLen = Math.sqrt(jDX * jDX + jDY * jDY);
    if (jLen > 0.01) {
      var juX = jDX / jLen, juY = jDY / jLen, jnX = -juY, jnY = juX;
      var jx1 = jtipSX - jnX * jibW2, jy1 = jtipSY - jnY * jibW2;
      var jx2 = jtipSX + jnX * jibW2, jy2 = jtipSY + jnY * jibW2;
      var jx3 = jendSX + jnX * jibTipW2, jy3 = jendSY + jnY * jibTipW2;
      var jx4 = jendSX - jnX * jibTipW2, jy4 = jendSY - jnY * jibTipW2;
      var jibColor = '#2563eb', jibColorL = '#93c5fd';
      jibElems.push(
        ce('path', { key: 'jib-body', d: 'M ' + jx1.toFixed(3) + ' ' + jy1.toFixed(3) + ' L ' + jx2.toFixed(3) + ' ' + jy2.toFixed(3) + ' L ' + jx3.toFixed(3) + ' ' + jy3.toFixed(3) + ' L ' + jx4.toFixed(3) + ' ' + jy4.toFixed(3) + ' Z', fill: jibColor, fillOpacity: 0.22, stroke: jibColor, strokeWidth: 0.11 }),
        ce('line', { key: 'jib-hl', x1: jtipSX.toFixed(3), y1: jtipSY.toFixed(3), x2: jendSX.toFixed(3), y2: jendSY.toFixed(3), stroke: jibColorL, strokeWidth: 0.09, opacity: 0.55 }),
        ce('circle', { key: 'jib-pin', cx: jtipSX.toFixed(3), cy: jtipSY.toFixed(3), r: 0.15, fill: P.dim, stroke: jibColorL, strokeWidth: 0.07 }),
        ce('circle', { key: 'jib-tip', cx: jendSX.toFixed(3), cy: jendSY.toFixed(3), r: 0.12, fill: jibColorL, stroke: jibColor, strokeWidth: 0.07 }));
      var jMidX = (jtipSX + jendSX) / 2, jMidY = (jtipSY + jendSY) / 2, jLabelW = compact ? 2.4 : 2.8;
      jibElems.push(
        ce('rect', { key: 'jib-lbg', x: jMidX - jLabelW / 2, y: jMidY - 0.40, width: jLabelW, height: 0.78, rx: 0.13, fill: P.labelBg, opacity: 0.90 }),
        ce('text', { key: 'jib-lbl', x: jMidX, y: jMidY + 0.24, textAnchor: 'middle', fontSize: fsS, fill: jibColorL }, safeFmt(jibLen, 1) + 'm'),
        ce('text', { key: 'jib-ang', x: (jtipSX + jnX * (jibW2 + 0.5)).toFixed(3), y: (jtipSY + jnY * (jibW2 + 0.5) - 0.3).toFixed(3), textAnchor: 'middle', fontSize: fsS * 0.9, fill: jibColorL, opacity: 0.80 }, 'Off' + safeNum(jibOffsetAngle, 0) + '°'));
    }
    jibLayer = ce('g', { key: 'jib' }, jibElems);
  }

  // Layer5: フック
  // hoistWireLen, hookTopY_m, hookBotY_m はすべて上で確定済み。ここでは上書き禁止。
  var hkX = sx(hookX_m), hkTopSY = sy(hookTopY_m), hkBotSY = sy(hookBotY_m);
  var sheaveSz = Math.min(0.55, Math.max(0.28, usedMass * 0.5 + 0.22));
  var hookLayer = _hookSelected ? ce('g', { key: 'hook' },
    hoistWireLen > 0.05 ? ce('line', { x1: hkX, y1: sy(hookBaseY_m), x2: hkX, y2: hkTopSY, stroke: P.sub, strokeWidth: 0.09, strokeDasharray: '0.35 0.20' }) : null,
    ce('circle', { cx: hkX, cy: hkTopSY, r: sheaveSz * 0.45, fill: 'none', stroke: P.sub, strokeWidth: 0.10 }),
    ce('circle', { cx: hkX, cy: hkTopSY, r: sheaveSz * 0.18, fill: P.dim, stroke: P.sub, strokeWidth: 0.06 }),
    ce('rect', { x: hkX - sheaveSz * 0.55, y: hkTopSY + sheaveSz * 0.42, width: sheaveSz * 1.10, height: hookBlockH * 0.6, rx: 0.08, fill: 'none', stroke: P.sub, strokeWidth: 0.09 }),
    ce('path', { d: 'M ' + (hkX - 0.14) + ' ' + (hkTopSY + sheaveSz * 0.42 + hookBlockH * 0.6) + ' L ' + (hkX - 0.14) + ' ' + (hkBotSY - 0.18) + ' Q ' + hkX + ' ' + (hkBotSY + 0.04) + ' ' + (hkX + 0.14) + ' ' + (hkBotSY - 0.18) + ' L ' + (hkX + 0.14) + ' ' + (hkTopSY + sheaveSz * 0.42 + hookBlockH * 0.6), fill: 'none', stroke: P.sub, strokeWidth: 0.11, strokeLinecap: 'round' }))
    : null;

  // Layer6: ワイヤー
  var loadW_m = 1.4, wireSpan = loadW_m * 0.40;
  var wireLayer = _hookSelected ? ce('g', { key: 'wires' },
    ce('line', { x1: hkX - wireSpan * 0.15, y1: hkBotSY, x2: hkX - wireSpan, y2: sy(loadTop_m), stroke: P.sub, strokeWidth: 0.08, strokeLinecap: 'round' }),
    ce('line', { x1: hkX + wireSpan * 0.15, y1: hkBotSY, x2: hkX + wireSpan, y2: sy(loadTop_m), stroke: P.sub, strokeWidth: 0.08, strokeLinecap: 'round' }))
    : null;

  // Layer7: 吊荷（ok判定はcurCapベースでなくcapacity的に正しい表示のみ）
  var loadLayer = ce('g', { key: 'load' },
    ce('rect', { x: hkX - loadW_m, y: sy(loadRectTop), width: loadW_m * 2, height: loadH_m, rx: 0.18, fill: 'none', stroke: P.ok, strokeWidth: 0.14 }),
    [0.3, 0.65, 1.0, 1.35].map(function (dx) {
      return ce('line', { key: 'lh' + dx, x1: hkX - loadW_m + dx * loadW_m, y1: sy(loadRectBot), x2: hkX - loadW_m + dx * loadW_m, y2: sy(loadRectTop), stroke: P.ok, strokeWidth: 0.04, opacity: 0.3 });
    }),
    ce('text', { x: hkX, y: sy(loadRectBot + loadH_m * 0.5 - 0.12), textAnchor: 'middle', fontSize: fs, fontWeight: '700', fill: P.boomL }, safeFmt(weight, 2) + 't'));

  // Layer8: 寸法線
  // 揚程寸法：クレーン左側に縦寸法線（地盤面 → フック下端）
  var heightElem = null;
  if (heightM !== null) {
    var hgtX     = sx(minX_m + 1.2 - outr);    // クレーン左側（アウトリガ幅分さらに左へ）
    var hkBotSY  = sy(hookBaseY_m);             // フック下端のSVG-Y
    heightElem = ce('g', { key: 'heightDim' },
      // 点線補助線（地盤面・フック下端から揚程線まで水平）
      ce('line', { x1: sx(0), y1: gndSY, x2: hgtX - 0.4, y2: gndSY, stroke: P.dim, strokeWidth: 0.05, strokeDasharray: '0.3 0.2', opacity: 0.7 }),
      ce('line', { x1: sx(hookX_m), y1: hkBotSY, x2: hgtX - 0.4, y2: hkBotSY, stroke: P.dim, strokeWidth: 0.05, strokeDasharray: '0.3 0.2', opacity: 0.7 }),
      // 縦寸法線（矢印付き）
      ce('line', { x1: hgtX, y1: gndSY, x2: hgtX, y2: hkBotSY, stroke: P.dim, strokeWidth: 0.08, markerStart: 'url(#' + markerId + ')', markerEnd: 'url(#' + markerId + ')' }),
      ce('rect', { x: hgtX - 1.9, y: (gndSY + hkBotSY) / 2 - 0.50, width: 3.8, height: 0.90, rx: 0.15, fill: P.labelBg }),
      ce('text', { x: hgtX, y: (gndSY + hkBotSY) / 2 + 0.12, textAnchor: 'middle', fontSize: fs, fill: P.sub }, 'H=' + safeFmt(heightM, 1) + 'm'));
  }
  var workingRadiusX = hasJib ? hookX_m : radius;
  var radiusDim = ce('g', { key: 'radiusDim' },
    ce('line', { x1: sx(0), y1: sy(-DIM_DOWN), x2: sx(workingRadiusX), y2: sy(-DIM_DOWN), stroke: P.dim, strokeWidth: 0.08, markerStart: 'url(#' + markerId + ')', markerEnd: 'url(#' + markerId + ')' }),
    ce('line', { x1: sx(0), y1: gndSY, x2: sx(0), y2: sy(-DIM_DOWN - 0.4), stroke: P.dim, strokeWidth: 0.06, strokeDasharray: '0.3 0.2' }),
    ce('line', { x1: sx(workingRadiusX), y1: gndSY, x2: sx(workingRadiusX), y2: sy(-DIM_DOWN - 0.4), stroke: P.dim, strokeWidth: 0.06, strokeDasharray: '0.3 0.2' }),
    ce('rect', { x: (sx(0) + sx(workingRadiusX)) / 2 - 1.6, y: sy(-DIM_DOWN + 0.5), width: 3.2, height: 0.88, rx: 0.15, fill: P.labelBg }),
    ce('text', { x: (sx(0) + sx(workingRadiusX)) / 2, y: sy(-DIM_DOWN + 0.04), textAnchor: 'middle', fontSize: fs, fill: P.sub }, 'R=' + safeFmt(workingRadiusX, 1) + 'm'));
  var glDim = null;
  if (loadGLH > 0.1) {
    var glDimBaseX = hasJib ? hookBaseX_m : boomTipX;
    glDim = ce('g', { key: 'glDim' },
      ce('line', { x1: sx(glDimBaseX + SVG_DIM_RIGHT * 0.5), y1: sy(0), x2: sx(glDimBaseX + SVG_DIM_RIGHT * 0.5), y2: sy(loadRectBot), stroke: P.dim, strokeWidth: 0.07, markerStart: 'url(#' + markerId + ')', markerEnd: 'url(#' + markerId + ')' }),
      ce('line', { x1: sx(glDimBaseX), y1: sy(0), x2: sx(glDimBaseX + SVG_DIM_RIGHT * 0.5 + 0.3), y2: sy(0), stroke: P.dim, strokeWidth: 0.05, strokeDasharray: '0.2 0.15' }),
      ce('line', { x1: sx(glDimBaseX), y1: sy(loadRectBot), x2: sx(glDimBaseX + SVG_DIM_RIGHT * 0.5 + 0.3), y2: sy(loadRectBot), stroke: P.dim, strokeWidth: 0.05, strokeDasharray: '0.2 0.15' }),
      ce('rect', { x: sx(glDimBaseX + SVG_DIM_RIGHT * 0.5 + 0.4), y: (sy(0) + sy(loadRectBot)) / 2 - 0.42, width: 3.4, height: 0.84, rx: 0.12, fill: P.labelBg }),
      ce('text', { x: sx(glDimBaseX + SVG_DIM_RIGHT * 0.5 + 0.6), y: (sy(0) + sy(loadRectBot)) / 2 + 0.25, fontSize: fsS, fill: P.dim }, '吊荷高さ ' + safeFmt(loadGLH, 1) + 'm'));
  }
  var outrDim = null;
  if (!compact) {
    var outrDimY = sy(-DIM_DOWN * 1.8);
    outrDim = ce('g', { key: 'outrDim' },
      ce('line', { x1: sx(-outr / 2), y1: outrDimY, x2: sx(outr / 2), y2: outrDimY, stroke: P.dim, strokeWidth: 0.07, markerStart: 'url(#' + markerId + ')', markerEnd: 'url(#' + markerId + ')' }),
      ce('line', { x1: sx(-outr / 2), y1: gndSY, x2: sx(-outr / 2), y2: outrDimY - 0.4, stroke: P.dim, strokeWidth: 0.06, strokeDasharray: '0.3 0.2' }),
      ce('line', { x1: sx(outr / 2), y1: gndSY, x2: sx(outr / 2), y2: outrDimY - 0.4, stroke: P.dim, strokeWidth: 0.06, strokeDasharray: '0.3 0.2' }),
      ce('text', { x: sx(0), y: outrDimY - 0.18, textAnchor: 'middle', fontSize: fsS, fill: P.sub }, (isCrawler ? 'キャタピラ幅 ' : 'アウトリガ ') + outr + 'm'));
  }
  var dimensionLayer = ce('g', { key: 'dims' }, heightElem, radiusDim, glDim, outrDim);

  // Layer9: 警告
  var warningLayer = null;
  if (boomHit) {
    warningLayer = ce('g', { key: 'warn' },
      ce('rect', { x: sx(radius / 2) - 3.2, y: sy(boomTipY * 0.7 + 1.6), width: 6.4, height: 1.5, rx: 0.4, fill: 'rgba(239,68,68,0.18)', stroke: P.ng, strokeWidth: 0.10 }),
      ce('text', { x: sx(radius / 2), y: sy(boomTipY * 0.7 + 0.9), textAnchor: 'middle', fontSize: fs, fontWeight: '700', fill: P.ngTxt }, '⚠ 建物干渉あり'));
  }

  return ce('svg', { viewBox: vbStr, style: { width: '100%', height: '100%', display: 'block', overflow: 'visible' }, preserveAspectRatio: 'xMidYMid meet' },
    ce('defs', null,
      ce('marker', { id: markerId, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 4, markerHeight: 4, orient: 'auto-start-reverse' },
        ce('path', { d: 'M2 1L8 5L2 9', fill: 'none', stroke: P.dim, strokeWidth: 1.5, strokeLinecap: 'round' }))),
    bgLayer, buildingLayer, craneBodyLayer, boomLayer, jibLayer, hookLayer, wireLayer, loadLayer, dimensionLayer, warningLayer);
}

// ============================================================
// App — Reactコンポーネント（1個のみ）
// ============================================================
function App() {
  var s = React.useState;

  // ─── state 定義（全てここに集約）───
  var _weight       = s('');    var weight = _weight[0],       setWeight       = _weight[1];
  var _radius       = s('');    var radius = _radius[0],       setRadius       = _radius[1];
  var _boomLen      = s(20);    var boomLen = _boomLen[0],     setBoomLen      = _boomLen[1];
  var _selected     = s(null);  var selected = _selected[0],   setSelected     = _selected[1];
  var _results      = s(null);  var results = _results[0],     setResults      = _results[1];
  var _tab          = s('judge');var tab = _tab[0],            setTab          = _tab[1];
  var _boomIdx      = s(0);     var boomIdx = _boomIdx[0],     setBoomIdx      = _boomIdx[1];
  var _angle        = s(70);    var angle = _angle[0],         setAngle        = _angle[1];
  var _linked       = s(true);  var linked = _linked[0],       setLinked       = _linked[1];
  var _bMode        = s(false); var bMode = _bMode[0],         setBMode        = _bMode[1];
  var _sfPct        = s(80);    var sfPct = _sfPct[0],         setSfPct        = _sfPct[1];
  var _bDist        = s('');    var bDist = _bDist[0],         setBDist        = _bDist[1];
  var _bH           = s('');    var bH = _bH[0],               setBH           = _bH[1];
  var _bWidth       = s('');    var bWidth = _bWidth[0],       setBWidth       = _bWidth[1];
  var _projName     = s('');    var projName = _projName[0],   setProjName     = _projName[1];
  var _docDate      = s(new Date().toISOString().slice(0,10)); var docDate = _docDate[0], setDocDate = _docDate[1];
  var _author       = s('');    var author = _author[0],       setAuthor       = _author[1];
  var _liftH        = s(5);     var liftHeight = _liftH[0],   setLiftHeight   = _liftH[1];
  var _leftW        = s(PANEL_LEFT_DEFAULT);  var leftW = _leftW[0],   setLeftW        = _leftW[1];
  var _rightW       = s(260);   var rightW = _rightW[0],       setRightW       = _rightW[1];
  var _manifestList = s([]);    var manifestList = _manifestList[0], setManifestList = _manifestList[1];
  var _manifestLoaded=s(false); var manifestLoaded=_manifestLoaded[0], setManifestLoaded=_manifestLoaded[1];
  var _craneCache   = s({});    var craneCache = _craneCache[0],  setCraneCache   = _craneCache[1];
  var _rtState      = s({ _craneId: null, outrigger_m: null, counterweight: true, boom_mode: 'normal', jib_m: null, jib_offset: 5, selectedHookId: null });
  var rtState = _rtState[0], setRtState = _rtState[1];
  var _sl850lastRef = useRef(null);  // render中に書き込むのでuseRef（setStateは不可）
  var sl850LastResult = null;       // render中に直接代入される変数
  var _isMobile     = s(window.innerWidth <= 768); var isMobile = _isMobile[0], setIsMobile = _isMobile[1];
  var dragL = useRef(null), dragR = useRef(null);
  var craneCacheRef = useRef({});  // craneCache最新値の参照（useEffect内のstale closure回避）
  var initedCraneRef = useRef(null);  // 自動初期化済みの機種ID（機種変更検出用）

  // ─── App内クロージャ関数 ───

  // manifest entry取得（manifestListをクロージャで参照）
  function getManifestEntry(id) {
    return (manifestList || []).find(function (x) { return x.id === id; }) || null;
  }

  // pickCraneById — 機種選択エントリポイント
  // 1. loadCraneData(id)を呼んでfetch開始
  // 2. その時点のcraneCacheでselectedを暫定セット
  // 3. fetchComplete → setCraneCache → useEffect([craneCache]) で再解決
  function pickCraneById(id) {
    loadCraneData(id);
    setSelected(resolveCrane(id, manifestList, craneCache));
  }

  function pickCrane(crane) { pickCraneById(crane.id); }

  // loadCraneData — meta+loadchart fetchしてcraneCache更新
  function loadCraneData(id) {
    if (!id) return;
    if (craneCache[id] && craneCache[id].loaded) return;

    var mf   = getManifestEntry(id);
    var base = (mf && mf.basePath) ? mf.basePath : ('cranes/' + id + '/');

    var _noCache = { cache: 'no-store' };   // データ更新を必ず反映（キャッシュ迂回）
    fetch(base + 'meta.json', _noCache)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (meta) {
        var files = (meta && meta.data_files) || { boom_normal: 'boom_normal.json', jib: 'jib.json' };
        var hasJibCap = !!(meta && meta.capabilities && meta.capabilities.jib);
        var boomFile = files.boom_normal ? base + files.boom_normal : null;
        var jibFile  = (hasJibCap && files.jib) ? base + files.jib : null;   // ジブ対応機種のみ読込（クローラ等の404回避）
        var fetchBoom = boomFile ? fetch(boomFile, _noCache).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }) : Promise.resolve(null);
        var fetchJib  = jibFile  ? fetch(jibFile, _noCache).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }) : Promise.resolve(null);
        return Promise.all([fetchBoom, fetchJib]).then(function (res) { return { meta: meta, boomNormal: res[0], jib: res[1] }; });
      })
      .then(function (d) {
        setCraneCache(function (prev) {
          var next = Object.assign({}, prev);
          next[id] = {
            meta:     d.meta,
            boom_raw: d.boomNormal || null,
            jib_raw:  d.jib        || null,
            tbl:      d.boomNormal && d.boomNormal.tbl ? d.boomNormal.tbl : null,
            jibData:  d.jib        && d.jib.jibData    ? d.jib.jibData   : null,
            loaded:   true,
            error:    null,
          };
          return next;
        });
      })
      .catch(function (e) {
        setCraneCache(function (prev) {
          var next = Object.assign({}, prev);
          next[id] = { meta: null, boom_raw: null, jib_raw: null, tbl: null, jibData: null, loaded: false, error: String(e) };
          return next;
        });
      });
  }

  // ─── useEffect ─── (4本のみ)

  // 1. manifest fetch（初回のみ）
  React.useEffect(function () {
    fetch('./cranes/manifest.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var list = data.cranes || [];
        setManifestList(list);
        setManifestLoaded(true);
      })
      .catch(function (err) {
        console.error('MANIFEST FETCH ERROR', err);
        setManifestList([]);
        setManifestLoaded(true);
      });
  }, []);

  // 1b. 全機種データを先読み（おすすめ機種の算出に使用）
  React.useEffect(function () {
    if (!manifestList || manifestList.length === 0) return;
    manifestList.forEach(function (m) { loadCraneData(m.id); });
  }, [manifestList]);

  // 2. craneCache更新 → selectedを完全同期
  React.useEffect(function () {
    if (!selected) return;
    var refreshed = resolveCrane(selected.id, manifestList, craneCacheRef.current);
    // 全重要フィールドをlength比較で監視（存在チェック禁止）
    var needsUpdate =
      (selected.hooks             || []).length !== (refreshed.hooks             || []).length ||
      (selected.rtOutriggerOptions|| []).length !== (refreshed.rtOutriggerOptions|| []).length ||
      (selected.rtJibOptions      || []).length !== (refreshed.rtJibOptions      || []).length ||
      (selected.rtBoomModes       || []).length !== (refreshed.rtBoomModes       || []).length ||
      (selected.boomSteps         || []).length !== (refreshed.boomSteps         || []).length ||
      JSON.stringify(selected.capabilities) !== JSON.stringify(refreshed.capabilities);
    if (needsUpdate) {
      setSelected(refreshed);
    }
  }, [craneCache]);

  // 3. selected変更 → 機種が変わったときのみ「最大能力状態」で自動初期化
  //    （同一機種の再レンダリングでは選択状態を保持）
  React.useEffect(function () {
    if (!selected) return;
    var bs = selected.boomSteps || [];
    if (initedCraneRef.current === selected.id) return; // 同一機種 → 選択状態を保持
    if (bs.length === 0) return;                         // データ未着 → ロード後の再実行で初期化
    initedCraneRef.current = selected.id;

    // ── ブーム長: 最長を自動選択 ──
    var _idx = bs.length - 1;
    setBoomIdx(_idx);
    var _bl = bs[_idx];
    setBoomLen(_bl);
    setAngle(70);
    setLinked(true);

    // ── アウトリガ: outrigger_options の最大張出 ──
    var outrOpts = selected.rtOutriggerOptions || [];
    var maxOutr = null;
    for (var oi = 0; oi < outrOpts.length; oi++) {
      var om = outrOpts[oi] && outrOpts[oi].m;
      if (om != null && (maxOutr === null || om > maxOutr)) maxOutr = om;
    }

    // ── フック: 最長ブーム・main で使用可能なフックのうち最大能力 ──
    //    selectedHookは visibleHooks の中からしか解決されないため、
    //    初期ブーム長で使用可能なフックの中から最大tonを選ぶ（未選択化を防ぐ）
    var visMain = getVisibleHooks(selected, false, _bl);
    var bestHook = null;
    for (var hi = 0; hi < visMain.length; hi++) {
      var ht = safeNum(visMain[hi].ton, 0);
      if (bestHook === null || ht > safeNum(bestHook.ton, 0)) bestHook = visMain[hi];
    }

    var d = selected.defaults || {};
    setRtState({
      _craneId:       selected.id,
      outrigger_m:    maxOutr !== null ? maxOutr : (d.outrigger_m !== undefined ? d.outrigger_m : null),
      counterweight:  selected.capabilities && selected.capabilities.counterweight ? true : false,
      boom_mode:      d.boom_mode !== undefined ? d.boom_mode : 'normal',
      jib_m:          null,    // ジブ: 無し
      jib_offset:     d.jib_offset !== undefined ? d.jib_offset : 5,
      selectedHookId: bestHook ? bestHook.id : null,
    });
  }, [selected]);

  // 4. リサイズ + ドラッグ + テーマ保存
  React.useEffect(function () {
    function onResize() { setIsMobile(window.innerWidth <= 768); }
    function onMove(e) {
      if (isMobile) return;
      var clientX = e.touches ? e.touches[0].clientX : e.clientX;
      if (dragL.current !== null) setLeftW(Math.max(PANEL_LEFT_MIN, Math.min(PANEL_LEFT_MAX, clientX - dragL.current)));
      if (dragR.current !== null) setRightW(Math.max(PANEL_RIGHT_MIN, Math.min(PANEL_RIGHT_MAX, dragR.current - clientX)));
    }
    function onUp() { dragL.current = null; dragR.current = null; }
    window.addEventListener('resize', onResize);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return function () {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isMobile]);


  // ─── 計算値 ───
  var safetyFactor = Math.max(0.50, Math.min(1.00, safeNum(sfPct, 80) / 100));
  var r = safeNum(radius, 0), w = safeNum(weight, 0);

  // ブームステップ選択
  var bsArr = selected && selected.boomSteps ? selected.boomSteps : null;
  if (selected && hasCaps(selected)) {
    var _caps = getCaps(selected);
    if (_caps.boom_mode && rtState.boom_mode === 'special' && selected.boomStepsSpecial) {
      bsArr = selected.boomStepsSpecial;
    } else if (rtState.jib_m !== null && selected.rtJibOptions) {
      var _jo = selected.rtJibOptions.find(function (o) { return o.m === rtState.jib_m; });
      if (_jo && _jo.validBooms) bsArr = _jo.validBooms;
    }
  }
  var effectiveBoomSteps = bsArr;
  var bsIdx   = effectiveBoomSteps ? Math.min(Math.max(0, boomIdx), effectiveBoomSteps.length - 1) : 0;
  var curBoom = effectiveBoomSteps ? (effectiveBoomSteps[bsIdx] || 10) : safeNum(boomLen, 20);
  var curMinR = selected ? getMinR(selected, curBoom) : 0;
  var diagR   = linked ? r : boomAngleToRadius(curBoom, angle);
  var angMin  = Math.ceil(radiusToBoomAngle(curBoom, curBoom * 0.98) || 5);
  var angMax  = Math.floor(radiusToBoomAngle(curBoom, Math.max(curMinR, 0.1)) || 88);
  // ── フックシステム（手動選択・推奨なし）──
  var isJibMode = !!(rtState.jib_m !== null && rtState.jib_m !== undefined);

  craneCacheRef.current = craneCache;  // 毎render時に最新値を同期

  // ── hookシステム（getVisibleHooksのみ使用）──
  // selected.hooks → getVisibleHooks → visibleHooks → selectedHook
  var visibleHooks = getVisibleHooks(selected, isJibMode, curBoom);
  if (isJibMode) {
  }

  // selectedHook: rtState.selectedHookIdと一致するフックのみ。fallback禁止。
  var selectedHook = visibleHooks.find(function(h){ return h.id === rtState.selectedHookId; }) || null;

  var hookMass   = selectedHook ? safeNum(selectedHook.weight_t, 0) : 0;
  var hookLength = selectedHook
    ? (isJibMode
        ? safeNum(selectedHook.hookHeight_jib_m  != null ? selectedHook.hookHeight_jib_m  : (selectedHook.hookHeight_boom_m || 2.0), 2.0)
        : safeNum(selectedHook.hookHeight_boom_m != null ? selectedHook.hookHeight_boom_m : 2.0, 2.0))
    : 2.0;

  // updRtGlobal: rtStateを更新する唯一の関数
  function updRtGlobal(fn) { setRtState(function(prev){ return Object.assign({}, prev, typeof fn==='function'?fn(prev):fn); }); }


  // 定格取得
  var curCap = null;
  var _lctx  = selected ? getLookupContext(selected, craneCache) : null;
  var _jibOn = !!(selected && rtState.jib_m !== null && rtState.jib_m !== undefined);
  if (selected && (r > 0 || (_jibOn && angle > 0))) {
    if (selected.engineType === 'sl850') {
      var _outrMm = rtState.outrigger_m ? Math.round(rtState.outrigger_m * 1000) : 7600;
      var _raw    = craneCache[selected.id] || null;
      var _res    = getSL850Capacity({
        outrigger_mm:   _outrMm,
        counterweight:  rtState.counterweight,
        boomMode:       rtState.boom_mode,
        boom_length_m:  curBoom,
        radius_m:       diagR,
        jibLen:         rtState.jib_m,
        jib_offset_deg: rtState.jib_offset,
        boom_angle_deg: angle,
      }, _raw);
      sl850LastResult = _res;   // render中変数に保持（setSl850LastはuseEffect外）
      curCap = (_res && _res.capacity_t !== null) ? _res.capacity_t : null;
    } else if (rtState.jib_m !== null) {
      // ジブ作業: outriggers形式のjib.jsonをSL850Engineで参照（legacy機種対応）
      var _jibRawL = craneCache[selected.id] && craneCache[selected.id].jib_raw;
      if (_jibRawL && _jibRawL.outriggers && typeof SL850Engine !== 'undefined') {
        var _outrMmJibL = rtState.outrigger_m ? Math.round(rtState.outrigger_m * 1000) : 7600;
        var _jresL = SL850Engine.lookupJib({
          data:           _jibRawL,
          outrigger_mm:   _outrMmJibL,
          counterweight:  true,
          base_boom_m:    curBoom,
          jib_length_m:   rtState.jib_m,
          jib_offset_deg: rtState.jib_offset,
          boom_angle_deg: angle,
        });
        curCap = (_jresL && _jresL.capacity_t != null) ? _jresL.capacity_t : null;
      } else if (_lctx && _lctx.jibData) {
        curCap = getJibCapacity(_lctx.crane, rtState.jib_m, rtState.jib_offset, diagR, curBoom);
      }
    } else if (_lctx) {
      // outriggers形式のloadchart（新機種）優先 → 旧tbl形式フォールバック
      var _boomRaw = craneCache[selected.id] && craneCache[selected.id].boom_raw;
      if (_boomRaw && _boomRaw.outriggers) {
        var _outrMmLookup = rtState.outrigger_m ? Math.round(rtState.outrigger_m * 1000) : 7600;
        curCap = lookupBoomNormal(_boomRaw, {
          outrigger_mm:  _outrMmLookup,
          counterweight: rtState.counterweight !== false,
          boom_length_m: curBoom,
          radius_m:      diagR,
        });
      } else {
        curCap = getCapacity(_lctx.crane, diagR);
      }
    }
  }
  var curReq = curCap !== null ? (w + hookMass) / safetyFactor : null;
  var curOk  = curCap !== null && curCap >= curReq;
  var curMg  = curCap !== null && curReq > 0 ? (curCap / curReq - 1) * 100 : null;
  var diagH  = Math.max(0, calcHeight(curBoom, angle) - hookLength);

  // 建物干渉判定（断面図と同一の幾何で算出。クレーン中心基準の固定建物）
  function computeInterference() {
    var bldOnX = bMode && bDist !== '' && bH !== '';
    if (!bldOnX || !selected) return { state: 'na', label: '—' };
    var BASEh = (typeof SVG_BASE_HEIGHT !== 'undefined') ? SVG_BASE_HEIGHT : 2.0;
    var bd = safeNum(bDist, 0), bh = safeNum(bH, 0), bw = safeNum(bWidth, 0) || 10;
    if (bd <= 0 || bh <= 0) return { state: 'na', label: '—' };
    var rx1 = bd, rx2 = bd + bw, ry1 = 0, ry2 = bh;  // 建物矩形（y上向き・GL基準）
    var ang = safeNum(angle, 70) * DEG_TO_RAD;
    // フートピン位置（機種ごと。未設定はデフォルト）
    var fX = (selected.boomFootX != null) ? selected.boomFootX : 0;
    var fY = (selected.boomFootY != null) ? selected.boomFootY : BASEh;
    var btx = fX + curBoom * Math.cos(ang), bty = fY + curBoom * Math.sin(ang);
    var pts = [[fX, fY], [btx, bty]];
    var tipX = btx, tipY = bty;
    if (isJibMode && rtState.jib_m) {
      var jdeg = (safeNum(angle, 70) - safeNum(rtState.jib_offset, 0)) * DEG_TO_RAD;
      tipX = btx + safeNum(rtState.jib_m, 0) * Math.cos(jdeg);
      tipY = bty + safeNum(rtState.jib_m, 0) * Math.sin(jdeg);
      pts.push([tipX, tipY]);
    }
    pts.push([tipX, Math.max(0, safeNum(liftHeight, 0))]);  // ワイヤ＋吊荷
    function ptRectDist(px, py) {
      var dx = Math.max(rx1 - px, 0, px - rx2);
      var dy = Math.max(ry1 - py, 0, py - ry2);
      return Math.sqrt(dx * dx + dy * dy);
    }
    var minClr = Infinity;
    for (var i = 0; i < pts.length - 1; i++) {
      var ax = pts[i][0], ay = pts[i][1], bx = pts[i + 1][0], by = pts[i + 1][1];
      for (var k = 0; k <= 48; k++) {
        var t = k / 48;
        var d = ptRectDist(ax + (bx - ax) * t, ay + (by - ay) * t);
        if (d < minClr) minClr = d;
      }
    }
    if (minClr <= 0.001) return { state: 'hit', label: '⚠ 干渉あり', clr: 0 };
    if (minClr < 1.0)     return { state: 'warn', label: '△ 接触注意', clr: minClr };
    return { state: 'ok', label: '✓ 干渉なし', clr: minClr };
  }
  var bldInterf = computeInterference();

  // 検索
  function doSearch() {
    var wv = parseFloat(weight), rv = parseFloat(radius);
    if (!wv || !rv || !manifestList || manifestList.length === 0) { setResults([]); setTab('results'); return; }
    var list = manifestList.map(function (m) {
      var resolved = resolveCrane(m.id, manifestList, craneCache);
      var bs2 = resolved.boomSteps;
      if (!bs2 || bs2.length === 0) return null;
      var midBl = bs2[Math.floor(bs2.length / 2)];
      var _vis2 = getVisibleHooks(resolved, false, midBl);
      var hk2   = _vis2[0] || { weight_t: 0 }; // 先頭フックで概算（検索用）
      var tot2  = wv + safeNum(hk2.weight_t, 0);
      var req2  = tot2 / safetyFactor;
      var cap2  = 0;
      if (resolved.engineType === 'sl850') {
        var _outrMm2 = resolved.defaults && resolved.defaults.outrigger_m ? Math.round(resolved.defaults.outrigger_m * 1000) : 7600;
        var _res2 = getSL850Capacity({ outrigger_mm: _outrMm2, counterweight: true, boomMode: 'normal', boom_length_m: midBl, radius_m: rv, jibLen: null, jib_offset_deg: 5, boom_angle_deg: 70 }, craneCache[m.id] || null);
        cap2 = (_res2 && _res2.capacity_t !== null) ? _res2.capacity_t : 0;
      } else {
        // outriggers形式のloadchart（新機種）優先 → 旧tbl形式フォールバック
        var _boomRaw2 = craneCache[m.id] && craneCache[m.id].boom_raw;
        if (_boomRaw2 && _boomRaw2.outriggers) {
          var _outrMm3 = resolved.defaults && resolved.defaults.outrigger_m
            ? Math.round(resolved.defaults.outrigger_m * 1000) : 7600;
          cap2 = lookupBoomNormal(_boomRaw2, {
            outrigger_mm:  _outrMm3,
            counterweight: true,
            boom_length_m: midBl,
            radius_m:      rv,
          }) || 0;
        } else {
          cap2 = getCapacity(resolved, rv);
        }
      }
      var mg2 = req2 > 0 ? (cap2 / req2 - 1) * 100 : 0;
      return { crane: resolved, hook: hk2, total: tot2, req: req2, cap: cap2, ok: cap2 >= req2, mg: mg2 };
    }).filter(function (x) { return x !== null && x.cap > 0; }).sort(function (a, b) { return a.crane.cap - b.crane.cap; });
    setResults(list);
    setTab('results');
  }

  // ── TYPE CHECK（デバッグ用）──

  // ─── UI ───
  // 左パネル
  var leftPanel = ce('div', { className: 'left-panel', style: { width: isMobile ? '100%' : leftW } },
    ce('div', { className: 'panel-section-label' }, '1. 吊荷条件'),
    ce('div', { className: 'input-row' },
      ce('label', { className: 'input-row-label' }, '吊荷重量'),
      ce('input', { type: 'number', value: weight, placeholder: '例：5.0', className: 'input-row-input', onChange: function (e) { setWeight(e.target.value); } }),
      ce('span', { className: 'input-row-unit' }, 't')),
    ce('div', { className: 'input-row' },
      ce('label', { className: 'input-row-label' }, '作業半径 (R)'),
      ce('input', { type: 'number', value: radius, placeholder: '例：15.0', className: 'input-row-input', onChange: function (e) { setRadius(e.target.value); } }),
      ce('span', { className: 'input-row-unit' }, 'm')),
    ce('div', { className: 'input-row' },
      ce('label', { className: 'input-row-label' }, '安全率'),
      ce('input', { type: 'number', value: sfPct, min: 50, max: 100, step: 1, className: 'input-row-input', onChange: function (e) { var v = parseInt(e.target.value, 10); if (!isNaN(v)) setSfPct(Math.max(50, Math.min(100, v))); } }),
      ce('span', { className: 'input-row-unit' }, '%')),
    ce('button', { onClick: doSearch, disabled: !w || !r, className: 'btn-search' }, '🔍 機種を検索'),
    w > 0 && r > 0 ? ce('div', { className: 'req-box' },
      ce('div', { style: { fontSize: '11px', color: '#5b6776' } }, '必要定格荷重（安全率' + Math.round(safetyFactor * 100) + '%）'),
      ce('div', { className: 'req-box-value' }, safeFmt(w / safetyFactor, 2) + ' t以上'),
      ce('div', { className: 'req-box-note' }, '※フック重量は機種ごとに加算')) : null,
    // 2. 機種選定
    ce('div', { className: 'section-divider' },
      ce('div', { className: 'panel-section-label' }, '2. 機種選定'),
      selected ? ce('div', { className: 'selected-crane-box' },
        ce('div', { className: 'scb-name' }, selected.name),
        ce('div', { className: 'scb-row' }, ce('span', null, '吊上能力'), ce('b', null, safeFmt(selected.cap, 1) + ' t')),
        ce('div', { className: 'scb-row' }, ce('span', null, 'ブーム最大'), ce('b', null, (selected.boomSteps && selected.boomSteps.length ? selected.boomSteps[selected.boomSteps.length - 1] : '—') + ' m')),
        ce('div', { className: 'scb-row' }, ce('span', null, '最大作業半径(ブーム)'), ce('b', null, (selected.maxRBoom != null ? selected.maxRBoom : '—') + ' m')),
        selected.maxRJib != null ? ce('div', { className: 'scb-row' }, ce('span', null, '最大作業半径(ジブ)'), ce('b', null, selected.maxRJib + ' m')) : null) : null,
      ce('div', { style: { marginTop: '8px' } },
        manifestList.length === 0
          ? ce('div', { style: { fontSize: '11px', color: '#8a95a3', padding: '4px 0' } }, '読込中…')
          : manifestList.map(function (m) {
              var isSel = selected && selected.id === m.id;
              return ce('div', { key: m.id, className: 'crane-list-item' + (isSel ? ' selected' : ''), onClick: function () { pickCraneById(m.id); } },
                ce('span', { className: 'crane-list-icon' }, m.vehicleType === 'crawler' ? '⚙' : m.vehicleType === 'allterrain' ? '🔵' : '🟡'),
                ce('span', null, m.name));
            }))),
    // 3. 建物・障害物
    ce('div', { className: 'section-divider' },
      ce('div', { className: 'panel-section-label' }, '3. 建物・障害物'),
      ce('div', { className: 'building-toggle' },
        ce('button', { className: 'building-btn' + (!bMode ? ' active' : ''), onClick: function () { setBMode(false); } }, '建物無し'),
        ce('button', { className: 'building-btn' + (bMode ? ' active' : ''), onClick: function () { setBMode(true); } }, '建物有り')),
      bMode ? ce('div', null,
        ce('div', { className: 'input-row' },
          ce('label', { className: 'input-row-label' }, '建物高さ (GL)'),
          ce('input', { type: 'number', value: bH, min: '0', step: '0.5', placeholder: '例：20', className: 'input-row-input', onChange: function (e) { setBH(e.target.value); } }),
          ce('span', { className: 'input-row-unit' }, 'm')),
        ce('div', { className: 'input-row' },
          ce('label', { className: 'input-row-label' }, '建物幅'),
          ce('input', { type: 'number', value: bWidth, min: '0', step: '0.5', placeholder: '例：15', className: 'input-row-input', onChange: function (e) { setBWidth(e.target.value); } }),
          ce('span', { className: 'input-row-unit' }, 'm')),
        ce('div', { className: 'input-row' },
          ce('label', { className: 'input-row-label' }, '建物までの離隔'),
          ce('input', { type: 'number', value: bDist, min: '0', step: '0.5', placeholder: '例：3', className: 'input-row-input', onChange: function (e) { setBDist(e.target.value); } }),
          ce('span', { className: 'input-row-unit' }, 'm'))) : null));

  // 中央パネル
  var diagramContent;
  if (!w || !r || !selected) {
    diagramContent = ce('div', { className: 'empty-state' }, ce('div', { className: 'icon' }, '🏗'), ce('div', { className: 'text' }, '吊荷重量・作業半径を入力して機種を選択'));
  } else {
    var svgPalette  = getSvgPalette('white', 'black');
    var svgOutrigger = (rtState.outrigger_m !== null && rtState.outrigger_m !== undefined) ? rtState.outrigger_m : (selected.outrigger || null);
    diagramContent = buildSVG(selected, diagR, w, curBoom, selectedHook,
      bMode ? bDist : '', bMode ? bH : '', bMode ? (safeNum(bWidth, 0) || 10) : 0,
      false, safetyFactor, liftHeight, isJibMode, svgPalette,
      rtState.jib_m, rtState.jib_offset, svgOutrigger, angle);
  }

  var boomBtns = null;
  if (selected && effectiveBoomSteps) {
    boomBtns = ce('div', { className: 'control-group' },
      ce('div', { className: 'control-label' }, 'ブーム長'),
      ce('div', { className: 'boom-btn-group' },
        effectiveBoomSteps.map(function (b, i) {
          return ce('button', {
            key: b, className: 'boom-btn' + (boomIdx === i ? ' active' : ''),
            onClick: function () {
              setBoomIdx(i); setBoomLen(b);
              if (linked && r > 0) {
                var mR = getMinR(selected, b);
                var a2 = radiusToBoomAngle(b, Math.min(Math.max(r, mR), b * 0.99));
                if (a2) setAngle(parseFloat(a2.toFixed(1)));
              }
            }
          }, b + 'm');
        })));
  }

  // hookBtns: visibleHooks をそのまま表示。selectedHookの有無で消さない。
  var hookBtns = visibleHooks.length > 0
    ? ce('div', { className: 'control-group' },
        ce('div', { className: 'control-label' },
          isJibMode ? '🔧 ジブフック' : '🔧 フック'),
        ce('div', { className: 'hook-btn-scroll' },
          ce('div', { className: 'hook-btn-group' },
            visibleHooks.map(function (h) {
              var isActive = (rtState.selectedHookId === h.id);
              return ce('button', {
                key: 'hook_' + h.id,
                className: 'hook-btn' + (isActive ? ' active' : ''),
                onClick: function () {
                  updRtGlobal({ selectedHookId: h.id });
                }
              },
                ce('div', { style: { fontWeight: 700, fontSize: '11px' } }, h.name),
                ce('div', { style: { fontSize: '9px', color: isActive ? '#93c5fd' : '#475569', marginTop: '2px' } },
                  (isJibMode
                  ? (h.hookHeight_jib_m  != null ? h.hookHeight_jib_m.toFixed(2)  : '—')
                  : (h.hookHeight_boom_m != null ? h.hookHeight_boom_m.toFixed(2) : '—')
                ) + 'm  ' + (h.weight_t || 0) + 't'));
            }))),
        rtState.selectedHookId === null
          ? ce('div', { style: { fontSize: '9px', color: '#f87171', marginTop: '3px', padding: '2px 4px' } },
              '⚠ フックを選択してください')
          : null)
    : ce('div', { className: 'control-group' },
        ce('div', { className: 'control-label' }, '🔧 フック'),
        ce('div', { style: { fontSize: '9px', color: '#64748b', padding: '4px' } }, '使用可能フックなし'));

  var infoBar = selected && w > 0 ? ce('div', { className: 'info-bar' },
    [{ l: 'ブーム長', v: curBoom + 'm' }, { l: '角度', v: safeFmt(angle, 1) + '°' }, { l: '揚程', v: 'H=' + safeFmt(diagH, 1) + 'm' }, { l: 'フック', v: selectedHook ? selectedHook.name + ' (' + safeFmt(hookMass, 3) + 't)' : '未選択' }, { l: '計算荷重', v: safeFmt(w + hookMass, 2) + 't' }, { l: '必要定格', v: safeFmt(curReq, 2) + 't' }]
      .concat((rtState.jib_m !== null && rtState.jib_m !== undefined) ? [{ l: 'ジブ', v: rtState.jib_m + 'm Off' + rtState.jib_offset + '°' }] : [])
      .map(function (item) { return ce('div', { key: item.l, className: 'info-card' }, ce('div', { className: 'info-card-label' }, item.l), ce('div', { className: 'info-card-value' }, item.v)); })) : null;

  // ── 揚重条件設定パネル（統合）──
  // 順序: アウトリガ → (CW/ブームモード) → ジブ → オフセット角 → フック → ブーム長 → ブーム角度 → 吊荷下端高さ
  var liftPanel = null;
  if (selected) {
    var sp  = selected, sup = getCaps(sp);
    var _outrOpts  = sp.rtOutriggerOptions || [];
    var _jibOpts   = sp.rtJibOptions       || [];
    var _boomModes = sp.rtBoomModes        || [{ key: 'normal', label: '通常伸縮' }];
    var _selJib2   = _jibOpts.find(function (o) { return o.m === rtState.jib_m; });
    var _offsets   = _selJib2 ? (_selJib2.offsets || [5, 25, 45, 60]) : [5, 25, 45, 60];

    // ブーム角度コントロール（R連動トグル内蔵）
    var angleControl = ce('div', { className: 'control-group', style: { minWidth: '160px', flex: '1 1 160px' } },
      ce('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        ce('span', { className: 'control-label' }, 'ブーム角度'),
        ce('span', { style: { fontSize: '11px', fontWeight: 600, color: COLOR.warningText } }, safeFmt(angle, 1) + '°')),
      ce('input', { type: 'range', min: angMin, max: angMax, step: 0.5, value: angle, style: { width: '100%', accentColor: COLOR.accent }, onChange: function (e) { setLinked(false); var v = parseFloat(e.target.value); setAngle(Math.min(Math.max(v, angMin), angMax)); } }),
      ce('button', { className: 'link-btn' + (linked ? ' linked' : ''), style: { marginTop: '4px' }, onClick: function () { var nl = !linked; setLinked(nl); if (nl && r > 0) { var a3 = radiusToBoomAngle(curBoom, r); if (a3) setAngle(parseFloat(a3.toFixed(1))); } } }, linked ? '🔗R連動' : '🔓手動'));

    // 吊荷下端高さ（荷重入力時のみ）
    var heightControl = (selected && w > 0) ? ce('div', { className: 'control-group', style: { minWidth: '160px', flex: '1 1 160px' } },
      ce('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        ce('span', { className: 'control-label' }, '吊荷高さ'),
        ce('span', { style: { fontSize: '11px', fontWeight: 600, color: COLOR.boomOk } }, safeFmt(liftHeight, 1) + ' m')),
      ce('input', { type: 'range', min: 0, max: Math.max(0, Math.floor(Math.max(0, diagH - hookLength) * 10) / 10), step: 0.1, value: Math.min(liftHeight, Math.max(0, diagH - hookLength)), style: { width: '100%', accentColor: COLOR.boomOk }, onChange: function (e) { var v = parseFloat(e.target.value); var maxH = Math.max(0, diagH - hookLength); if (!isNaN(v)) setLiftHeight(Math.max(0, Math.min(v, maxH))); } })) : null;

    liftPanel = ce('div', { className: 'control-group sl850-panel' },
      ce('div', { className: 'sl850-panel-title' }, '⚙ 揚重条件設定 — ' + sp.name),
      // 上段: アウトリガ / CW / ブームモード / ジブ / オフセット角
      ce('div', { className: 'sl850-grid' },
        // 1. アウトリガ
        sup.outrigger && _outrOpts.length > 0 ? ce('div', { className: 'sl850-cell sl850-cell-full' },
          ce('div', { className: 'control-label' }, 'アウトリガ張出'),
          ce('div', { className: 'boom-btn-group' },
            _outrOpts.map(function (opt) {
              return ce('button', { key: 'outr_' + opt.m, className: 'boom-btn' + (rtState.outrigger_m === opt.m ? ' active' : ''), onClick: function () { updRtGlobal({ outrigger_m: opt.m }); } }, opt.label);
            }))) : null,
        // CW付/無（SL-850Rf等のみ）
        sup.counterweight ? ce('div', { className: 'sl850-cell' },
          ce('div', { className: 'control-label' }, 'カウンタウエイト'),
          ce('div', { className: 'jib-seg-group' },
            ce('button', { className: 'jib-seg-btn' + (rtState.counterweight ? ' active' : ''), onClick: function () { updRtGlobal({ counterweight: true }); } }, 'CW付'),
            ce('button', { className: 'jib-seg-btn' + (!rtState.counterweight ? ' active' : ''), onClick: function () { updRtGlobal({ counterweight: false, boom_mode: 'normal', jib_m: null }); } }, 'CW無'))) : null,
        // ブームモード（該当機種のみ）
        sup.boom_mode ? ce('div', { className: 'sl850-cell' },
          ce('div', { className: 'control-label' }, 'ブームモード'),
          ce('div', { className: 'jib-seg-group' },
            _boomModes.map(function (opt) {
              var dis = !rtState.counterweight && opt.key === 'special';
              return ce('button', { key: opt.key, className: 'jib-seg-btn' + (rtState.boom_mode === opt.key ? ' active' : '') + (dis ? ' disabled' : ''), disabled: dis, onClick: function () { if (!dis) { updRtGlobal({ boom_mode: opt.key, jib_m: null }); setBoomIdx(0); } } }, opt.label);
            }))) : null,
        // 2. ジブ
        sup.jib && _jibOpts.length > 0 ? ce('div', { className: 'sl850-cell' },
          ce('div', { className: 'control-label' }, 'ジブ'),
          ce('div', { className: 'jib-seg-group' },
            ce('button', { className: 'jib-seg-btn' + (rtState.jib_m === null ? ' active' : ''), onClick: function () { updRtGlobal({ jib_m: null, jib_offset: 5, selectedHookId: null }); } }, '無し'),
            (sup.boom_mode && (!rtState.counterweight || rtState.boom_mode !== 'normal') ? [] : _jibOpts).map(function (opt) {
              return ce('button', { key: 'jib_' + opt.m, className: 'jib-seg-btn' + (rtState.jib_m === opt.m ? ' active' : ''), onClick: function () {
                // ジブ取付可能なブーム長を自動選択（最長＝最も一般的な組み合わせ）
                var vb = (opt.validBooms && opt.validBooms.length) ? opt.validBooms : null;
                var newBoom = vb ? vb[vb.length - 1] : curBoom;
                if (vb) setBoomIdx(vb.length - 1);
                // ジブ用フックを自動選択（既定フック→無ければ先頭の有効候補）
                var jHooks = getVisibleHooks(selected, true, newBoom);
                var defId  = selected.jibHookDefault;
                var jHook  = jHooks.find(function (h) { return h.id === defId; }) || jHooks[0] || null;
                updRtGlobal({ jib_m: opt.m, jib_offset: opt.offsets ? opt.offsets[0] : 5, selectedHookId: jHook ? jHook.id : null });
              } }, opt.label);
            }))) : null,
        // 3. オフセット角
        rtState.jib_m !== null ? ce('div', { className: 'sl850-cell sl850-cell-full' },
          ce('div', { className: 'control-label' }, 'オフセット角'),
          ce('div', { className: 'jib-angle-group' },
            _offsets.map(function (ang) {
              return ce('button', { key: 'off_' + ang, className: 'jib-angle-btn' + (rtState.jib_offset === ang ? ' active' : ''), onClick: function () { updRtGlobal({ jib_offset: ang }); } }, ang + '°');
            })),
          ce('div', { className: 'jib-active-note' }, '⚑ ジブ使用中 — Off' + rtState.jib_offset + '° — ブーム角度で定格参照')) : null),
      // 下段: フック → ブーム長 → ブーム角度 → 吊荷下端高さ
      hookBtns,
      boomBtns,
      angleControl,
      heightControl,
      // lookupトレース
      sl850LastResult && sl850LastResult.trace && sl850LastResult.trace.length > 0 && r > 0
        ? ce('div', { className: 'sl850-trace' },
            sl850LastResult.trace.map(function (t, i) { return ce('div', { key: i }, t); }),
            sl850LastResult.reason ? ce('div', { style: { color: '#f87171', marginTop: '2px' } }, '⚠ ' + sl850LastResult.reason) : null)
        : null);
  }

  var centerPanel = ce('div', { className: 'center-panel' },
    ce('div', { className: 'diagram-header' },
      selected ? ce('span', { className: 'diagram-title' }, selected.name) : ce('span', { className: 'diagram-title', style: { color: '#8a95a3' } }, '機種を選択してください'),
      selected && curCap !== null ? ce('span', { className: 'badge ' + (curOk ? 'badge-ok' : 'badge-warn') }, curOk ? '✓ 作業可能 +' + safeFmt(curMg, 1) + '%' : '✗ 能力不足') : null,
      diagR > 0 && curMinR > 0 && diagR < curMinR ? ce('span', { className: 'badge badge-warn' }, '⚠️ 最小R未満') : null),
    ce('div', { className: 'center-body' },
      selected ? ce('div', { className: 'control-section no-print' }, liftPanel, infoBar) : null,
      ce('div', { className: 'diagram-section' },
        ce('div', { className: 'svg-area' }, diagramContent),
        ce('div', { className: 'diagram-note no-print' }, '※ 数値は目安です。実際の作業では必ず現場条件を確認してください。'))));

  // 右パネル
  // おすすめ機種をライブ算出（入力した吊荷重量・作業半径・揚程を満たす機種を候補順に）
  function computeRecommend() {
    var wv = parseFloat(weight), rv = parseFloat(radius);
    if (!wv || !rv || !manifestList || manifestList.length === 0) return null;
    var list = manifestList.map(function (m) {
      var resolved = resolveCrane(m.id, manifestList, craneCacheRef.current);
      var bs2 = resolved.boomSteps;
      if (!bs2 || bs2.length === 0) return null;
      // 検索条件は「吊荷重量・作業半径」のみ（揚程は選定後にスライダーで調整）
      // 最長ブームで作業半径の定格を取得（最大能力で判定）
      var topBl = bs2[bs2.length - 1];
      var _vis2 = getVisibleHooks(resolved, false, topBl);
      var hk2   = _vis2.reduce(function (a, b) { return safeNum(b.weight_t, 0) < safeNum((a || {}).weight_t, 9) ? b : (a || b); }, null) || { weight_t: 0 };
      var tot2  = wv + safeNum(hk2.weight_t, 0);
      var req2  = tot2 / safetyFactor;
      var cap2  = 0;
      var _outrMm2 = resolved.defaults && resolved.defaults.outrigger_m ? Math.round(resolved.defaults.outrigger_m * 1000) : 7600;
      if (resolved.engineType === 'sl850') {
        var _res2 = getSL850Capacity({ outrigger_mm: _outrMm2, counterweight: true, boomMode: 'normal', boom_length_m: topBl, radius_m: rv, jibLen: null, jib_offset_deg: 5, boom_angle_deg: 70 }, craneCacheRef.current[m.id] || null);
        cap2 = (_res2 && _res2.capacity_t !== null) ? _res2.capacity_t : 0;
      } else {
        var _boomRaw2 = craneCacheRef.current[m.id] && craneCacheRef.current[m.id].boom_raw;
        if (_boomRaw2 && _boomRaw2.outriggers) {
          cap2 = lookupBoomNormal(_boomRaw2, { outrigger_mm: _outrMm2, counterweight: true, boom_length_m: topBl, radius_m: rv }) || 0;
        } else { cap2 = getCapacity(resolved, rv); }
      }
      if (cap2 <= 0) return null;
      var usage = cap2 > 0 ? (req2 / cap2 * 100) : 999;
      var mg = req2 > 0 ? (cap2 / req2 - 1) * 100 : 0;
      return { crane: resolved, cap: cap2, req: req2, usage: usage, mg: mg, ok: cap2 >= req2 };
    }).filter(function (x) { return x !== null; });
    // 使用可能な機種のみ → ①最小クラス順（cap昇順）②使用率③余裕
    var okList = list.filter(function (x) { return x.ok; }).sort(function (a, b) {
      if (a.crane.cap !== b.crane.cap) return a.crane.cap - b.crane.cap;  // ① 最小クラス
      if (a.usage !== b.usage) return a.usage - b.usage;                  // ② 低使用率
      return b.mg - a.mg;                                                 // ③ 大余裕
    });
    return okList;
  }

  var recommendContent, judgeContent;
  {
    var recs = computeRecommend();
    if (!recs) {
      recommendContent = ce('div', { className: 'empty-state', style: { height: '200px' } }, ce('div', { className: 'icon' }, '🏗'), ce('div', { className: 'text' }, '吊荷重量・作業半径を入力してください'));
    } else if (recs.length === 0) {
      recommendContent = ce('div', null,
        ce('div', { className: 'judge-card judge-card-main ng' },
          ce('div', { className: 'judge-main-status' }, '該当機種なし'),
          ce('div', { className: 'judge-main-sub' }, '入力条件（' + w + 't / R' + r + 'm）を満たす機種がありません')));
    } else {
      recommendContent = ce('div', null,
        ce('div', { className: 'result-header' },
          ce('span', null, 'おすすめ機種'),
          ce('span', { style: { color: '#5b6776' } }, w + 't / R' + r + 'm')),
        recs.map(function (x, i) {
          var uColor = x.usage >= 90 ? COLOR.warning : COLOR.successText;
          return ce('div', { key: x.crane.id, className: 'result-card', onClick: function () { pickCrane(x.crane); } },
            ce('div', { style: { fontSize: '15px', fontWeight: 800, color: COLOR.primary, width: '20px', textAlign: 'center' } }, (i + 1)),
            ce('div', { style: { flex: 1 } },
              ce('div', { className: 'result-name' }, x.crane.name),
              ce('div', { className: 'result-detail' }, '定格 ' + safeFmt(x.cap, 2) + 't　余裕 +' + safeFmt(x.mg, 0) + '%')),
            ce('div', { className: 'result-cap' },
              ce('div', { className: 'result-cap-val', style: { color: uColor } }, '使用率'),
              ce('div', { style: { fontSize: '17px', fontWeight: 800, color: uColor } }, safeFmt(x.usage, 0) + '%')));
        }));
    }
  }
  {
    if (!selected || !w || !r) {
      judgeContent = ce('div', { className: 'empty-state', style: { height: '200px' } }, ce('div', { className: 'icon' }, '📊'), ce('div', { className: 'text' }, '機種・条件を入力してください'));
    } else {
      var usageRate  = curCap > 0 ? (curReq / curCap * 100) : 0;
      var usageColor = usageRate >= 100 ? COLOR.dangerText : usageRate >= 80 ? COLOR.warning : COLOR.successText;
      var residual   = (curCap !== null && curReq !== null) ? (curCap - curReq) : null;
      var bldOn       = bMode && bDist !== '' && bH !== '';
      var details = [
        ['安全率', Math.round(safetyFactor * 100) + '%'], ['機種名', selected.name], ['種別', selected.type || ''],
        ['吊荷重量', safeFmt(w, 2) + ' t'], ['フック重量', safeFmt(hookMass, 3) + ' t'], ['フック長', safeFmt(hookLength, 3) + ' m'],
        ['計算荷重', safeFmt(w + hookMass, 2) + ' t'], ['作業半径', safeFmt(diagR, 1) + ' m'], ['ブーム長', curBoom + ' m'],
        ['ブーム角度', safeFmt(angle, 1) + '°'], ['揚程 (H)', 'H=' + safeFmt(diagH, 1) + ' m'], ['吊荷高さ', safeFmt(liftHeight, 1) + ' m'],
        rtState.jib_m !== null ? ['ジブ構成', rtState.jib_m + 'm Off' + rtState.jib_offset + '°'] : ['ジブ', '無し'],
        ['必要定格', safeFmt(curReq, 2) + ' t'], ['実定格', safeFmt(curCap, 2) + ' t'],
        selected.vehicleType === 'crawler' ? ['キャタピラ幅', (selected.crawlerWidth || 2.23) + ' m'] : ['アウトリガ', (rtState.outrigger_m || selected.outrigger || '—') + ' m'],
      ];
      if (bldOn) details.push(['建物高さ', bH + ' m'], ['建物幅', (bWidth || '—') + ' m'], ['建物までの距離', bDist + ' m']);
      judgeContent = ce('div', null,
        // 判定カード（大）
        ce('div', { className: 'judge-card judge-card-main ' + (curOk ? 'ok' : 'ng') },
          ce('div', { className: 'judge-main-status' }, curOk ? '✓ 作業可能' : '✗ 作業不可'),
          ce('div', { className: 'judge-main-sub' }, '余裕 ' + (curOk ? '+' : '') + safeFmt(curMg, 1) + '%　/　定格 ' + safeFmt(curCap, 2) + 't')),
        // 使用率
        ce('div', { className: 'judge-card' },
          ce('div', { className: 'judge-card-label' }, '使用率'),
          ce('div', { className: 'judge-card-value', style: { color: usageColor } }, safeFmt(usageRate, 1) + ' %'),
          ce('div', { className: 'usage-bar-bg' }, ce('div', { className: 'usage-bar-fill', style: { width: Math.min(100, usageRate) + '%', background: usageRate >= 100 ? COLOR.danger : usageRate >= 80 ? COLOR.warning : COLOR.success } })),
          ce('div', { className: 'judge-card-sub' }, '必要 ' + safeFmt(curReq, 2) + 't　実定格 ' + safeFmt(curCap, 2) + 't')),
        // 安全余裕
        ce('div', { className: 'judge-card' },
          ce('div', { className: 'judge-card-label' }, '安全余裕'),
          ce('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
            ce('span', { className: 'judge-card-value', style: { fontSize: '20px', color: curOk ? COLOR.successText : COLOR.dangerText } }, (curMg >= 0 ? '+' : '') + safeFmt(curMg, 1) + ' %'),
            ce('span', { className: 'judge-card-sub' }, '残能力 ' + safeFmt(residual, 2) + ' t'))),
        // 建物干渉
        bldOn ? ce('div', { className: 'judge-card' },
          ce('div', { className: 'judge-card-label' }, '建物干渉'),
          ce('div', { style: { fontSize: '18px', fontWeight: 800, marginTop: '2px', color: bldInterf.state === 'hit' ? COLOR.dangerText : bldInterf.state === 'warn' ? COLOR.warning : COLOR.successText } }, bldInterf.label),
          ce('div', { className: 'judge-card-sub', style: { marginTop: '2px' } }, '建物まで ' + bDist + 'm　高さ ' + bH + 'm' + (bldInterf.clr !== undefined && bldInterf.state !== 'hit' ? '　最小クリアランス ' + safeFmt(bldInterf.clr, 1) + 'm' : ''))) : null,
        // 詳細スペック（折りたたみ）
        ce('details', { className: 'spec-fold' },
          ce('summary', null, '詳細スペック'),
          ce('div', { className: 'judge-detail-table' },
            details.map(function (pair) { return ce('div', { key: pair[0], className: 'judge-detail-row' }, ce('span', { className: 'judge-detail-label' }, pair[0]), ce('span', { className: 'judge-detail-value' }, pair[1])); }))));
    }
  }

  var rightPanel = ce('div', { className: 'right-panel', style: { width: isMobile ? '100%' : rightW } },
    isMobile
      ? ce('div', null,
          ce('div', { className: 'mobile-sec-label' }, '判定結果'),
          judgeContent,
          ce('div', { className: 'mobile-sec-label' }, 'おすすめ機種'),
          recommendContent)
      : ce('div', null,
          ce('div', { className: 'tab-bar no-print' },
            ce('button', { className: 'tab-btn' + (tab === 'results' ? ' active' : ''), onClick: function () { setTab('results'); } }, '🔍 結果'),
            ce('button', { className: 'tab-btn' + (tab === 'judge' ? ' active' : ''), onClick: function () { setTab('judge'); } }, '📊 判定')),
          ce('div', { className: 'tab-content' }, tab === 'results' ? recommendContent : judgeContent)));

  // ===== 印刷専用シート（PDF提出用・画面では非表示） =====
  var printSheet = null;
  if (selected && w > 0 && r > 0) {
    var pUsage = curCap > 0 ? (curReq / curCap * 100) : 0;
    var pResid = (curCap !== null && curReq !== null) ? (curCap - curReq) : null;
    var pBldOn = bMode && bDist !== '' && bH !== '';
    var pRows = [
      ['機種名', selected.name],
      [selected.vehicleType === 'crawler' ? 'キャタピラ幅' : 'アウトリガ張出', (selected.vehicleType === 'crawler' ? (selected.crawlerWidth || 2.23) : (rtState.outrigger_m || selected.outrigger || '—')) + ' m'],
      ['ブーム長', curBoom + ' m'],
      ['ブーム角度', safeFmt(angle, 1) + '°'],
      ['ジブ仕様', rtState.jib_m !== null ? (rtState.jib_m + 'm / オフセット' + rtState.jib_offset + '°') : '無し'],
      ['フック仕様', selectedHook ? (selectedHook.name + '（' + safeFmt(hookMass, 3) + 't）') : '未選択'],
      ['吊荷重量', safeFmt(w, 2) + ' t'],
      ['必要定格荷重', safeFmt(curReq, 2) + ' t'],
      ['実定格荷重', safeFmt(curCap, 2) + ' t'],
      ['作業半径 (R)', safeFmt(diagR, 1) + ' m'],
      ['揚程 (H)', 'H=' + safeFmt(diagH, 1) + ' m'],
      ['吊荷高さ', safeFmt(liftHeight, 1) + ' m'],
    ];
    var pBldRows = pBldOn ? [['建物高さ', bH + ' m'], ['建物幅', (bWidth || '—') + ' m'], ['建物までの距離', bDist + ' m']] : [];
    printSheet = ce('div', { className: 'print-sheet print-only' },
      ce('div', { className: 'print-frame' },
        // ヘッダ
        ce('div', { className: 'print-head' },
          ce('div', { className: 'print-head-title' }, '揚重計画シミュレーター'),
          ce('div', { className: 'print-head-meta' },
            ce('span', null, '現場名：' + (projName || '―')),
            ce('span', null, docDate || '―'),
            ce('span', null, '作成者：' + (author || '―')))),
        // 断面図
        ce('div', { className: 'print-figure' },
          ce('div', { className: 'print-fig-title' }, selected.name + '　断面図'),
          ce('div', { className: 'print-fig-body' }, diagramContent)),
        // 右カラム（判定→詳細→建物条件）
        ce('div', { className: 'print-fig-right' },
        // 判定バー
        ce('div', { className: 'print-judge ' + (curOk ? 'ok' : 'ng') },
          ce('div', { className: 'print-judge-status' }, curOk ? '✓ 作業可能' : '✗ 能力不足'),
          ce('div', { className: 'print-judge-metrics' },
            ce('span', null, '使用率 ' + safeFmt(pUsage, 1) + '%'),
            ce('span', null, '安全余裕 ' + (curMg >= 0 ? '+' : '') + safeFmt(curMg, 1) + '%'),
            ce('span', null, '残能力 ' + safeFmt(pResid, 2) + 't'),
            pBldOn ? ce('span', null, '建物干渉 ' + bldInterf.label.replace(/^[⚠△✓]\s*/, '')) : null)),
        // 詳細情報 / 建物条件＋備考
        ce('div', { className: 'print-cols' },
          ce('div', { className: 'print-spec' },
            ce('div', { className: 'print-spec-title' }, '詳細情報'),
            ce('table', { className: 'print-table' },
              ce('tbody', null, pRows.map(function (p) {
                return ce('tr', { key: p[0] }, ce('td', { className: 'pt-l' }, p[0]), ce('td', { className: 'pt-v' }, p[1]));
              })))),
          ce('div', { className: 'print-spec' },
            pBldOn ? ce('div', null,
              ce('div', { className: 'print-spec-title' }, '建物条件'),
              ce('table', { className: 'print-table' },
                ce('tbody', null, pBldRows.map(function (p) {
                  return ce('tr', { key: p[0] }, ce('td', { className: 'pt-l' }, p[0]), ce('td', { className: 'pt-v' }, p[1]));
                })))) : null))),
        ce('div', { className: 'print-foot' }, '※ 本資料は目安です。実際の作業では必ず現場条件を確認してください。')));
  }

  return ce('div', { id: 'app-root', style: { height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
    ce('div', { className: 'app-header' },
      ce('div', { className: 'app-header-icon' }, '🏗'),
      ce('div', { className: 'app-header-title' }, '揚重計画シミュレーター'),
      ce('div', { className: 'header-meta no-print' },
        ce('div', { className: 'header-meta-field' },
          ce('label', null, '現場名'),
          ce('input', { type: 'text', value: projName, placeholder: '〇〇〇建設工事', onChange: function (e) { setProjName(e.target.value); } })),
        ce('div', { className: 'header-meta-field' },
          ce('label', null, '作成日'),
          ce('input', { type: 'date', value: docDate, onChange: function (e) { setDocDate(e.target.value); } })),
        ce('div', { className: 'header-meta-field' },
          ce('label', null, '作成者'),
          ce('input', { type: 'text', value: author, placeholder: '担当者名', onChange: function (e) { setAuthor(e.target.value); } }))),
      // 印刷用メタ表示（画面では非表示）
      ce('div', { className: 'print-only', style: { fontSize: '12px', color: '#000', marginLeft: 'auto' } },
        '現場名：' + (projName || '―') + '　作成日：' + docDate + '　作成者：' + (author || '―')),
      ce('button', { className: 'print-btn no-print',
        title: '印刷ダイアログで「ヘッダーとフッター」のチェックを外すとURL・ページ番号が消えます',
        onClick: function () { window.print(); } }, '🖨 PDF出力')),
    ce('div', { className: 'main-layout' },
      leftPanel,
      !isMobile ? ce('div', { className: 'splitter', onMouseDown: function (e) { dragL.current = e.clientX - leftW; e.preventDefault(); } }) : null,
      centerPanel,
      !isMobile ? ce('div', { className: 'splitter', onMouseDown: function (e) { dragR.current = e.clientX + rightW; e.preventDefault(); } }) : null,
      rightPanel),
    printSheet);
}

// マウント
document.addEventListener('DOMContentLoaded', function () {
  var root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(ce(CraneErrorBoundary, null, ce(App, null)));
});
