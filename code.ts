/// <reference types="@figma/plugin-typings" />

declare function atob(data: string): string;

figma.showUI(__html__, { width: 420, height: 560 });

interface TextBackdropSpec {
  type: "gradient" | "blur";
  color: [number, number, number, number];
  blurRadius?: number;
}

interface TextHighlightSpec {
  text: string;
  color: [number, number, number];
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
}

const FONT_WEIGHT_MAP: Record<TextSpec["fontWeight"], string> = {
  regular: "Regular",
  medium: "Medium",
  bold: "Bold",
};

// 알로소 제작 규칙: 국문+숫자는 Pretendard, 영문만 Century Gothic, 자간은 각각 -1.5% / -2.5%
const KR_FAMILY = "Pretendard";
const LATIN_FAMILY = "Century Gothic";
const KR_LETTER_SPACING_PERCENT = -1.5;
const LATIN_LETTER_SPACING_PERCENT = -2.5;
const FALLBACK_FONT: FontName = { family: "Inter", style: "Regular" };

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
    // 텍스트 아래쪽에만 깔리는 옅은 그라데이션 패널 (위: 투명 -> 아래: backdrop 색상)
    rect.fills = [
      {
        type: "GRADIENT_LINEAR",
        gradientTransform: [
          [0, 1, 0],
          [-1, 0, 1],
        ],
        gradientStops: [
          { position: 0, color: { r, g, b, a: 0 } },
          { position: 1, color: { r, g, b, a } },
        ],
      },
    ];
  } else {
    rect.fills = [{ type: "SOLID", color: { r, g, b }, opacity: a }];
    rect.effects = [
      {
        type: "BACKGROUND_BLUR",
        blurType: "NORMAL",
        radius: backdrop.blurRadius ?? 20,
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

// content 안의 "LIVE" 문자열을 모두 실제 로고 이미지로 치환해서 배치한다.
// 텍스트를 "LIVE" 기준으로 나눠 각 조각을 auto-resize 텍스트 노드로 만들어 실제 렌더링 폭을 측정하고,
// 그 폭을 이어붙여 원래 정렬(align)에 맞는 시작 x좌표를 계산한 뒤 순서대로 배치한다.
async function renderTextWithInlineLiveLogo(frame: FrameNode, t: TextSpec, logo: InlineLiveLogo): Promise<void> {
  const parts = t.content.split("LIVE");
  const gap = t.fontSize * 0.15;
  const logoHeight = t.fontSize * 1.05;
  const logoWidth = logoHeight * logo.aspect;

  const segments: (TextNode | null)[] = [];
  for (const part of parts) {
    if (!part) {
      segments.push(null);
      continue;
    }
    const node = figma.createText();
    await applyMixedFontText(node, part, t.fontWeight);
    node.fontSize = t.fontSize;
    node.fills = [{ type: "SOLID", color: { r: t.color[0], g: t.color[1], b: t.color[2] } }];
    node.textAutoResize = "WIDTH_AND_HEIGHT"; // 실제 렌더링 폭을 읽기 위해 콘텐츠에 맞춰 크기 측정
    segments.push(node);
  }

  let totalWidth = 0;
  segments.forEach((node, i) => {
    if (node) totalWidth += node.width;
    if (i < segments.length - 1) totalWidth += gap + logoWidth + gap;
  });

  let cursorX = t.x;
  if (t.align === "RIGHT") cursorX = t.x + t.width - totalWidth;
  else if (t.align === "CENTER") cursorX = t.x + (t.width - totalWidth) / 2;

  for (let i = 0; i < segments.length; i++) {
    const node = segments[i];
    if (node) {
      node.x = cursorX;
      node.y = t.y;
      frame.appendChild(node);
      cursorX += node.width;
    }
    if (i < segments.length - 1) {
      cursorX += gap;
      const rect = figma.createRectangle();
      rect.name = "Live Inline Logo";
      rect.resize(logoWidth, logoHeight);
      rect.x = cursorX;
      rect.y = t.y + (t.fontSize - logoHeight) / 2;
      rect.fills = [{ type: "IMAGE", imageHash: logo.imageHash, scaleMode: "FIT" }];
      frame.appendChild(rect);
      cursorX += logoWidth + gap;
    }
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
  if (spec.liveBadge && spec.liveBadge.base64) {
    const image = figma.createImage(base64ToUint8Array(spec.liveBadge.base64));
    const size = await image.getSizeAsync();
    inlineLiveLogo = { imageHash: image.hash, aspect: size.width / size.height };
  }

  for (const t of spec.texts) {
    if (t.backdrop) {
      frame.appendChild(createTextBackdrop(t));
    }

    if (inlineLiveLogo && t.content.includes("LIVE")) {
      await renderTextWithInlineLiveLogo(frame, t, inlineLiveLogo);
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
    }

    frame.appendChild(textNode);
  }

  placeImageAsset(frame, spec.logo, "Logo");
  placeImageAsset(frame, spec.liveBadge, "Live Badge");

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
