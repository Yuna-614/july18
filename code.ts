/// <reference types="@figma/plugin-typings" />

declare function atob(data: string): string;

figma.showUI(__html__, { width: 420, height: 560 });

interface GradientStopSpec {
  position: number; // 0~1
  alpha: number; // 0~1
}

interface TextBackdropSpec {
  type: "gradient" | "blur";
  color: [number, number, number, number];
  blurRadius?: number;
  // gradient 타입 전용. 생략하면 기존 기본값(270도, 0%투명→100%불투명) 사용
  angle?: number; // 도(degree), 0~360
  stops?: [GradientStopSpec, GradientStopSpec]; // 생략 시 기본값 [{position:0,alpha:0},{position:1,alpha:color[3]}]
}

interface TextHighlightSpec {
  text: string;
  color: [number, number, number];
  // 있으면 이 구간 뒤에 둥근 사각형 배경(예: 가격인상 경고 문구의 빨간 박스)을 그린다. RGBA 0~1.
  background?: [number, number, number, number];
  // background가 있을 때만 사용. 생략하면 brand.config.json의 highlightBadge.cornerRadius 기본값 사용.
  cornerRadius?: number;
  // 이 구간만 본문과 다른 굵기로 렌더링해야 하면 지정 (예: "브랜드×브랜드" 콜라보 표기에서 가운데 "×"만
  // 얇게). 생략하면 텍스트 전체에 적용된 fontWeight를 그대로 사용.
  fontWeight?: "regular" | "medium" | "bold";
}

interface TextSpec {
  content: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  fontWeight: "regular" | "medium" | "bold";
  color: [number, number, number];
  align?: "LEFT" | "CENTER" | "RIGHT";
  backdrop?: TextBackdropSpec;
  highlights?: TextHighlightSpec[];
}

interface GradientStop {
  color: [number, number, number, number];
  position: number;
}

interface BackgroundSpec {
  type: "solid" | "gradient";
  color?: [number, number, number];
  gradientStops?: GradientStop[];
  gradientAngle?: number;
}

interface ImageSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  base64: string;
}

interface LogoSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  base64?: string;
}

interface MaterialSpec {
  frame: { name: string; width: number; height: number };
  background?: BackgroundSpec;
  mainImage?: ImageSpec;
  texts: TextSpec[];
  logo?: LogoSpec;
  liveBadge?: LogoSpec;
  // texts 안에 "LIVE" 글자가 인라인으로 들어간 경우(별도 뱃지 위치 없음) 치환용 에셋만 전달됨.
  // liveBadge가 별도 뱃지로 이미 있으면 그 base64를 재사용하므로, 이 필드는 liveBadge가 없을 때만 채워진다.
  liveLogoAsset?: { base64: string };
  // 캡슐형(pill) 프로모션 뱃지 — 로고/LIVE 뱃지와 동일하게 이미 텍스트가 포함된 완성본 PNG를 그대로 배치만 함
  badge?: LogoSpec;
}

// ============================================================
// 소재 제작 규칙 (알로소 Alloso) — 이 블록만 브랜드 규칙이다.
// Figma 플러그인은 번들러 없이 단일 code.ts를 tsc로만 컴파일하기 때문에
// vision/rules.js처럼 별도 파일로 분리할 수 없어, 이 블록 안에 명확히 모아뒀다.
// 아래 이 블록을 벗어난 부분은 전부 "작동" 로직(엔진)이므로 규칙 수정 시 건드릴 필요 없다.
// ============================================================
const FONT_WEIGHT_MAP: Record<TextSpec["fontWeight"], string> = {
  regular: "Regular",
  medium: "Medium",
  bold: "Bold",
};

// === BRAND_CONFIG_START (자동 생성 — 직접 수정 금지, brand.config.json을 고치고 npm run build 실행) ===
const KR_FAMILY = "Pretendard";
const LATIN_FAMILY = "Century Gothic";
const KR_LETTER_SPACING_PERCENT = -1.5;
const LATIN_LETTER_SPACING_PERCENT = -2.5;
const FALLBACK_FONT: FontName = { family: "Inter", style: "Regular" };
const LIVE_INLINE_LOGO_HEIGHT_RATIO = 1.05;
const LIVE_INLINE_LOGO_GAP_RATIO = 0.15;
const DEFAULT_BACKDROP_BLUR_RADIUS = 20;
const HIGHLIGHT_BADGE_PAD_X_RATIO = 0.28;
const HIGHLIGHT_BADGE_PAD_Y_RATIO = 0.12;
const HIGHLIGHT_BADGE_CORNER_RADIUS = 0;
// === BRAND_CONFIG_END ===
// ============================================================
// 규칙 블록 끝
// ============================================================

const isLatinChar = (ch: string) => /[A-Za-z]/.test(ch);

function splitRuns(content: string): Array<{ start: number; end: number; isLatin: boolean }> {
  const runs: Array<{ start: number; end: number; isLatin: boolean }> = [];
  let i = 0;
  while (i < content.length) {
    const latin = isLatinChar(content[i]);
    let j = i + 1;
    while (j < content.length && isLatinChar(content[j]) === latin) j++;
    runs.push({ start: i, end: j, isLatin: latin });
    i = j;
  }
  return runs;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const raw = base64.replace(/^data:image\/\w+;base64,/, "");
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function gradientTransformFromAngle(angleDeg: number): Transform {
  const angleRad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return [
    [cos, -sin, 0.5 - 0.5 * cos + 0.5 * sin],
    [sin, cos, 0.5 - 0.5 * sin - 0.5 * cos],
  ];
}

async function loadFontOrFallback(family: string, style: string): Promise<FontName> {
  const font: FontName = { family, style };
  try {
    await figma.loadFontAsync(font);
    return font;
  } catch {
    await figma.loadFontAsync(FALLBACK_FONT);
    return FALLBACK_FONT;
  }
}

async function applyMixedFontText(textNode: TextNode, content: string, weight: TextSpec["fontWeight"]) {
  const style = FONT_WEIGHT_MAP[weight];
  const krFont = await loadFontOrFallback(KR_FAMILY, style);
  const latinFont = await loadFontOrFallback(LATIN_FAMILY, style);

  textNode.fontName = krFont;
  textNode.characters = content;

  const runs = splitRuns(content);
  for (const run of runs) {
    const font = run.isLatin ? latinFont : krFont;
    textNode.setRangeFontName(run.start, run.end, font);
    const spacingPercent = run.isLatin ? LATIN_LETTER_SPACING_PERCENT : KR_LETTER_SPACING_PERCENT;
    textNode.setRangeLetterSpacing(run.start, run.end, { value: spacingPercent, unit: "PERCENT" });
  }
}

function createTextBackdrop(t: TextSpec): RectangleNode {
  const rect = figma.createRectangle();
  rect.name = "Text Backdrop";
  rect.resize(t.width, t.height);
  rect.x = t.x;
  rect.y = t.y;

  const backdrop = t.backdrop as TextBackdropSpec;
  const [r, g, b, a] = backdrop.color;

  if (backdrop.type === "gradient") {
    // 방향(angle)과 정지점(stops)을 시안에 맞게 커스터마이즈할 수 있음.
    // 기본값(각도 270, stops 생략)은 예전 동작(위: 투명 -> 아래: backdrop 색상)과 동일하게 유지된다.
    const stops = backdrop.stops ?? [
      { position: 0, alpha: 0 },
      { position: 1, alpha: a },
    ];
    rect.fills = [
      {
        type: "GRADIENT_LINEAR",
        gradientTransform: gradientTransformFromAngle(backdrop.angle ?? 270),
        gradientStops: stops.map((s) => ({
          position: s.position,
          color: { r, g, b, a: s.alpha },
        })),
      },
    ];
  } else {
    rect.fills = [{ type: "SOLID", color: { r, g, b }, opacity: a }];
    rect.effects = [
      {
        type: "BACKGROUND_BLUR",
        blurType: "NORMAL",
        radius: backdrop.blurRadius ?? DEFAULT_BACKDROP_BLUR_RADIUS,
        visible: true,
      } as Effect,
    ];
  }

  return rect;
}

interface InlineLiveLogo {
  imageHash: string;
  aspect: number; // width / height
}

// 한 줄(content.split("\n")의 한 조각) 안에서 특수 처리가 필요한 구간(LIVE 치환 이미지, 배경 박스가 있는
// highlight)을 순서대로 찾아 일반 텍스트/특수 토큰으로 쪼갠다. 배경 없는 highlight(색상만 다른 경우)는
// 여기서 다루지 않고 기존 setRangeFills 경로로 처리되므로 포함하지 않는다.
type LineToken =
  | { kind: "text"; text: string }
  | { kind: "live" }
  | {
      kind: "highlight";
      text: string;
      color: [number, number, number];
      background: [number, number, number, number];
      cornerRadius: number;
      fontWeight?: TextSpec["fontWeight"];
    };

function tokenizeLine(line: string, highlights: TextHighlightSpec[], hasLiveLogo: boolean): LineToken[] {
  const markers: { start: number; end: number; token: LineToken }[] = [];

  if (hasLiveLogo) {
    let idx = line.indexOf("LIVE");
    while (idx !== -1) {
      markers.push({ start: idx, end: idx + 4, token: { kind: "live" } });
      idx = line.indexOf("LIVE", idx + 4);
    }
  }
  for (const h of highlights) {
    if (!h.background) continue;
    let idx = line.indexOf(h.text);
    while (idx !== -1) {
      markers.push({
        start: idx,
        end: idx + h.text.length,
        token: {
          kind: "highlight",
          text: h.text,
          color: h.color,
          background: h.background,
          cornerRadius: h.cornerRadius ?? HIGHLIGHT_BADGE_CORNER_RADIUS,
          fontWeight: h.fontWeight,
        },
      });
      idx = line.indexOf(h.text, idx + h.text.length);
    }
  }
  markers.sort((a, b) => a.start - b.start);

  const tokens: LineToken[] = [];
  let cursor = 0;
  for (const m of markers) {
    if (m.start < cursor) continue; // 겹치는 마커는 먼저 온 것을 우선하고 뒤엣것은 무시
    if (m.start > cursor) tokens.push({ kind: "text", text: line.slice(cursor, m.start) });
    tokens.push(m.token);
    cursor = m.end;
  }
  if (cursor < line.length || tokens.length === 0) tokens.push({ kind: "text", text: line.slice(cursor) });
  return tokens;
}

// content 안의 "LIVE" 치환 이미지와 배경 박스가 있는 highlight를 함께 처리하며 한 줄씩 배치한다(둘 다 없는
// 조각은 그냥 일반 텍스트). 각 조각을 auto-resize 텍스트 노드로 만들어 실제 렌더링 폭을 측정하고, 그 폭을
// 이어붙여 정렬(align)에 맞는 시작 x좌표를 계산한 뒤 순서대로 배치한다. 다음 줄의 y좌표는 이전 줄에서
// 측정된 실제 높이만큼 내려간다.
async function renderTextWithSegments(frame: FrameNode, t: TextSpec, logo: InlineLiveLogo | null): Promise<void> {
  const hasLiveLogo = !!logo && t.content.includes("LIVE");
  const gap = t.fontSize * LIVE_INLINE_LOGO_GAP_RATIO;
  const logoHeight = t.fontSize * LIVE_INLINE_LOGO_HEIGHT_RATIO;
  const logoWidth = logo ? logoHeight * logo.aspect : 0;
  const padX = t.fontSize * HIGHLIGHT_BADGE_PAD_X_RATIO;
  const padY = t.fontSize * HIGHLIGHT_BADGE_PAD_Y_RATIO;

  type Measured =
    | { kind: "live" }
    | { kind: "text"; node: TextNode }
    | { kind: "highlight"; node: TextNode; background: [number, number, number, number]; cornerRadius: number };

  let cursorY = t.y;
  for (const line of t.content.split("\n")) {
    const tokens = tokenizeLine(line, t.highlights ?? [], hasLiveLogo);

    const measured: Measured[] = [];
    for (const token of tokens) {
      if (token.kind === "live") {
        measured.push({ kind: "live" });
        continue;
      }
      if (!token.text) continue;
      const node = figma.createText();
      const weight = token.kind === "highlight" ? token.fontWeight ?? t.fontWeight : t.fontWeight;
      await applyMixedFontText(node, token.text, weight);
      node.fontSize = t.fontSize;
      const color = token.kind === "highlight" ? token.color : t.color;
      node.fills = [{ type: "SOLID", color: { r: color[0], g: color[1], b: color[2] } }];
      node.textAutoResize = "WIDTH_AND_HEIGHT"; // 실제 렌더링 폭/높이를 읽기 위해 콘텐츠에 맞춰 크기 측정
      if (token.kind === "highlight") {
        measured.push({ kind: "highlight", node, background: token.background, cornerRadius: token.cornerRadius });
      } else {
        measured.push({ kind: "text", node });
      }
    }

    let totalWidth = 0;
    let lineHeight = t.fontSize * 1.3; // 조각이 전부 빈 값일 때(빈 줄)를 대비한 기본값
    measured.forEach((m) => {
      if (m.kind === "live") {
        totalWidth += logoWidth;
        lineHeight = Math.max(lineHeight, logoHeight);
      } else if (m.kind === "highlight") {
        totalWidth += m.node.width + padX * 2;
        lineHeight = Math.max(lineHeight, m.node.height);
      } else {
        totalWidth += m.node.width;
        lineHeight = Math.max(lineHeight, m.node.height);
      }
    });
    // LIVE 조각 앞뒤로는 기존과 동일하게 gap을 더한다. highlight는 패딩 자체가 여백 역할을 하므로
    // 추가 gap을 두지 않는다(시안에서 배경 박스가 옆 텍스트와 거의 붙어 있는 모양과 일치).
    tokens.forEach((token, i) => {
      if (token.kind !== "live") return;
      if (i > 0) totalWidth += gap;
      if (i < tokens.length - 1) totalWidth += gap;
    });

    let cursorX = t.x;
    if (t.align === "RIGHT") cursorX = t.x + t.width - totalWidth;
    else if (t.align === "CENTER") cursorX = t.x + (t.width - totalWidth) / 2;

    for (let i = 0; i < measured.length; i++) {
      const m = measured[i];
      if (tokens[i].kind === "live" && i > 0) cursorX += gap;

      if (m.kind === "live") {
        const rect = figma.createRectangle();
        rect.name = "Live Inline Logo";
        rect.resize(logoWidth, logoHeight);
        rect.x = cursorX;
        rect.y = cursorY + (t.fontSize - logoHeight) / 2;
        rect.fills = [{ type: "IMAGE", imageHash: logo!.imageHash, scaleMode: "FIT" }];
        frame.appendChild(rect);
        cursorX += logoWidth;
      } else if (m.kind === "highlight") {
        const boxWidth = m.node.width + padX * 2;
        const boxHeight = m.node.height + padY * 2;
        const bg = figma.createRectangle();
        bg.name = "Highlight Background";
        bg.resize(boxWidth, boxHeight);
        bg.cornerRadius = m.cornerRadius;
        bg.x = cursorX;
        bg.y = cursorY - padY;
        const [r, g, b, a] = m.background;
        bg.fills = [{ type: "SOLID", color: { r, g, b }, opacity: a }];
        frame.appendChild(bg);

        m.node.x = cursorX + padX;
        m.node.y = cursorY;
        frame.appendChild(m.node);
        cursorX += boxWidth;
      } else {
        m.node.x = cursorX;
        m.node.y = cursorY;
        frame.appendChild(m.node);
        cursorX += m.node.width;
      }

      if (tokens[i].kind === "live" && i < measured.length - 1) cursorX += gap;
    }

    cursorY += lineHeight;
  }
}

function placeImageAsset(frame: FrameNode, asset: LogoSpec | undefined, name: string): void {
  if (!asset) return;

  const rect = figma.createRectangle();
  rect.name = asset.base64 ? name : `${name} Placeholder`;
  rect.resize(asset.width, asset.height);
  rect.x = asset.x;
  rect.y = asset.y;

  if (asset.base64) {
    const imageHash = figma.createImage(base64ToUint8Array(asset.base64)).hash;
    rect.fills = [{ type: "IMAGE", imageHash, scaleMode: "FIT" }];
  } else {
    rect.fills = [{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85 } }];
  }

  frame.appendChild(rect);
}

async function buildMaterial(spec: MaterialSpec): Promise<FrameNode> {
  const frame = figma.createFrame();
  frame.name = spec.frame.name || "Generated Material";
  frame.resize(spec.frame.width, spec.frame.height);
  frame.x = figma.viewport.center.x - spec.frame.width / 2;
  frame.y = figma.viewport.center.y - spec.frame.height / 2;

  if (spec.background && spec.background.type === "solid" && spec.background.color) {
    const [r, g, b] = spec.background.color;
    frame.fills = [{ type: "SOLID", color: { r, g, b } }];
  } else if (spec.background && spec.background.type === "gradient" && spec.background.gradientStops) {
    frame.fills = [
      {
        type: "GRADIENT_LINEAR",
        gradientTransform: gradientTransformFromAngle(spec.background.gradientAngle || 0),
        gradientStops: spec.background.gradientStops.map((s) => ({
          position: s.position,
          color: { r: s.color[0], g: s.color[1], b: s.color[2], a: s.color[3] },
        })),
      },
    ];
  }

  if (spec.mainImage) {
    const imageHash = figma.createImage(base64ToUint8Array(spec.mainImage.base64)).hash;
    const rect = figma.createRectangle();
    rect.name = "Main Image";
    rect.resize(spec.mainImage.width, spec.mainImage.height);
    rect.x = spec.mainImage.x;
    rect.y = spec.mainImage.y;
    rect.fills = [{ type: "IMAGE", imageHash, scaleMode: "FILL" }];
    frame.appendChild(rect);
  }

  let inlineLiveLogo: InlineLiveLogo | null = null;
  const liveLogoBase64 = spec.liveBadge?.base64 ?? spec.liveLogoAsset?.base64;
  if (liveLogoBase64) {
    const image = figma.createImage(base64ToUint8Array(liveLogoBase64));
    const size = await image.getSizeAsync();
    inlineLiveLogo = { imageHash: image.hash, aspect: size.width / size.height };
  }

  for (const t of spec.texts) {
    if (t.backdrop) {
      frame.appendChild(createTextBackdrop(t));
    }

    const hasBackgroundHighlight = (t.highlights ?? []).some((h) => h.background);
    if ((inlineLiveLogo && t.content.includes("LIVE")) || hasBackgroundHighlight) {
      await renderTextWithSegments(frame, t, inlineLiveLogo);
      continue;
    }

    const textNode = figma.createText();
    await applyMixedFontText(textNode, t.content, t.fontWeight);
    textNode.resize(t.width, t.height);
    textNode.x = t.x;
    textNode.y = t.y;
    textNode.fontSize = t.fontSize;
    textNode.fills = [{ type: "SOLID", color: { r: t.color[0], g: t.color[1], b: t.color[2] } }];
    if (t.align) textNode.textAlignHorizontal = t.align;

    for (const h of t.highlights ?? []) {
      const start = t.content.indexOf(h.text);
      if (start === -1) continue;
      const end = start + h.text.length;
      textNode.setRangeFills(start, end, [
        { type: "SOLID", color: { r: h.color[0], g: h.color[1], b: h.color[2] } },
      ]);
      if (h.fontWeight) {
        // 강조 구간의 첫 글자 기준으로 이 구간의 폰트 패밀리를 판단한다(구간 내 국문/영문 혼용은 지원 안 함).
        const family = isLatinChar(h.text[0]) ? LATIN_FAMILY : KR_FAMILY;
        const font = await loadFontOrFallback(family, FONT_WEIGHT_MAP[h.fontWeight]);
        textNode.setRangeFontName(start, end, font);
      }
    }

    frame.appendChild(textNode);
  }

  placeImageAsset(frame, spec.logo, "Logo");
  placeImageAsset(frame, spec.liveBadge, "Live Badge");
  placeImageAsset(frame, spec.badge, "Promo Badge");

  figma.currentPage.appendChild(frame);
  figma.viewport.scrollAndZoomIntoView([frame]);
  figma.currentPage.selection = [frame];
  return frame;
}

figma.ui.onmessage = async (msg: { type: string; spec?: string }) => {
  if (msg.type === "generate" && msg.spec) {
    try {
      const spec: MaterialSpec = JSON.parse(msg.spec);
      await buildMaterial(spec);
      figma.ui.postMessage({ type: "success" });
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: (e as Error).message });
    }
  }
  if (msg.type === "close") {
    figma.closePlugin();
  }
};
