# 소재 제작 AI 에이전트 — 프로젝트 요약

## 목표

광고주가 준 시안 이미지 + 원본 고해상도 사진 + 로고 PNG를 입력하면, AI가 Figma에 자동으로
소재 디자인(SB)을 생성해주는 파이프라인. 최종적으로는 "시안만 넣으면 디자인본이 자동으로 나오는 것"이 목표.

## 파이프라인 구조

```
[광고주 시안 이미지] + [원본 고해상도 사진] + [로고 PNG]
        │
        ▼
[1. Vision 분석 — vision/analyze.js, Gemini API]
   - 시안과 원본을 함께 모델에 전달
   - 시안과 동일한 구도를 재현하는 크롭 영역을 원본 좌표계에서 산출 (cropRect)
   - 텍스트 내용/위치/굵기/색상/정렬을 1080x1080 출력 캔버스 기준으로 산출
   - 로고가 들어갈 위치/크기 산출 (로고 이미지 자체는 만들지 않음)
        │
        ▼
[2. 이미지 크롭/리사이즈 — sharp]
   - 원본 사진을 cropRect로 크롭 후 1080x1080으로 리사이즈 (cover)
   - 크롭 없이 원본 그대로 전체 배경으로 사용 (합성 배경색 안 씀)
        │
        ▼
[output-spec.json 생성]
   - frame, mainImage(크롭된 배경), texts[], logo(실제 로고 파일 base64)
        │
        ▼
[3. Figma 플러그인 — code.ts]
   - 스펙 JSON을 읽어 Figma 캔버스에 실제 레이어 생성
   - 배경 이미지, 텍스트(국문 Pretendard / 영문·숫자 Century Gothic 자동 분기),
     텍스트 가독성 패널(backdrop), 로고 이미지를 배치
```

## 폴더 구조

```
C:\Users\gram\figma-material-agent\
├── manifest.json       — Figma 플러그인 정의
├── code.ts              — 플러그인 메인 로직 (스펙 JSON → Figma 노드)
├── ui.html               — 플러그인 UI (JSON 붙여넣기 / 파일 불러오기 / 생성)
├── package.json
├── tsconfig.json
└── vision/
    └── analyze.js        — Gemini Vision 분석 스크립트 (원본+시안 → 스펙 JSON)
```

---

## 1. Figma 플러그인 코드

### manifest.json
```json
{
  "name": "Material Auto Builder",
  "id": "material-auto-builder",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "editorType": ["figma"],
  "networkAccess": {
    "allowedDomains": ["none"]
  }
}
```

### package.json
```json
{
  "name": "material-auto-builder",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "watch": "tsc -p tsconfig.json --watch",
    "analyze": "node vision/analyze.js"
  },
  "devDependencies": {
    "@figma/plugin-typings": "^1.100.0",
    "typescript": "^5.5.0"
  },
  "dependencies": {
    "@google/genai": "^0.15.0",
    "sharp": "^0.33.0"
  }
}
```

### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES6",
    "lib": ["ES2017"],
    "strict": true,
    "noImplicitAny": true,
    "types": []
  },
  "include": ["code.ts"]
}
```
> `types: []`가 필요한 이유: `@google/genai`가 `@types/node`를 끌고 들어오는데,
> Node 전역 타입(`console`, `fetch`)과 Figma 플러그인 전역 타입이 충돌해서 명시적으로 비워야 함.

### code.ts (Figma 플러그인 메인 로직)
```typescript
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
```

### ui.html (플러그인 UI)
```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { font-family: Inter, sans-serif; margin: 0; padding: 12px; font-size: 12px; color: #111; }
  h3 { margin: 0 0 8px; font-size: 13px; }
  textarea { width: 100%; height: 340px; box-sizing: border-box; font-family: 'SF Mono', monospace; font-size: 11px; padding: 8px; }
  .buttons { display: flex; gap: 8px; margin-top: 8px; }
  button { padding: 8px 14px; cursor: pointer; border: none; border-radius: 6px; font-size: 12px; }
  #generate { background: #18A0FB; color: white; }
  #loadSample { background: #eee; color: #333; }
  #status { margin-top: 8px; color: #666; }
</style>
</head>
<body>
  <h3>소재 스펙 JSON 입력</h3>
  <textarea id="spec" placeholder="스펙 JSON을 붙여넣거나 파일을 불러오세요"></textarea>
  <div class="buttons">
    <button id="generate">Figma에 생성</button>
    <button id="loadSample">샘플 불러오기</button>
    <button id="loadFile">파일 불러오기</button>
    <input type="file" id="fileInput" accept=".json" style="display:none" />
  </div>
  <div id="status"></div>

<script>
  var SAMPLE = {
    frame: { name: "Sample Ad Material", width: 1080, height: 1080 },
    background: {
      type: "gradient",
      gradientAngle: 45,
      gradientStops: [
        { color: [1, 0.42, 0.21, 1], position: 0 },
        { color: [0.97, 0.58, 0.12, 1], position: 1 }
      ]
    },
    texts: [
      {
        content: "여름 시즌 특가",
        x: 80, y: 700, width: 600, height: 100,
        fontSize: 56, fontWeight: "bold",
        color: [1, 1, 1], align: "LEFT"
      },
      {
        content: "지금 확인하기",
        x: 80, y: 820, width: 400, height: 60,
        fontSize: 28, fontWeight: "medium",
        color: [1, 1, 1], align: "LEFT"
      }
    ],
    logo: { x: 900, y: 60, width: 120, height: 60 }
  };

  document.getElementById('loadSample').onclick = function () {
    document.getElementById('spec').value = JSON.stringify(SAMPLE, null, 2);
  };

  document.getElementById('loadFile').onclick = function () {
    document.getElementById('fileInput').click();
  };

  document.getElementById('fileInput').onchange = function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      document.getElementById('spec').value = reader.result;
      document.getElementById('status').textContent = file.name + ' 불러옴';
    };
    reader.readAsText(file);
  };

  document.getElementById('generate').onclick = function () {
    var spec = document.getElementById('spec').value;
    document.getElementById('status').textContent = '생성 중...';
    parent.postMessage({ pluginMessage: { type: 'generate', spec: spec } }, '*');
  };

  window.onmessage = function (event) {
    var msg = event.data.pluginMessage;
    if (!msg) return;
    if (msg.type === 'success') {
      document.getElementById('status').textContent = '생성 완료';
    } else if (msg.type === 'error') {
      document.getElementById('status').textContent = '오류: ' + msg.message;
    }
  };
</script>
</body>
</html>
```

---

## 2. Vision 분석 스크립트 (vision/analyze.js)

Gemini API(`gemini-3.5-flash`)에 **시안 이미지**와 **원본 고해상도 사진**을 함께 전달해서:
- 원본 좌표계 기준 정사각형 크롭 영역(`cropRect`) — 시안과 같은 구도를 재현
- 1080x1080 캔버스 기준 텍스트 배열(`texts`) — 내용/위치/굵기/색상/정렬/가독성 패널
- 1080x1080 캔버스 기준 로고 위치(`logoPlacement`) — 로고 이미지 자체는 만들지 않음

을 구조화된 JSON(`responseSchema`)으로 받는다. 이후 `sharp`로 원본을 크롭+리사이즈하고,
실제 로고 PNG 파일을 그대로 읽어서 최종 `output-spec.json`을 만든다.

```javascript
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const MODEL = "gemini-3.5-flash";
const OUTPUT_SIZE = 1080; // 알로소 기본 소재 사이즈

// Windows NTFS는 파일명을 정규화하지 않고 그대로 저장하는데, 한글 파일명이 NFD(자모 분리형)로
// 저장된 경우 우리가 전달받은 NFC(완성형) 경로와 바이트 단위로 일치하지 않아 ENOENT가 난다.
// 정확히 못 찾으면 디렉터리를 읽어 NFC 기준으로 재매칭한다.
function resolveActualPath(filePath) {
  if (fs.existsSync(filePath)) return filePath;
  const dir = path.dirname(filePath);
  const wanted = path.basename(filePath).normalize("NFC");
  const entries = fs.readdirSync(dir);
  const match = entries.find((e) => e.normalize("NFC") === wanted);
  if (!match) {
    throw new Error(`파일을 찾을 수 없음: ${filePath}`);
  }
  return path.join(dir, match);
}

// 모델에게 두 장의 이미지를 함께 준다:
//   referenceImage(시안) - 광고주가 준 레이아웃/구도 레퍼런스 (텍스트/로고 포함된 완성본)
//   originalImage(원본)  - 크롭되지 않은 실제 고해상도 원본 사진
// 모델은 원본 이미지 좌표계에서 "시안과 같은 구도를 재현하는 정사각형 크롭 영역"을 찾고,
// 텍스트/로고 위치는 1080x1080 출력 캔버스 기준으로 스케일링해서 알려준다.
const MATERIAL_SPEC_SCHEMA = {
  type: "object",
  properties: {
    cropRect: {
      type: "object",
      description:
        "원본 이미지 좌표계에서, 시안과 동일한 구도를 재현하기 위해 잘라내야 할 정사각형 영역(x, y, width, height). width와 height는 같아야 함(정사각형)",
      properties: {
        x: { type: "integer" },
        y: { type: "integer" },
        width: { type: "integer" },
        height: { type: "integer" },
      },
      required: ["x", "y", "width", "height"],
    },
    texts: {
      type: "array",
      description: `모든 좌표는 최종 출력 캔버스(${OUTPUT_SIZE}x${OUTPUT_SIZE}px) 기준으로 스케일링해서 산출`,
      items: {
        type: "object",
        properties: {
          content: { type: "string" },
          x: { type: "integer" },
          y: { type: "integer" },
          width: { type: "integer" },
          height: { type: "integer" },
          fontSize: { type: "integer" },
          fontWeight: { type: "string", enum: ["regular", "medium", "bold"] },
          color: {
            type: "array",
            items: { type: "number" },
            minItems: 3,
            maxItems: 3,
            description: "텍스트 색상. 반드시 0~1 사이의 실수로 표현한 RGB (예: 흰색은 [1, 1, 1], 0~255 정수 아님)",
          },
          align: { type: "string", enum: ["LEFT", "CENTER", "RIGHT"] },
          backdrop: {
            type: "object",
            description:
              "텍스트 가독성이 배경 이미지 때문에 떨어질 것으로 판단되면 뒤에 깔 패널. 필요 없으면 생략",
            properties: {
              type: { type: "string", enum: ["gradient", "blur"] },
              color: {
                type: "array",
                items: { type: "number" },
                minItems: 4,
                maxItems: 4,
                description: "배경 이미지의 어두운 영역에서 추출한 RGBA 0-1 값",
              },
              blurRadius: { type: "number", description: "blur 타입일 때만 사용, 기본 20" },
            },
            required: ["type", "color"],
          },
        },
        required: ["content", "x", "y", "width", "height", "fontSize", "fontWeight", "color"],
      },
    },
    logoPlacement: {
      type: "object",
      description: `브랜드 로고가 배치되어야 할 위치와 크기. ${OUTPUT_SIZE}x${OUTPUT_SIZE} 출력 캔버스 기준 픽셀 좌표`,
      properties: {
        x: { type: "integer" },
        y: { type: "integer" },
        width: { type: "integer" },
        height: { type: "integer" },
      },
      required: ["x", "y", "width", "height"],
    },
  },
  required: ["cropRect", "texts"],
};

const PRODUCTION_RULES = `
알로소(Alloso) 소재 제작 규칙:

[기본 사이즈]
- 모든 소재의 기본 출력 사이즈는 ${OUTPUT_SIZE}x${OUTPUT_SIZE}px (정사각형)

[폰트]
- 국문은 Pretendard, 영문/숫자는 Century Gothic으로 자동 분기되므로 fontWeight만 판단하면 됨(폰트 패밀리는 렌더링 단계에서 문자 단위로 자동 처리)
- 메인 타이틀은 bold, 서브 텍스트는 regular로 판단. 얇은(regular) 텍스트는 시안에서도 가늘고 심플한 인상이어야 함

[텍스트]
- 메인 타이틀 fontSize는 68px 이내 권장(고정값 아님, 시안 비율 보고 판단)
- 서브타이틀 fontSize는 메인 타이틀의 약 60%
- align은 시안에 보이는 정렬(좌/중앙/우)을 그대로 따를 것

[이미지 크롭]
- 시안 이미지는 이미 완성된 레이아웃 레퍼런스이고, 원본 이미지는 크롭되지 않은 고해상도 사진이다
- 원본 이미지에서, 시안과 동일한 구도(제품이 보이는 각도/비율/여백)를 재현하는 정사각형 영역을 cropRect로 산출할 것
- 원본 이미지가 시안보다 훨씬 넓은 화각을 담고 있을 수 있으므로, 시안 속 피사체(소파/의자 등)와 동일한 피사체를 원본에서 찾아 정렬 기준으로 삼을 것

[로고]
- 로고는 별도 PNG 파일을 그대로 사용하므로, logoPlacement에는 로고가 들어갈 위치/크기만 기재한다 (로고 이미지 자체를 만들거나 크롭하지 않음)

[가독성 처리 - backdrop]
- 텍스트가 배경 이미지 위에 있어 가독성이 떨어질 것으로 보이면 backdrop 필드를 채울 것
- 배경 이미지가 어둡거나 복잡한 영역 위의 텍스트: type "gradient" (텍스트 아래쪽에 옅게 깔리는 그라데이션 패널) 또는 "blur" (블러 처리된 패널) 중 시안에 더 가까운 방식으로 판단
- backdrop.color는 반드시 그 텍스트 주변 배경 이미지의 어두운 영역 색상에서 추출한 값을 사용 (임의의 검정색 사용 금지)
- 텍스트가 이미 단색/그라데이션 배경 위에 있어 가독성 문제가 없으면 backdrop 생략

[톤앤무드]
- 깔끔하고 절제된 톤, 텍스트+이미지 위주 구성, 그리드형 정렬 선호, 과한 장식 지양 — 이 톤에서 벗어나는 과도한 크기/색상 판단은 피할 것
`;

function detectMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

async function loadImagePart(filePath) {
  const resolvedPath = resolveActualPath(filePath);
  const buffer = fs.readFileSync(resolvedPath);
  const metadata = await sharp(buffer).metadata();
  return {
    buffer,
    width: metadata.width,
    height: metadata.height,
    mimeType: detectMimeType(resolvedPath),
    base64: buffer.toString("base64"),
  };
}

async function analyze(originalPath, referencePath) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY 환경변수가 설정되어 있지 않습니다.");
  }

  const original = await loadImagePart(originalPath);
  const reference = await loadImagePart(referencePath);

  // @google/genai 0.15.0의 CJS 빌드가 내부적으로 ESM 문법을 포함하는 패키징 버그가 있어
  // require() 대신 동적 import()로 로드한다.
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      `[시안 이미지] 광고주가 준 레이아웃 레퍼런스입니다. 실제 크기는 ${reference.width}x${reference.height}px 입니다.`,
      { inlineData: { mimeType: reference.mimeType, data: reference.base64 } },
      `[원본 이미지] 크롭되지 않은 고해상도 원본 사진입니다. 실제 크기는 ${original.width}x${original.height}px 입니다.`,
      { inlineData: { mimeType: original.mimeType, data: original.base64 } },
      `위 두 이미지를 비교해서 아래 스키마에 맞는 JSON을 추출하세요.
${PRODUCTION_RULES}`,
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: MATERIAL_SPEC_SCHEMA,
      maxOutputTokens: 16384,
      thinkingConfig: { thinkingBudget: 2048 },
    },
  });

  const finishReason = response.candidates && response.candidates[0] && response.candidates[0].finishReason;
  if (finishReason && finishReason !== "STOP") {
    console.error(`경고: 응답이 정상 종료되지 않음 (finishReason: ${finishReason})`);
  }

  let spec;
  try {
    spec = JSON.parse(response.text);
  } catch (parseErr) {
    const debugPath = path.join(__dirname, "debug-raw-response.txt");
    fs.writeFileSync(debugPath, response.text || "(response.text가 비어있음)", "utf-8");
    throw new Error(
      `모델 응답을 JSON으로 파싱하지 못함 (finishReason: ${finishReason}). 원본 응답을 ${debugPath}에 저장했습니다. 원인: ${parseErr.message}`,
    );
  }

  normalizeSpecColors(spec);
  return { spec, original };
}

// 모델이 가끔 0~1 대신 0~255 스케일로 색상을 반환하는 경우를 방어적으로 보정한다.
function normalizeColor(arr) {
  if (!Array.isArray(arr)) return arr;
  const needsScaling = arr.some((v) => v > 1);
  return needsScaling ? arr.map((v) => v / 255) : arr;
}

function normalizeSpecColors(spec) {
  for (const t of spec.texts || []) {
    if (t.color) t.color = normalizeColor(t.color);
    if (t.backdrop && t.backdrop.color) t.backdrop.color = normalizeColor(t.backdrop.color);
  }
}

function clampCropRect(rect, imageWidth, imageHeight) {
  const size = Math.max(1, Math.min(rect.width, rect.height, imageWidth, imageHeight));
  const x = Math.max(0, Math.min(rect.x, imageWidth - size));
  const y = Math.max(0, Math.min(rect.y, imageHeight - size));
  return { x, y, size };
}

async function cropAndResizeOriginal(original, cropRect) {
  const { x, y, size } = clampCropRect(cropRect, original.width, original.height);
  const buffer = await sharp(original.buffer)
    .extract({ left: x, top: y, width: size, height: size })
    .resize(OUTPUT_SIZE, OUTPUT_SIZE, { fit: "cover" })
    .png()
    .toBuffer();
  return buffer.toString("base64");
}

async function buildMaterialSpec(originalPath, referencePath, logoPath, frameName) {
  const { spec, original } = await analyze(originalPath, referencePath);

  const croppedBase64 = await cropAndResizeOriginal(original, spec.cropRect);

  const result = {
    frame: { name: frameName || path.basename(originalPath), width: OUTPUT_SIZE, height: OUTPUT_SIZE },
    mainImage: { x: 0, y: 0, width: OUTPUT_SIZE, height: OUTPUT_SIZE, base64: croppedBase64 },
    texts: spec.texts,
  };

  if (spec.logoPlacement && logoPath) {
    const logoBase64 = fs.readFileSync(resolveActualPath(logoPath)).toString("base64");
    result.logo = { ...spec.logoPlacement, base64: logoBase64 };
  } else if (spec.logoPlacement) {
    result.logo = { ...spec.logoPlacement };
  }

  return result;
}

async function main() {
  let originalPath, referencePath, logoPath, outPathArg;

  // Windows 콘솔에서 한글 경로를 커맨드라인 인자로 넘기면 인코딩이 깨지는 경우가 있어,
  // --args-file <json경로> 로 UTF-8 JSON 파일을 통해 경로를 전달하는 방식도 지원한다.
  if (process.argv[2] === "--args-file") {
    const argsFilePath = process.argv[3];
    const parsed = JSON.parse(fs.readFileSync(argsFilePath, "utf-8"));
    originalPath = parsed.originalPath;
    referencePath = parsed.referencePath;
    logoPath = parsed.logoPath;
    outPathArg = parsed.outPath;
  } else {
    [originalPath, referencePath, logoPath, outPathArg] = process.argv.slice(2);
  }

  if (!originalPath || !referencePath) {
    console.error(
      "사용법: node vision/analyze.js <원본이미지경로> <시안이미지경로> [로고PNG경로] [출력경로]\n" +
        "     또는: node vision/analyze.js --args-file <json경로>",
    );
    process.exitCode = 1;
    return;
  }
  const outPath = outPathArg || path.join(__dirname, "output-spec.json");

  const spec = await buildMaterialSpec(originalPath, referencePath, logoPath);
  fs.writeFileSync(outPath, JSON.stringify(spec, null, 2), "utf-8");
  console.log(`스펙 생성 완료: ${outPath}`);
}

main().catch((err) => {
  console.error("분석 실패:", err.message);
  process.exitCode = 1;
});
```

---

## 3. 셋업 방법

```powershell
# Node.js 설치 필요 (https://nodejs.org, LTS)

cd C:\Users\gram\figma-material-agent
npm install

# 플러그인 TypeScript 빌드 (code.ts → code.js)
npm run build
```

**Figma에 플러그인 로드**: Figma 데스크톱 앱 → 우클릭 → Plugins → Development →
Import plugin from manifest... → `manifest.json` 선택

**API 키 설정 (PowerShell, 영구 저장)**:
```powershell
[System.Environment]::SetEnvironmentVariable("GEMINI_API_KEY", "발급받은키", "User")
```
Gemini API 키는 https://aistudio.google.com/apikey 에서 무료로 발급 가능.

> 주의: 새 터미널을 열어야 반영됨. 기존 터미널에서 바로 쓰려면
> `$env:GEMINI_API_KEY = [System.Environment]::GetEnvironmentVariable("GEMINI_API_KEY", "User")` 로 세션에 불러와야 함.

## 4. 실행 방법

```powershell
node vision/analyze.js <원본이미지경로> <시안이미지경로> [로고PNG경로] [출력경로]
```

예:
```powershell
node vision/analyze.js "C:\경로\원본.jpg" "C:\경로\시안.png" "C:\경로\로고.png"
```

Windows 콘솔에서 한글 경로가 깨지는 경우 `--args-file` 옵션으로 JSON 파일을 통해 경로 전달:
```powershell
node vision/analyze.js --args-file "C:\경로\args.json"
```
```json
{
  "originalPath": "C:\\...\\원본.jpg",
  "referencePath": "C:\\...\\시안.png",
  "logoPath": "C:\\...\\로고.png",
  "outPath": "C:\\...\\output-spec.json"
}
```

실행 결과로 `output-spec.json`이 생성되면, Figma 플러그인 UI에서 **"파일 불러오기"**로 선택하거나
JSON 내용을 통째로 복사해서 텍스트 영역에 붙여넣고 **"Figma에 생성"** 클릭.

> 실제 사진이 포함된 스펙은 base64 이미지 때문에 JSON이 수백 KB~수 MB로 커서, 채팅에 복붙하기보다는
> "파일 불러오기"를 쓰는 게 실용적이다. 텍스트/로고 위치만 있는 작은 테스트 스펙은 아래처럼 복붙 가능.

## 5. 복붙용 샘플 스펙 (이미지 없이 텍스트만 테스트할 때)

```json
{
  "frame": { "name": "Sample Ad Material", "width": 1080, "height": 1080 },
  "background": {
    "type": "gradient",
    "gradientAngle": 45,
    "gradientStops": [
      { "color": [1, 0.42, 0.21, 1], "position": 0 },
      { "color": [0.97, 0.58, 0.12, 1], "position": 1 }
    ]
  },
  "texts": [
    {
      "content": "여름 시즌 특가",
      "x": 80, "y": 700, "width": 600, "height": 100,
      "fontSize": 56, "fontWeight": "bold",
      "color": [1, 1, 1], "align": "LEFT"
    },
    {
      "content": "지금 확인하기",
      "x": 80, "y": 820, "width": 400, "height": 60,
      "fontSize": 28, "fontWeight": "medium",
      "color": [1, 1, 1], "align": "LEFT"
    }
  ],
  "logo": { "x": 900, "y": 60, "width": 120, "height": 60 }
}
```

이 JSON을 플러그인 UI 텍스트 영역에 붙여넣고 "Figma에 생성"을 누르면 그라데이션 배경 + 텍스트 2개 +
로고 placeholder(회색 사각형)가 생성된다.

---

## 6. 알로소(Alloso) 소재 제작 규칙 (원문)

- **폰트**: 국문 Pretendard(메인 Bold/서브 Regular, 자간 -1.5%), 영문·숫자 Century Gothic(메인 Bold/서브 Regular, 자간 -2.5%), 한글/영문 혼용 시 문자 단위로 폰트 자동 분기
- **텍스트**: 메인 타이틀 68px 이내 권장(고정 아님), 서브타이틀 = 메인의 60%, 정렬은 시안에 따라 지정
- **이미지**: 제품이 최우선으로 잘 보이도록 크롭, 로고는 PNG 파일 사용
- **가독성 처리**: 텍스트 뒤에 옅은 그라데이션 또는 블러 쉐도우 패널, 텍스트 아래쪽에만 깔리는 블렌드 그림자, 그림자 색상은 배경 이미지의 어두운 영역에서 추출
- **톤앤무드**: 깔끔하고 절제된 톤, 텍스트+이미지 위주 구성, 그리드형 레이아웃, 과한 장식 지양
- **기본 소재 사이즈**: 1080x1080px

---

## 7. 지금까지 겪은 이슈와 해결 (트러블슈팅 로그)

| 문제 | 원인 | 해결 |
|---|---|---|
| `tsc` 빌드 시 `No inputs were found` | `outDir`/`rootDir`가 프로젝트 루트와 같아서 tsc가 자기 자신을 제외 대상으로 인식 | `outDir`/`rootDir` 옵션 제거, 기본 동작(소스 옆에 결과물 생성) 사용 |
| `atob` 타입 에러 | Figma 플러그인 lib에 DOM 타입이 없음 | `declare function atob(...)` 직접 선언 (런타임엔 Figma 샌드박스가 제공) |
| `@anthropic-ai/sdk` 관련 `console`/`fetch` 재선언 충돌 | `@types/node`가 자동으로 딸려 들어와 Figma 전역 타입과 충돌 | tsconfig에 `"types": []` 명시 |
| `require('@google/genai')`가 빈 객체 반환 | 패키지의 CJS 빌드(`dist/node/index.js`)가 실제로는 ESM 문법을 포함하는 패키징 버그 (v0.15.0) | `require()` 대신 `await import("@google/genai")` 동적 import 사용 |
| Gemini 응답 JSON 파싱 실패 (`Expected ',' or '}'...`) | `maxOutputTokens` 부족으로 응답이 중간에 잘림 (특히 이미지 2장 + thinking 사용 시) | `maxOutputTokens` 상향(16384), `thinkingConfig.thinkingBudget` 명시적으로 설정 |
| 색상 값이 `[255,255,255]`로 나옴 | 모델이 스키마 설명 부족으로 0~255 스케일 반환 | 스키마 description에 "반드시 0~1 실수" 명시 + 후처리로 255 스케일 감지 시 자동 보정 |
| 한글 파일 경로 `ENOENT` | Windows 콘솔에서 커맨드라인 인자로 한글 경로 전달 시 인코딩 깨짐 | `--args-file` 옵션으로 UTF-8 JSON 파일을 통해 경로 전달 |
| 같은 파일인데도 `ENOENT` (경로 문자열은 육안상 동일) | 실제 파일명이 NFD(자모 분리형)로 저장되어 있는데 전달받은 문자열은 NFC(완성형) — 바이트 단위 불일치 | `resolveActualPath()`: 정확히 못 찾으면 디렉터리를 읽어 NFC 기준으로 재매칭 |
| Figma에서 `Cannot write to node with unloaded font "Inter Regular"` | 텍스트 노드 생성 직후 폰트 로드 전에 `fontSize`부터 설정 | 폰트 로드/적용(`applyMixedFontText`)을 `fontSize` 설정보다 먼저 실행하도록 순서 변경 |
| 초기 버전: 원본 대신 배경색+제품크롭으로 재구성해서 결과가 부자연스러움 | 스키마가 "배경색 + 작은 이미지 크롭" 구조를 강제해서 실제 풀블리드 사진 레이아웃과 안 맞음 | 원본 이미지를 크롭 없이 프레임 전체 배경으로 사용하는 구조로 전면 재설계, 로고도 크롭 대신 실제 PNG 파일 그대로 사용 |

---

## 8. 다음 단계 후보

- LIVE 뱃지처럼 시안에서 종종 누락되는 소형 텍스트 요소 인식률 개선 (프롬프트 보강)
- cropRect 정확도 검증 — 저해상도 시안 vs 고해상도 원본 간 구도 매칭 정밀도
- Figma 플러그인과 vision/analyze.js를 직접 연결(현재는 JSON 파일/붙여넣기 수동 전달)해서 원클릭 자동화
- 다양한 소재 사이즈(정사각형 외 세로형/가로형) 지원
- 여러 장의 텍스트 배리에이션을 한 번에 생성하는 배치 처리
