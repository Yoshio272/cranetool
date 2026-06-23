// ============================================================
// constants.js  - アプリ全体の固定値
// 動作仕様を変えるときはここだけ修正する
// ============================================================

// 計算
var SAFETY_RATIO    = 0.8;           // 安全率（定格の80%）
var DEG_TO_RAD      = Math.PI / 180; // 角度→ラジアン変換係数
var MIN_BOOM_ANGLE  = 5;             // 最小ブーム角度（°）
var MAX_BOOM_ANGLE  = 88;            // 最大ブーム角度（°）

// SVG描画
var SVG_BASE_HEIGHT    = 1.5;  // 旋回体ベース高さ（m）
var SVG_MARGIN_RATIO   = 0.12; // viewBox余白率（10%）
var SVG_DIM_DOWN       = 1.5;  // 地面下寸法線オフセット（m）
var SVG_DIM_RIGHT      = 1.5;  // 右側寸法線オフセット（m）
var SVG_HOOK_DROP_RATIO = 0.18;// フック垂下長率（ブーム長に対する比率）
var SVG_HOOK_DROP_MAX  = 5.0;  // フック垂下最大長（m）
var SVG_BUILDING_WIDTH = 10;   // 建物奥行き固定幅（m）
var SVG_BOOM_WIDTH     = 0.55; // ブーム線幅（m換算）
var SVG_BOOM_WIDTH_SM  = 0.4;  // コンパクト時ブーム線幅

// レイアウト
var PANEL_LEFT_DEFAULT  = 220; // 左パネルデフォルト幅（px）
var PANEL_LEFT_MIN      = 160; // 左パネル最小幅（px）
var PANEL_LEFT_MAX      = 360; // 左パネル最大幅（px）
var PANEL_RIGHT_DEFAULT = 280; // 右パネルデフォルト幅（px）
var PANEL_RIGHT_MIN     = 200; // 右パネル最小幅（px）
var PANEL_RIGHT_MAX     = 420; // 右パネル最大幅（px）

// 判定しきい値
var MARGIN_EXCELLENT = 20; // 余裕◎のしきい値（%）

// 印刷
var PRINT_SVG_HEIGHT_MM = 200; // 印刷時SVG高さ（mm）
