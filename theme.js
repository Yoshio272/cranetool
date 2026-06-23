// ============================================================
// theme.js  - 色・フォント・余白の一元管理
// UIの見た目を変えるときはここだけ修正する
// ============================================================

// v15: 白基調・青アクセントの業務UIパレット（キー名は互換維持）
var COLOR = {
  // 背景系（白系）
  bgDeep:    '#ffffff',   // 入力背景
  bgBase:    '#f1f4f8',   // ベース背景
  bgPanel:   '#ffffff',   // パネル背景
  bgCard:    '#f7f9fc',   // カード背景
  bgCrane:   '#dbe3ee',   // クレーン車体

  // ボーダー系
  border:    '#d4dae3',   // 通常ボーダー
  borderDim: '#e6eaf0',   // 薄ボーダー
  borderMid: '#c2ccd9',   // 中間ボーダー

  // テキスト系（濃色）
  textPrimary: '#1f2733', // 主テキスト
  textSub:     '#5b6776', // サブテキスト
  textDim:     '#8a95a3', // 暗テキスト
  textFaint:   '#b0b9c5', // 最も薄いテキスト
  textTiny:    '#c2cad4', // ラベル等

  // 機能色（青）
  primary:   '#1860c2',   // メインブルー
  primaryDk: '#134e9e',   // 濃いブルー
  primaryBt: '#1860c2',   // ボタンブルー
  boom:      '#1860c2',   // ブーム色
  boomLight: '#5b8fd6',   // ブームハイライト
  boomOk:    '#134e9e',   // ブームラベル

  // 判定色
  success:     '#1f8f46', // 可（緑）
  successText: '#1f8f46',
  successBg:   'rgba(31,143,70,0.08)',
  successBg2:  'rgba(31,143,70,0.12)',

  warning:     '#b8860b', // 注意（琥珀）
  warningText: '#b8860b',
  warningBg:   'rgba(184,134,11,0.12)',

  danger:      '#c0392b', // 不可（赤）
  dangerText:  '#c0392b',
  dangerLight: '#c0392b',
  dangerDark:  '#a5281c',
  dangerBg:    'rgba(192,57,43,0.08)',
  dangerBg2:   'rgba(192,57,43,0.12)',

  // アクセント（青に統一・ネオン排除）
  accent:    '#1860c2',   // スライダー等
  accentTxt: '#134e9e',   // 角度表示

  // 建物
  building:    '#b8860b',
  buildingBg:  'rgba(184,134,11,0.10)',

  // アウトリガ
  outrigger:   '#1860c2',
  outriggerBg: '#e8f0fb',

  // 寸法線
  dim:    '#5b6776',
  dimSub: '#8a95a3',
};

var FONT_SIZE = {
  xxs: '8px',
  xs:  '9px',
  sm:  '10px',
  md:  '11px',
  base:'12px',
  lg:  '13px',
  xl:  '15px',
  xxl: '16px',
  // SVG内（m単位）
  svgSm:  0.75,
  svgMd:  0.9,
  svgLg:  1.05,
};

var SPACING = {
  xxs: '2px',
  xs:  '4px',
  sm:  '6px',
  md:  '8px',
  lg:  '10px',
  xl:  '12px',
  xxl: '14px',
  '3xl':'16px',
  '4xl':'20px',
};

var RADIUS = {
  xs: '3px',
  sm: '5px',
  md: '7px',
  lg: '10px',
  xl: '12px',
};

// ============================================================
// 断面図SVG専用パレット定義
// アプリUI全体には影響しない。buildSVGの引数として渡す。
// ============================================================

// 背景テーマ（断面図SVG内の背景色・補助色）
var SVG_BG_THEMES = {
  dark:  { label:'ブルー', icon:'🌙',
           bg:'#060d1a', ground:'#1e3a5f', hatch:'#1e3a5f',
           bodyStroke:'#1e3a5f', groundLine:'#334155' },
  white: { label:'白',    icon:'☀️',
           bg:'#ffffff', ground:'#cbd5e1', hatch:'#94a3b8',
           bodyStroke:'#94a3b8', groundLine:'#94a3b8' },
  black: { label:'黒',    icon:'⬛',
           bg:'#111111', ground:'#374151', hatch:'#374151',
           bodyStroke:'#374151', groundLine:'#4b5563' },
};

// 文字・線色テーマ（断面図SVG内のテキスト・寸法線）
var SVG_TXT_THEMES = {
  default: { label:'標準', icon:'◾', dim:'#475569', sub:'#94a3b8', label2:'#334155', bgLabel:'#0a0e1a' },
  black:   { label:'黒',   icon:'⬛', dim:'#1a1a1a', sub:'#374151', label2:'#111111', bgLabel:'#f8fafc' },
  blue:    { label:'青',   icon:'🔵', dim:'#1e40af', sub:'#2563eb', label2:'#1e3a5f', bgLabel:'#eff6ff' },
  red:     { label:'赤',   icon:'🔴', dim:'#991b1b', sub:'#dc2626', label2:'#7f1d1d', bgLabel:'#fff1f2' },
  gray:    { label:'灰',   icon:'⬜', dim:'#4b5563', sub:'#6b7280', label2:'#374151', bgLabel:'#f9fafb' },
};

// 断面図パレットを生成（bg + txt を合成して返す）
function getSvgPalette(bgKey, txtKey) {
  var bg  = SVG_BG_THEMES[bgKey]  || SVG_BG_THEMES.dark;
  var txt = SVG_TXT_THEMES[txtKey] || SVG_TXT_THEMES['default'];
  // 車体色はbgに応じて自動調整（常に視認できる濃度）
  var bodyFill   = bgKey === 'white' ? '#94a3b8' : '#1e3a5f';
  var bodyStroke = bgKey === 'white' ? '#475569' : '#60a5fa';
  return {
    bg:        bg.bg,
    ground:    bg.ground,
    hatch:     bg.hatch,
    bodyStroke:bg.bodyStroke,
    groundLine:bg.groundLine,
    body:      bodyFill,
    bodyS:     bodyStroke,
    dim:       txt.dim,
    sub:       txt.sub,
    labelBg:   txt.bgLabel,
    // 判定OK/NGは固定色維持
    ok:   '#22c55e',
    okTxt:'#4ade80',
    ng:   '#ef4444',
    ngTxt:'#fca5a5',
    boom: '#1e40af',
    boomL:'#93c5fd',
    boomOk:'#60a5fa',
  };
}

// （断面図テーマは白背景・黒文字に固定。色変更/localStorage保存処理は廃止）
