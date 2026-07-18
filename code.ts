/// <reference types="@figma/plugin-typings" />

declare function atob(data: string): string;

figma.showUI(__html__, { width: 420, height: 560 });

interface TextBackdropSpec {
  type: "gradient" | "blur";
  color: [number, number, number, number];
  blurRadius?: number;
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
}

const FONT_WEIGHT_MAP: Record<TextSpec["fontWeight"], string> = {
  regular: "Regular",
  medium: "Medium",
  bold: "Bold",
};

// 알로소 제작 규칙: 국문은 Pretendard, 영문/숫자는 Century Gothic, 자간은 각각 -1.5% / -2.5%
const KR_FAMILY = "Pretendard";
const LATIN_FAMILY = "Century Gothic";
const KR_LETTER_SPACING_PERCENT = -1.5;
const LATIN_LETTER_SPACING_PERCENT = -2.5;
const FALLBACK_FONT: FontName = { family: "Inter", style: "Regular" };

const isLatinChar = (ch: string) => /[A-Za-z0-9]/.test(ch);

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

  for (const t of spec.texts) {
    if (t.backdrop) {
      frame.appendChild(createTextBackdrop(t));
    }

    const textNode = figma.createText();
    await applyMixedFontText(textNode, t.content, t.fontWeight);
    textNode.resize(t.width, t.height);
    textNode.x = t.x;
    textNode.y = t.y;
    textNode.fontSize = t.fontSize;
    textNode.fills = [{ type: "SOLID", color: { r: t.color[0], g: t.color[1], b: t.color[2] } }];
    if (t.align) textNode.textAlignHorizontal = t.align;
    frame.appendChild(textNode);
  }

  if (spec.logo && spec.logo.base64) {
    const imageHash = figma.createImage(base64ToUint8Array(spec.logo.base64)).hash;
    const rect = figma.createRectangle();
    rect.name = "Logo";
    rect.resize(spec.logo.width, spec.logo.height);
    rect.x = spec.logo.x;
    rect.y = spec.logo.y;
    rect.fills = [{ type: "IMAGE", imageHash, scaleMode: "FIT" }];
    frame.appendChild(rect);
  } else if (spec.logo) {
    const rect = figma.createRectangle();
    rect.name = "Logo Placeholder";
    rect.resize(spec.logo.width, spec.logo.height);
    rect.x = spec.logo.x;
    rect.y = spec.logo.y;
    rect.fills = [{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85 } }];
    frame.appendChild(rect);
  }

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
